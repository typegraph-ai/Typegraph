import type { VectorStoreAdapter, HashRecord } from '../types/adapter.js'
import type { Embedder } from '../embedding/provider.js'
import { embedTexts } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { IngestOptions, IndexResult, ExtractionFailure } from '../types/index-types.js'
import type { DocumentInput, Chunk } from '../types/document.js'
import type { AccessScope } from '../types/identity.js'
import { chunkIdFor, generateId } from '../utils/id.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { stripMarkdown } from './strip-markdown.js'
import type { TripleExtractor, EntityContext } from './triple-extractor.js'
import type { typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import type { ExtractionCoreferenceCache, Extractor, ExtractedEntity, ExtractedRelation } from '../types/extractor.js'
import { optionalCompactObject } from '../utils/input.js'
import { ConfigError } from '../types/errors.js'

/** Race a promise against a timeout. Resolves to undefined on timeout (never rejects). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ])
}

const TRIPLE_EXTRACTION_TIMEOUT_MS = 360_000 // 6 minutes per chunk
const ENTITY_CONTEXT_LIMIT = 100

type GraphExtractionRunner = Pick<TripleExtractor, 'extractFromChunk'>

function sanitizeText(value: string): string {
  return sanitizeInvalidSurrogates(value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' '))
}

function sanitizeInvalidSurrogates(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += value.charAt(i) + value.charAt(i + 1)
        i++
      } else {
        out += '\uFFFD'
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD'
    } else {
      out += value[i]
    }
  }
  return out
}

function sanitizeDocument(document: DocumentInput): DocumentInput {
  return {
    ...document,
    url: document.url ?? undefined,
    name: sanitizeText(document.name),
    description: document.description ? sanitizeText(document.description) : undefined,
    content: sanitizeText(document.content),
  }
}

function sanitizeChunk(chunk: Chunk): Chunk {
  return {
    ...chunk,
    content: sanitizeText(chunk.content),
  }
}

function refKey(type: string | undefined, id: string | undefined): string {
  return `${type ?? ''}:${id ?? ''}`
}

function resolveRelationEntity(
  ref: ExtractedRelation['source'],
  entityByRef: Map<string, ExtractedEntity>,
): ExtractedEntity {
  return entityByRef.get(ref.id)
    ?? entityByRef.get(refKey(ref.type, ref.id))
    ?? {
      id: ref.id,
      name: ref.id,
      type: ref.type,
      aliases: [],
    }
}

function cacheEntitiesToContext(entities: ExtractedEntity[]): EntityContext[] {
  return entities
    .filter(entity => entity.name && entity.type)
    .map(entity => ({
      name: entity.name,
      type: entity.type,
      typeCandidates: entity.typeCandidates,
      description: entity.description,
      aliases: entity.aliases,
    }))
}

function contextToCacheEntities(entities: EntityContext[]): ExtractedEntity[] {
  return entities.map(entity => ({
    name: entity.name,
    type: entity.type,
    typeCandidates: entity.typeCandidates,
    description: entity.description,
    aliases: entity.aliases,
  }))
}

class ConfiguredExtractorRunner implements GraphExtractionRunner {
  constructor(
    private extractor: Extractor,
    private graph: KnowledgeGraphBridge,
    private logger?: typegraphLogger,
  ) {}

  async extractFromChunk(
    content: string,
    bucketId: string,
    chunkIndex?: number,
    documentId?: string,
    metadata?: Record<string, unknown>,
    entityContext?: EntityContext[],
    documentName?: string,
    identity?: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      threadId?: string | undefined
    },
    accessScope?: AccessScope,
    chunkId?: string,
  ): Promise<{ entities: EntityContext[] } | undefined> {
    const result = await this.extractor.extract({
      id: chunkId ?? `${documentId ?? bucketId}:${chunkIndex ?? 0}`,
      kind: 'document',
      name: documentName,
      content,
      metadata,
    }, {
      log: {
        debug: (message, data) => this.logger?.debug?.(message, data),
        warn: (message, data) => this.logger?.warn?.(message, data),
        error: (message, data) => this.logger?.error?.(message, data),
      },
    })

    if (this.graph.addEntityMentions && result.entities.length > 0) {
      await this.graph.addEntityMentions(result.entities.map(entity => ({
        name: entity.name,
        type: entity.type,
        typeCandidates: entity.typeCandidates,
        aliases: entity.aliases ?? [],
        description: entity.description,
        content,
        bucketId,
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
        ...(documentId ? { documentId } : {}),
        ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
        ...(identity?.groupId ? { groupId: identity.groupId } : {}),
        ...(identity?.userId ? { userId: identity.userId } : {}),
        ...(identity?.agentId ? { agentId: identity.agentId } : {}),
        ...(identity?.threadId ? { threadId: identity.threadId } : {}),
        ...(accessScope ? { accessScope } : {}),
        ...(metadata ? { metadata } : {}),
      })))
    }

    if (this.graph.addTriple && result.relations.length > 0) {
      const entityByRef = new Map<string, ExtractedEntity>()
      for (const entity of result.entities) {
        entityByRef.set(entity.name, entity)
        if (entity.id) {
          entityByRef.set(entity.id, entity)
          entityByRef.set(refKey(entity.type, entity.id), entity)
        }
      }
      for (const relation of result.relations) {
        const source = resolveRelationEntity(relation.source, entityByRef)
        const target = resolveRelationEntity(relation.target, entityByRef)
        await this.graph.addTriple({
          subject: source.name,
          subjectType: source.type,
          subjectTypeCandidates: source.typeCandidates,
          subjectAliases: source.aliases ?? [],
          subjectDescription: source.description,
          predicate: relation.relation,
          object: target.name,
          objectType: target.type,
          objectTypeCandidates: target.typeCandidates,
          objectAliases: target.aliases ?? [],
          objectDescription: target.description,
          relationshipDescription: relation.description,
          evidenceText: relation.evidenceText,
          confidence: relation.confidence,
          chunkId,
          content,
          bucketId,
          ...(chunkIndex !== undefined ? { chunkIndex } : {}),
          ...(documentId ? { documentId } : {}),
          ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
          ...(identity?.groupId ? { groupId: identity.groupId } : {}),
          ...(identity?.userId ? { userId: identity.userId } : {}),
          ...(identity?.agentId ? { agentId: identity.agentId } : {}),
          ...(identity?.threadId ? { threadId: identity.threadId } : {}),
          ...(accessScope ? { accessScope } : {}),
          ...(metadata ? { metadata } : {}),
        })
      }
    }

    return {
      entities: result.entities.map(entity => ({
        name: entity.name,
        type: entity.type,
        typeCandidates: entity.typeCandidates,
        description: entity.description,
        aliases: entity.aliases,
      })),
    }
  }
}

export class IndexEngine {
  tripleExtractor?: GraphExtractionRunner
  eventSink: typegraphEventSink | undefined
  logger: typegraphLogger | undefined

  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: Embedder,
    eventSink?: typegraphEventSink,
    logger?: typegraphLogger,
    private knowledgeGraph?: KnowledgeGraphBridge,
    private extractionCoreferenceCache?: ExtractionCoreferenceCache,
  ) {
    this.eventSink = eventSink
    this.logger = logger
  }

  useExtractor(extractor: Extractor): void {
    if (!this.knowledgeGraph) {
      throw new ConfigError('Custom extractor requires a configured knowledge graph.')
    }
    this.tripleExtractor = new ConfiguredExtractorRunner(extractor, this.knowledgeGraph, this.logger)
  }

  /**
   * Ingest a document with pre-built chunks.
   * Skips the default chunker - uses the provided chunks directly.
   */
  async ingestWithChunks(
    bucketId: string,
    document: DocumentInput,
    chunks: Chunk[],
    rawOpts?: IngestOptions | null,
  ): Promise<IndexResult> {
    const opts = optionalCompactObject<IngestOptions>(rawOpts, 'IndexEngine.ingestWithChunks') as IngestOptions
    const cleanDocument = sanitizeDocument(document)
    const cleanChunks = chunks.map(sanitizeChunk)
    const { tenantId, groupId, userId, agentId, threadId, dryRun = false } = opts
    if (!tenantId) throw new ConfigError('ingest requires identity.tenantId.')
    const accessScope = opts.accessScope
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction

    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const contentHash = sha256(cleanDocument.content)
    const deduplicateBy = opts.deduplicateBy ?? ['url']
    const ikey = resolveIdempotencyKey(cleanDocument, deduplicateBy)

    let documentId = cleanDocument.id ?? generateId('doc')
    let documentWasCreated = true
    if (this.adapter.upsertDocumentRecord && !dryRun) {
      const documentRecord = await this.adapter.upsertDocumentRecord({
        id: documentId,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        threadId,
        name: cleanDocument.name,
        description: cleanDocument.description,
        url: cleanDocument.url ?? undefined,
        contentHash,
        chunkCount: cleanChunks.length,
        status: 'processing',
        accessScope,
        metadata: cleanDocument.metadata ?? {},
      })
      documentId = documentRecord.id
      documentWasCreated = documentRecord.wasCreated !== false
    }

    try {
      const textsForEmbedding = cleanChunks.map(c => this.preprocessForEmbedding(c.content, opts))
      const embeddings = await embedTexts(this.embedding, textsForEmbedding, 'document')

      const propagated = this.propagateMetadata(cleanDocument, opts.propagateMetadata)

      const embeddedChunks = cleanChunks.map((chunk, i) => ({
        id: chunkIdFor({
          embeddingModel: modelId,
          bucketId,
          idempotencyKey: ikey,
          chunkIndex: chunk.chunkIndex,
        }),
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        threadId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: cleanChunks.length,
        accessScope,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertDocumentChunks(modelId, embeddedChunks)
      }

      let extraction: { succeeded: number; failed: number; failedChunks?: ExtractionFailure[] } | undefined
      if (shouldExtract) {
        const documentName = (propagated.name as string | undefined) ?? cleanDocument.name
        extraction = await this.extractTriplesForChunks(
          bucketId,
          documentId,
          embeddedChunks,
          propagated,
          documentName,
          { tenantId, groupId, userId, agentId, threadId },
          accessScope,
        )
      }

      if (!dryRun) {
        if (extraction && extraction.failed > 0) {
          if (this.adapter.updateDocumentStatus) {
            await this.adapter.updateDocumentStatus(documentId, 'failed')
          }

          return {
            bucketId,
            tenantId,
            mode: 'upsert',
            total: 1,
            skipped: 0,
            updated: 0,
            inserted: 0,
            pruned: 0,
            durationMs: Date.now() - startMs,
            extraction,
          }
        }

        if (this.adapter.updateDocumentStatus) {
          await this.adapter.updateDocumentStatus(documentId, 'complete', cleanChunks.length)
        }

        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        await this.adapter.hashStore.set(storeKey, {
          idempotencyKey: ikey,
          contentHash,
          bucketId,
          tenantId,
          embeddingModel: modelId,
          indexedAt: new Date(),
          chunkCount: cleanChunks.length,
        })
      }

      return {
        bucketId,
        tenantId,
        mode: 'upsert',
        total: 1,
        skipped: 0,
        updated: documentWasCreated ? 0 : 1,
        inserted: documentWasCreated ? 1 : 0,
        pruned: 0,
        durationMs: Date.now() - startMs,
        extraction,
      }
    } catch (error) {
      if (this.adapter.updateDocumentStatus && !dryRun) {
        await this.adapter.updateDocumentStatus(documentId, 'failed')
      }
      throw error
    }
  }

  /**
   * Ingest a batch of documents with pre-built chunks.
   * All chunks across all documents are embedded in a single embedBatch call.
   */
  async ingestBatch(
    bucketId: string,
    items: Array<{ document: DocumentInput; chunks: Chunk[] }>,
    rawOpts?: IngestOptions | null,
  ): Promise<IndexResult> {
    const opts = optionalCompactObject<IngestOptions>(rawOpts, 'IndexEngine.ingestBatch') as IngestOptions
    const cleanItems = items.map(({ document, chunks }) => ({
      document: sanitizeDocument(document),
      chunks: chunks.map(sanitizeChunk),
    }))
    const { tenantId, groupId, userId, agentId, threadId, dryRun = false, traceId, spanId } = opts
    if (!tenantId) throw new ConfigError('ingest requires identity.tenantId.')
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction
    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    this.eventSink?.emit({
      id: crypto.randomUUID(),
      eventType: 'index.start',
      identity: { tenantId, groupId, userId, agentId, threadId },
      payload: { bucketId, documentCount: cleanItems.length },
      traceId,
      spanId,
      timestamp: new Date(),
    })

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const deduplicateBy = opts.deduplicateBy ?? ['url']

    const result: IndexResult = {
      bucketId,
      tenantId,
      mode: 'upsert',
      total: cleanItems.length,
      skipped: 0,
      updated: 0,
      inserted: 0,
      pruned: 0,
      durationMs: 0,
    }
    // Tracks documents whose whole processItem rejected in the concurrent path
    // (upsertDocumentChunks throw, hashStore failure, etc.). Surfaced in index.complete.
    let processingFailed = 0

    // Phase 1: Prepare all documents and collect all texts for a single embedBatch call
    const prepared: Array<{
      document: DocumentInput
      chunks: Chunk[]
      ikey: string
      contentHash: string
      documentId: string
      documentWasCreated: boolean
      accessScope?: AccessScope | undefined
      textOffset: number
    }> = []
    const allTexts: string[] = []

    // Batch hash store lookup: check all idempotency keys in a single query
    const documentMeta = cleanItems.map(({ document }) => ({
      document,
      contentHash: sha256(document.content),
      ikey: resolveIdempotencyKey(document, deduplicateBy),
      storeKey: buildHashStoreKey(tenantId, bucketId, resolveIdempotencyKey(document, deduplicateBy)),
    }))

    let hashMap: Map<string, HashRecord> | undefined
    if (!dryRun) {
      const allStoreKeys = documentMeta.map(m => m.storeKey)
      hashMap = this.adapter.hashStore.getMany
        ? await this.adapter.hashStore.getMany(allStoreKeys)
        : undefined
    }

    for (let i = 0; i < cleanItems.length; i++) {
      const { chunks } = cleanItems[i]!
      const { document, contentHash, ikey, storeKey } = documentMeta[i]!

      // Hash store dedup: skip documents whose content + model haven't changed
      if (!dryRun) {
        const stored = hashMap
          ? hashMap.get(storeKey) ?? null
          : await this.adapter.hashStore.get(storeKey)
        if (stored?.contentHash === contentHash && stored.embeddingModel === modelId) {
          const actualChunks = await this.adapter.countChunks(modelId, {
            bucketId,
            tenantId,
            groupId,
            userId,
            agentId,
            threadId,
            idempotencyKey: ikey,
          })
          if (actualChunks === stored.chunkCount) {
            result.skipped++
            continue
          }
        }
      }

      let documentId = document.id ?? generateId('doc')
      let documentWasCreated = true
      const accessScope = opts.accessScope

      if (this.adapter.upsertDocumentRecord && !dryRun) {
        const documentRecord = await this.adapter.upsertDocumentRecord({
          id: documentId,
          bucketId,
          tenantId,
          groupId,
          userId,
          agentId,
          threadId,
          name: document.name,
          description: document.description,
          url: document.url ?? undefined,
          contentHash,
          chunkCount: chunks.length,
          status: 'processing',
          accessScope,
          metadata: document.metadata ?? {},
        })
        documentId = documentRecord.id
        documentWasCreated = documentRecord.wasCreated !== false
      }

      const textOffset = allTexts.length
      const texts = chunks.map(c => this.preprocessForEmbedding(c.content, opts))
      allTexts.push(...texts)

      prepared.push({ document, chunks, ikey, contentHash, documentId, documentWasCreated, accessScope, textOffset })
    }

    // Phase 2: Single embedBatch call for all chunks across all documents
    const allEmbeddings = allTexts.length > 0
      ? await embedTexts(this.embedding, allTexts, 'document')
      : []

    // Phase 3: Per-document upsert + hash store. Graph writes are serialized
    // until the graph storage layer is race-safe.
    const { concurrency = 1 } = opts
    const effectiveConcurrency = shouldExtract ? 1 : concurrency

    const processItem = async (item: typeof prepared[number]) => {
      const { document, chunks, ikey, contentHash, documentId, documentWasCreated, accessScope, textOffset } = item
      const embeddings = allEmbeddings.slice(textOffset, textOffset + chunks.length)
      const propagated = this.propagateMetadata(document, opts.propagateMetadata)

      const embeddedChunks = chunks.map((chunk, i) => ({
        id: chunkIdFor({
          embeddingModel: modelId,
          bucketId,
          idempotencyKey: ikey,
          chunkIndex: chunk.chunkIndex,
        }),
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        threadId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        accessScope,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertDocumentChunks(modelId, embeddedChunks)
      }

      let extraction: { succeeded: number; failed: number; failedChunks?: ExtractionFailure[] } | undefined
      if (shouldExtract) {
        const documentName = (propagated.name as string | undefined) ?? document.name
        extraction = await this.extractTriplesForChunks(
          bucketId,
          documentId,
          embeddedChunks,
          propagated,
          documentName,
          { tenantId, groupId, userId, agentId, threadId },
          accessScope,
        )

        if (!result.extraction) result.extraction = { succeeded: 0, failed: 0 }
        result.extraction.succeeded += extraction.succeeded
        result.extraction.failed += extraction.failed
        if (extraction.failedChunks && extraction.failedChunks.length > 0) {
          if (!result.extraction.failedChunks) result.extraction.failedChunks = []
          result.extraction.failedChunks.push(...extraction.failedChunks)
          if (result.extraction.failedChunks.length > 100) {
            result.extraction.failedChunks = result.extraction.failedChunks.slice(0, 100)
          }
        }
      }

      if (!dryRun) {
        if (extraction && extraction.failed > 0) {
          processingFailed++
          if (this.adapter.updateDocumentStatus) {
            await this.adapter.updateDocumentStatus(documentId, 'failed')
          }

          this.eventSink?.emit({
            id: crypto.randomUUID(),
            eventType: 'index.document',
            identity: { tenantId, groupId, userId, agentId, threadId },
            targetId: documentId,
            targetType: 'document',
            payload: { bucketId, chunkCount: chunks.length, status: 'failed', extraction },
            traceId,
            spanId,
            timestamp: new Date(),
          })
          return
        }

        if (this.adapter.updateDocumentStatus) {
          await this.adapter.updateDocumentStatus(documentId, 'complete', chunks.length)
        }

        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        await this.adapter.hashStore.set(storeKey, {
          idempotencyKey: ikey,
          contentHash,
          bucketId,
          tenantId,
          embeddingModel: modelId,
          indexedAt: new Date(),
          chunkCount: chunks.length,
        })
      }

      if (documentWasCreated) result.inserted++
      else result.updated++

      this.eventSink?.emit({
        id: crypto.randomUUID(),
        eventType: 'index.document',
        identity: { tenantId, groupId, userId, agentId, threadId },
        targetId: documentId,
        targetType: 'document',
        payload: { bucketId, chunkCount: chunks.length, status: documentWasCreated ? 'new' : 'updated' },
        traceId,
        spanId,
        timestamp: new Date(),
      })
    }

    if (effectiveConcurrency <= 1) {
      for (const item of prepared) {
        await processItem(item)
      }
    } else {
      // Concurrent processing with semaphore.
      // processItem is wrapped to never reject — errors are swallowed to prevent
      // unhandled promise rejections from crashing the process when concurrent
      // promises continue running after one fails.
      const safeProcessItem = (item: typeof prepared[number]) =>
        processItem(item).catch((err) => {
          processingFailed++
          this.logger?.error?.('[typegraph] Document processing failed:', { documentId: item.documentId, idempotencyKey: item.ikey, error: err instanceof Error ? err.message : String(err) })
          this.eventSink?.emit({
            id: crypto.randomUUID(),
            eventType: 'index.document',
            identity: { tenantId, groupId, userId, agentId, threadId },
            targetId: item.documentId,
            targetType: 'document',
            payload: { bucketId, status: 'failed', error: err instanceof Error ? err.message : String(err) },
            traceId,
            spanId,
            timestamp: new Date(),
          })
        })
      const active = new Set<Promise<void>>()
      for (const item of prepared) {
        const p = safeProcessItem(item).then(() => { active.delete(p) })
        active.add(p)
        if (active.size >= effectiveConcurrency) {
          await Promise.race(active)
        }
      }
      await Promise.all(active)
    }

    result.durationMs = Date.now() - startMs

    this.eventSink?.emit({
      id: crypto.randomUUID(),
      eventType: 'index.complete',
      identity: { tenantId, groupId, userId, agentId, threadId },
      payload: {
        bucketId,
        documentsProcessed: result.inserted + result.updated,
        documentsSkipped: result.skipped,
        documentsFailed: processingFailed,
        ...(result.extraction ? { extraction: result.extraction } : {}),
      },
      durationMs: result.durationMs,
      traceId,
      spanId,
      timestamp: new Date(),
    })

    // Ensure index events (including this index.complete) are durably written
    // before the ingest call resolves. Short-lived workers (e.g. Inngest steps)
    // otherwise recycle before the buffered flush fires.
    if (this.eventSink?.flush) {
      try {
        await this.eventSink.flush()
      } catch (err) {
        // Flush failures are logged inside the sink; don't fail the ingest.
        console.error('[typegraph] Post-ingest event flush failed:', err instanceof Error ? err.message : err)
      }
    }

    return result
  }

  private async extractTriplesForChunks(
    bucketId: string,
    documentId: string,
    chunks: Array<Pick<Chunk, 'content' | 'chunkIndex' | 'metadata'> & { id?: string | undefined }>,
    propagated: Record<string, unknown>,
    documentName?: string,
    identity?: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      threadId?: string | undefined
    },
    accessScope?: AccessScope,
    initialEntityContext: EntityContext[] = [],
  ): Promise<{ succeeded: number; failed: number; failedChunks?: ExtractionFailure[] }> {
    let entityContext: EntityContext[] = [...initialEntityContext]
    const cacheKey = {
      tenantId: identity?.tenantId,
      groupId: identity?.groupId,
      userId: identity?.userId,
      agentId: identity?.agentId,
      threadId: identity?.threadId,
      bucketId,
      documentId,
      documentName,
      metadata: propagated,
    }
    if (this.extractionCoreferenceCache) {
      try {
        const cachedEntities = await this.extractionCoreferenceCache.load(cacheKey)
        for (const cached of cacheEntitiesToContext(cachedEntities)) {
          if (entityContext.length >= ENTITY_CONTEXT_LIMIT) break
          if (!entityContext.some(ec => ec.name.toLowerCase() === cached.name.toLowerCase())) {
            entityContext.push(cached)
          }
        }
      } catch (err) {
        this.logger?.warn?.('[typegraph] Coreference cache load failed', {
          bucketId,
          documentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    let succeeded = 0
    let failed = 0
    const failedChunks: ExtractionFailure[] = []

    for (const chunk of chunks) {
      try {
        const contextForChunk = entityContext.length > 0
          ? entityContext.map(e => ({ ...e }))
          : undefined

        const extractionResult = await withTimeout(
          this.tripleExtractor!.extractFromChunk(
            chunk.content,
            bucketId,
            chunk.chunkIndex,
            documentId,
            { ...propagated, ...chunk.metadata },
            contextForChunk,
            documentName,
            identity,
            accessScope,
            chunk.id,
          ),
          TRIPLE_EXTRACTION_TIMEOUT_MS,
        )

        if (extractionResult === undefined) {
          failed++
          failedChunks.push({ documentId, chunkIndex: chunk.chunkIndex, reason: 'timeout' })
          this.logger?.warn?.('[typegraph] Triple extraction timed out', { documentId, chunkIndex: chunk.chunkIndex, bucketId })
          continue
        }

        succeeded++
        for (const e of extractionResult.entities) {
          if (entityContext.length >= ENTITY_CONTEXT_LIMIT) break
          if (!entityContext.some(ec => ec.name.toLowerCase() === e.name.toLowerCase())) {
            entityContext.push(e)
          }
        }
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        failedChunks.push({ documentId, chunkIndex: chunk.chunkIndex, reason: 'error', message: msg })
        this.logger?.error?.('[typegraph] Triple extraction failed', { documentId, chunkIndex: chunk.chunkIndex, bucketId, error: msg })
      }
    }

    if (this.extractionCoreferenceCache && entityContext.length > 0) {
      try {
        await this.extractionCoreferenceCache.save(cacheKey, contextToCacheEntities(entityContext))
      } catch (err) {
        this.logger?.warn?.('[typegraph] Coreference cache save failed', {
          bucketId,
          documentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return failedChunks.length > 0
      ? { succeeded, failed, failedChunks }
      : { succeeded, failed }
  }

  private preprocessForEmbedding(content: string, opts: IngestOptions): string {
    if (opts.preprocessForEmbedding) {
      return opts.preprocessForEmbedding(content)
    }
    if (opts.stripMarkdownForEmbedding) {
      return stripMarkdown(content)
    }
    return content
  }

  private propagateMetadata(
    document: DocumentInput,
    fields?: string[]
  ): Record<string, unknown> {
    if (!fields) {
      return {
        name: document.name,
        description: document.description,
        url: document.url,
        updatedAt: document.updatedAt,
      }
    }

    const out: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.startsWith('metadata.')) {
        const key = field.slice('metadata.'.length)
        out[key] = document.metadata?.[key]
      } else {
        out[field] = (document as unknown as Record<string, unknown>)[field]
      }
    }
    return out
  }
}
