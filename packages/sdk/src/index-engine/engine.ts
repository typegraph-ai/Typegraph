import type { VectorStoreAdapter, HashRecord } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import { embeddingModelKey } from '../embedding/provider.js'
import type { IngestOptions, IndexResult, ExtractionFailure } from '../types/index-types.js'
import type { SourceInput, Chunk } from '../types/connector.js'
import { chunkIdFor, generateId } from '../utils/id.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { stripMarkdown } from './strip-markdown.js'
import type { TripleExtractor, EntityContext } from './triple-extractor.js'
import type { typegraphEventSink } from '../types/events.js'
import type { typegraphLogger } from '../types/logger.js'
import type { KnowledgeGraphBridge } from '../types/graph-bridge.js'
import { optionalCompactObject } from '../utils/input.js'

/** Race a promise against a timeout. Resolves to undefined on timeout (never rejects). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ])
}

const TRIPLE_EXTRACTION_TIMEOUT_MS = 360_000 // 6 minutes per chunk
const ENTITY_CONTEXT_LIMIT = 100

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

function sanitizeSource(source: SourceInput): SourceInput {
  return {
    ...source,
    url: source.url ?? undefined,
    title: sanitizeText(source.title),
    content: sanitizeText(source.content),
  }
}

function sanitizeChunk(chunk: Chunk): Chunk {
  return {
    ...chunk,
    content: sanitizeText(chunk.content),
  }
}

export class IndexEngine {
  tripleExtractor?: TripleExtractor
  eventSink: typegraphEventSink | undefined
  logger: typegraphLogger | undefined

  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider,
    eventSink?: typegraphEventSink,
    logger?: typegraphLogger,
    private knowledgeGraph?: KnowledgeGraphBridge,
  ) {
    this.eventSink = eventSink
    this.logger = logger
  }

  /**
   * Ingest a source with pre-built chunks.
   * Skips the default chunker - uses the provided chunks directly.
   */
  async ingestWithChunks(
    bucketId: string,
    source: SourceInput,
    chunks: Chunk[],
    rawOpts?: IngestOptions | null,
  ): Promise<IndexResult> {
    const opts = optionalCompactObject<IngestOptions>(rawOpts, 'IndexEngine.ingestWithChunks') as IngestOptions
    const cleanSource = sanitizeSource(source)
    const cleanChunks = chunks.map(sanitizeChunk)
    const { tenantId, groupId, userId, agentId, conversationId, visibility, dryRun = false } = opts
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction

    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const contentHash = sha256(cleanSource.content)
    const deduplicateBy = opts.deduplicateBy ?? ['url']
    const ikey = resolveIdempotencyKey(cleanSource, deduplicateBy)

    let sourceId = cleanSource.id ?? generateId('src')
    let sourceWasCreated = true
    if (this.adapter.upsertSourceRecord && !dryRun) {
      const sourceRecord = await this.adapter.upsertSourceRecord({
        id: sourceId,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        conversationId,
        title: cleanSource.title,
        url: cleanSource.url ?? undefined,
        contentHash,
        chunkCount: cleanChunks.length,
        status: 'processing',
        visibility,
        graphExtracted: shouldExtract,
        metadata: cleanSource.metadata ?? {},
        subject: cleanSource.subject,
      })
      sourceId = sourceRecord.id
      sourceWasCreated = sourceRecord.wasCreated !== false
    }

    try {
      const textsForEmbedding = cleanChunks.map(c => this.preprocessForEmbedding(c.content, opts))
      const embeddings = await this.embedding.embedBatch(textsForEmbedding)

      const propagated = this.propagateMetadata(cleanSource, opts.propagateMetadata)

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
        conversationId,
        sourceId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: cleanChunks.length,
        visibility,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertSourceChunks(modelId, embeddedChunks)
      }

      const initialEntityContext = !dryRun
        ? await this.materializeSourceSubject(
            cleanSource,
            bucketId,
            sourceId,
            modelId,
            embeddedChunks,
            { tenantId, groupId, userId, agentId, conversationId },
            visibility,
          )
        : []

      let extraction: { succeeded: number; failed: number; failedChunks?: ExtractionFailure[] } | undefined
      if (shouldExtract) {
        const sourceTitle = (propagated.title as string | undefined) ?? undefined
        extraction = await this.extractTriplesForChunks(
          bucketId,
          sourceId,
          embeddedChunks,
          propagated,
          sourceTitle,
          { tenantId, groupId, userId, agentId, conversationId },
          visibility,
          initialEntityContext,
        )
      }

      if (!dryRun) {
        if (extraction && extraction.failed > 0) {
          if (this.adapter.updateSourceStatus) {
            await this.adapter.updateSourceStatus(sourceId, 'failed')
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

        if (this.adapter.updateSourceStatus) {
          await this.adapter.updateSourceStatus(sourceId, 'complete', cleanChunks.length)
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
        updated: sourceWasCreated ? 0 : 1,
        inserted: sourceWasCreated ? 1 : 0,
        pruned: 0,
        durationMs: Date.now() - startMs,
        extraction,
      }
    } catch (error) {
      if (this.adapter.updateSourceStatus && !dryRun) {
        await this.adapter.updateSourceStatus(sourceId, 'failed')
      }
      throw error
    }
  }

  /**
   * Ingest a batch of sources with pre-built chunks.
   * All chunks across all sources are embedded in a single embedBatch call.
   */
  async ingestBatch(
    bucketId: string,
    items: Array<{ source: SourceInput; chunks: Chunk[] }>,
    rawOpts?: IngestOptions | null,
  ): Promise<IndexResult> {
    const opts = optionalCompactObject<IngestOptions>(rawOpts, 'IndexEngine.ingestBatch') as IngestOptions
    const cleanItems = items.map(({ source, chunks }) => ({
      source: sanitizeSource(source),
      chunks: chunks.map(sanitizeChunk),
    }))
    const { tenantId, groupId, userId, agentId, conversationId, visibility, dryRun = false, traceId, spanId } = opts
    const shouldExtract = !!this.tripleExtractor && !dryRun && !!opts.graphExtraction
    const modelId = embeddingModelKey(this.embedding)
    const startMs = Date.now()

    this.eventSink?.emit({
      id: crypto.randomUUID(),
      eventType: 'index.start',
      identity: { tenantId, groupId, userId, agentId, conversationId },
      payload: { bucketId, sourceCount: cleanItems.length },
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
    // Tracks sources whose whole processItem rejected in the concurrent path
    // (upsertSourceChunks throw, hashStore failure, etc.). Surfaced in index.complete.
    let processingFailed = 0

    // Phase 1: Prepare all sources and collect all texts for a single embedBatch call
    const prepared: Array<{
      source: SourceInput
      chunks: Chunk[]
      ikey: string
      contentHash: string
      sourceId: string
      sourceWasCreated: boolean
      textOffset: number
    }> = []
    const allTexts: string[] = []

    // Batch hash store lookup: check all idempotency keys in a single query
    const sourceMeta = cleanItems.map(({ source }) => ({
      source,
      contentHash: sha256(source.content),
      ikey: resolveIdempotencyKey(source, deduplicateBy),
      storeKey: buildHashStoreKey(tenantId, bucketId, resolveIdempotencyKey(source, deduplicateBy)),
    }))

    let hashMap: Map<string, HashRecord> | undefined
    if (!dryRun) {
      const allStoreKeys = sourceMeta.map(m => m.storeKey)
      hashMap = this.adapter.hashStore.getMany
        ? await this.adapter.hashStore.getMany(allStoreKeys)
        : undefined
    }

    for (let i = 0; i < cleanItems.length; i++) {
      const { chunks } = cleanItems[i]!
      const { source, contentHash, ikey, storeKey } = sourceMeta[i]!

      // Hash store dedup: skip sources whose content + model haven't changed
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
            conversationId,
            idempotencyKey: ikey,
          })
          if (actualChunks === stored.chunkCount) {
            result.skipped++
            continue
          }
        }
      }

      let sourceId = source.id ?? generateId('src')
      let sourceWasCreated = true

      if (this.adapter.upsertSourceRecord && !dryRun) {
        const sourceRecord = await this.adapter.upsertSourceRecord({
          id: sourceId,
          bucketId,
          tenantId,
          groupId,
          userId,
          agentId,
          conversationId,
          title: source.title,
          url: source.url ?? undefined,
          contentHash,
          chunkCount: chunks.length,
          status: 'processing',
          visibility,
        graphExtracted: shouldExtract,
        metadata: source.metadata ?? {},
        subject: source.subject,
      })
        sourceId = sourceRecord.id
        sourceWasCreated = sourceRecord.wasCreated !== false
      }

      const textOffset = allTexts.length
      const texts = chunks.map(c => this.preprocessForEmbedding(c.content, opts))
      allTexts.push(...texts)

      prepared.push({ source, chunks, ikey, contentHash, sourceId, sourceWasCreated, textOffset })
    }

    // Phase 2: Single embedBatch call for all chunks across all sources
    const allEmbeddings = allTexts.length > 0
      ? await this.embedding.embedBatch(allTexts)
      : []

    // Phase 3: Per-source upsert + hash store. Graph writes are serialized
    // until the graph storage layer is race-safe.
    const { concurrency = 1 } = opts
    const effectiveConcurrency = shouldExtract ? 1 : concurrency

    const processItem = async (item: typeof prepared[number]) => {
      const { source, chunks, ikey, contentHash, sourceId, sourceWasCreated, textOffset } = item
      const embeddings = allEmbeddings.slice(textOffset, textOffset + chunks.length)
      const propagated = this.propagateMetadata(source, opts.propagateMetadata)

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
        conversationId,
        sourceId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        visibility,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (!dryRun) {
        await this.adapter.upsertSourceChunks(modelId, embeddedChunks)
      }

      const initialEntityContext = !dryRun
        ? await this.materializeSourceSubject(
            source,
            bucketId,
            sourceId,
            modelId,
            embeddedChunks,
            { tenantId, groupId, userId, agentId, conversationId },
            visibility,
          )
        : []

      let extraction: { succeeded: number; failed: number; failedChunks?: ExtractionFailure[] } | undefined
      if (shouldExtract) {
        const sourceTitle = (propagated.title as string | undefined) ?? undefined
        extraction = await this.extractTriplesForChunks(
          bucketId,
          sourceId,
          embeddedChunks,
          propagated,
          sourceTitle,
          { tenantId, groupId, userId, agentId, conversationId },
          visibility,
          initialEntityContext,
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
          if (this.adapter.updateSourceStatus) {
            await this.adapter.updateSourceStatus(sourceId, 'failed')
          }

          this.eventSink?.emit({
            id: crypto.randomUUID(),
            eventType: 'index.source',
            identity: { tenantId, groupId, userId, agentId, conversationId },
            targetId: sourceId,
            targetType: 'source',
            payload: { bucketId, chunkCount: chunks.length, status: 'failed', extraction },
            traceId,
            spanId,
            timestamp: new Date(),
          })
          return
        }

        if (this.adapter.updateSourceStatus) {
          await this.adapter.updateSourceStatus(sourceId, 'complete', chunks.length)
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

      if (sourceWasCreated) result.inserted++
      else result.updated++

      this.eventSink?.emit({
        id: crypto.randomUUID(),
        eventType: 'index.source',
        identity: { tenantId, groupId, userId, agentId, conversationId },
        targetId: sourceId,
        targetType: 'source',
        payload: { bucketId, chunkCount: chunks.length, status: sourceWasCreated ? 'new' : 'updated' },
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
          this.logger?.error?.('[typegraph] Source processing failed:', { sourceId: item.sourceId, idempotencyKey: item.ikey, error: err instanceof Error ? err.message : String(err) })
          this.eventSink?.emit({
            id: crypto.randomUUID(),
            eventType: 'index.source',
            identity: { tenantId, groupId, userId, agentId, conversationId },
            targetId: item.sourceId,
            targetType: 'source',
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
      identity: { tenantId, groupId, userId, agentId, conversationId },
      payload: {
        bucketId,
        sourcesProcessed: result.inserted + result.updated,
        sourcesSkipped: result.skipped,
        sourcesFailed: processingFailed,
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
    sourceId: string,
    chunks: Array<Pick<Chunk, 'content' | 'chunkIndex' | 'metadata'> & { id?: string | undefined }>,
    propagated: Record<string, unknown>,
    sourceTitle?: string,
    identity?: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      conversationId?: string | undefined
    },
    visibility?: IngestOptions['visibility'],
    initialEntityContext: EntityContext[] = [],
  ): Promise<{ succeeded: number; failed: number; failedChunks?: ExtractionFailure[] }> {
    let entityContext: EntityContext[] = [...initialEntityContext]
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
            sourceId,
            { ...propagated, ...chunk.metadata },
            contextForChunk,
            sourceTitle,
            identity,
            visibility,
            chunk.id,
          ),
          TRIPLE_EXTRACTION_TIMEOUT_MS,
        )

        if (extractionResult === undefined) {
          failed++
          failedChunks.push({ sourceId, chunkIndex: chunk.chunkIndex, reason: 'timeout' })
          this.logger?.warn?.('[typegraph] Triple extraction timed out', { sourceId, chunkIndex: chunk.chunkIndex, bucketId })
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
        failedChunks.push({ sourceId, chunkIndex: chunk.chunkIndex, reason: 'error', message: msg })
        this.logger?.error?.('[typegraph] Triple extraction failed', { sourceId, chunkIndex: chunk.chunkIndex, bucketId, error: msg })
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
    source: SourceInput,
    fields?: string[]
  ): Record<string, unknown> {
    if (!fields) {
      return {
        title: source.title,
        url: source.url,
        updatedAt: source.updatedAt,
        ...(source.subject ? { subject: source.subject } : {}),
      }
    }

    const out: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.startsWith('metadata.')) {
        const key = field.slice('metadata.'.length)
        out[key] = source.metadata?.[key]
      } else {
        out[field] = (source as unknown as Record<string, unknown>)[field]
      }
    }
    return out
  }

  private async materializeSourceSubject(
    source: SourceInput,
    bucketId: string,
    sourceId: string,
    embeddingModel: string,
    chunks: Array<Pick<Chunk, 'content' | 'chunkIndex' | 'metadata'> & { id?: string | undefined }>,
    identity: {
      tenantId?: string | undefined
      groupId?: string | undefined
      userId?: string | undefined
      agentId?: string | undefined
      conversationId?: string | undefined
    },
    visibility?: IngestOptions['visibility'],
  ): Promise<EntityContext[]> {
    if (!source.subject) return []
    if (!this.knowledgeGraph) return []
    if (!this.knowledgeGraph.addSourceSubject) {
      throw new Error('KnowledgeGraphBridge must implement addSourceSubject() to ingest source.subject.')
    }

    const entity = await this.knowledgeGraph.addSourceSubject({
      subject: source.subject,
      bucketId,
      sourceId,
      embeddingModel,
      chunks,
      ...identity,
      visibility,
    })
    const name = entity?.name ?? source.subject.name
    const type = entity?.entityType ?? source.subject.entityType
    return name
      ? [{ name, type: type ?? 'concept' }]
      : []
  }
}
