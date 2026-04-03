import type { IndexConfig } from '../types/bucket.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { IndexOpts, IndexResult } from '../types/index-types.js'
import type { RawDocument, Chunk } from '../types/connector.js'
import { randomUUID } from 'crypto'
import { IndexError } from '../types/index-types.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { defaultChunker } from './chunker.js'
import { stripMarkdown } from './strip-markdown.js'
import type { TripleExtractor, EntityContext } from './triple-extractor.js'

/** Race a promise against a timeout. Resolves to undefined on timeout (never rejects). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ])
}

const TRIPLE_EXTRACTION_TIMEOUT_MS = 120_000 // 2 minutes per chunk

export class IndexEngine {
  tripleExtractor?: TripleExtractor

  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider
  ) {}

  /**
   * Ingest a document with pre-built chunks.
   * Skips the default chunker - uses the provided chunks directly.
   */
  async ingestWithChunks(
    bucketId: string,
    doc: RawDocument,
    chunks: Chunk[],
    opts: IndexOpts = {},
    indexConfig?: IndexConfig,
  ): Promise<IndexResult> {
    const { tenantId, groupId, userId, agentId, sessionId, visibility, dryRun = false } = opts

    const modelId = this.embedding.model
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const contentHash = sha256(doc.content)
    const deduplicateBy = indexConfig?.deduplicateBy ?? ['url']
    const ikey = resolveIdempotencyKey(doc, deduplicateBy)

    let documentId = doc.id ?? randomUUID()
    if (this.adapter.upsertDocumentRecord && !dryRun) {
      const docRecord = await this.adapter.upsertDocumentRecord({
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        sessionId,
        title: doc.title,
        url: doc.url,
        contentHash,
        chunkCount: chunks.length,
        status: 'processing',
        visibility: visibility ?? indexConfig?.visibility,
        documentType: indexConfig?.documentType,
        sourceType: indexConfig?.sourceType,
        metadata: doc.metadata,
      })
      documentId = docRecord.id
    }

    try {
      const textsForEmbedding = indexConfig
        ? chunks.map(c => this.preprocessForEmbedding(c.content, indexConfig))
        : chunks.map(c => c.content)
      const embeddings = await this.embedding.embedBatch(textsForEmbedding)

      const propagated = this.propagateMetadata(doc, indexConfig?.propagateMetadata)

      const embeddedChunks = chunks.map((chunk, i) => ({
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        sessionId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      // Extract triples for entity graph — await before hash store write
      if (this.tripleExtractor && !dryRun) {
        await Promise.allSettled(
          chunks.map(chunk =>
            withTimeout(
              this.tripleExtractor!.extractFromChunk(chunk.content, bucketId, chunk.chunkIndex, documentId, { ...propagated, ...chunk.metadata }),
              TRIPLE_EXTRACTION_TIMEOUT_MS,
            )
          )
        )
      }

      if (!dryRun) {
        await this.adapter.upsertDocument(modelId, embeddedChunks)

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

      return {
        bucketId,
        tenantId,
        mode: 'upsert',
        total: 1,
        skipped: 0,
        updated: 0,
        inserted: 1,
        pruned: 0,
        durationMs: Date.now() - startMs,
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
    items: Array<{ doc: RawDocument; chunks: Chunk[] }>,
    opts: IndexOpts = {},
    indexConfig?: IndexConfig,
  ): Promise<IndexResult> {
    const { tenantId, groupId, userId, agentId, sessionId, visibility, dryRun = false } = opts
    const modelId = this.embedding.model
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const deduplicateBy = indexConfig?.deduplicateBy ?? ['url']

    const result: IndexResult = {
      bucketId,
      tenantId,
      mode: 'upsert',
      total: items.length,
      skipped: 0,
      updated: 0,
      inserted: 0,
      pruned: 0,
      durationMs: 0,
    }

    // Phase 1: Prepare all docs and collect all texts for a single embedBatch call
    const prepared: Array<{
      doc: RawDocument
      chunks: Chunk[]
      ikey: string
      contentHash: string
      documentId: string
      textOffset: number
    }> = []
    const allTexts: string[] = []

    for (const { doc, chunks } of items) {
      const contentHash = sha256(doc.content)
      const ikey = resolveIdempotencyKey(doc, deduplicateBy)

      // Hash store dedup: skip docs whose content + model haven't changed
      if (!dryRun) {
        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        const stored = await this.adapter.hashStore.get(storeKey)
        if (stored?.contentHash === contentHash && stored.embeddingModel === modelId) {
          const actualChunks = await this.adapter.countChunks(modelId, {
            bucketId,
            tenantId,
            idempotencyKey: ikey,
          })
          if (actualChunks === stored.chunkCount) {
            result.skipped++
            continue
          }
        }
      }

      let documentId = doc.id ?? randomUUID()

      if (this.adapter.upsertDocumentRecord && !dryRun) {
        const docRecord = await this.adapter.upsertDocumentRecord({
          bucketId,
          tenantId,
          groupId,
          userId,
          agentId,
          sessionId,
          title: doc.title,
          url: doc.url,
          contentHash,
          chunkCount: chunks.length,
          status: 'processing',
          visibility: visibility ?? indexConfig?.visibility,
          documentType: indexConfig?.documentType,
          sourceType: indexConfig?.sourceType,
          metadata: doc.metadata,
        })
        documentId = docRecord.id
      }

      const textOffset = allTexts.length
      const texts = indexConfig
        ? chunks.map(c => this.preprocessForEmbedding(c.content, indexConfig))
        : chunks.map(c => c.content)
      allTexts.push(...texts)

      prepared.push({ doc, chunks, ikey, contentHash, documentId, textOffset })
    }

    // Phase 2: Single embedBatch call for all chunks across all documents
    const allEmbeddings = allTexts.length > 0
      ? await this.embedding.embedBatch(allTexts)
      : []

    // Phase 3: Per-document upsert + hash store (with optional concurrency for triple extraction)
    const { concurrency = 1 } = opts

    const processItem = async (item: typeof prepared[number]) => {
      const { doc, chunks, ikey, contentHash, documentId, textOffset } = item
      const embeddings = allEmbeddings.slice(textOffset, textOffset + chunks.length)
      const propagated = this.propagateMetadata(doc, indexConfig?.propagateMetadata)

      const embeddedChunks = chunks.map((chunk, i) => ({
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        groupId,
        userId,
        agentId,
        sessionId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      // Extract triples for entity graph — await before hash store write
      if (this.tripleExtractor && !dryRun) {
        await Promise.allSettled(
          chunks.map(chunk =>
            withTimeout(
              this.tripleExtractor!.extractFromChunk(chunk.content, bucketId, chunk.chunkIndex, documentId, { ...propagated, ...chunk.metadata }),
              TRIPLE_EXTRACTION_TIMEOUT_MS,
            )
          )
        )
      }

      if (!dryRun) {
        await this.adapter.upsertDocument(modelId, embeddedChunks)

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

      result.inserted++
    }

    if (concurrency <= 1) {
      for (const item of prepared) {
        await processItem(item)
      }
    } else {
      // Concurrent processing with semaphore.
      // processItem is wrapped to never reject — errors are swallowed to prevent
      // unhandled promise rejections from crashing the process when concurrent
      // promises continue running after one fails.
      const safeProcessItem = (item: typeof prepared[number]) =>
        processItem(item).catch(() => { /* logged via triple extraction errors */ })
      const active = new Set<Promise<void>>()
      for (const item of prepared) {
        const p = safeProcessItem(item).then(() => { active.delete(p) })
        active.add(p)
        if (active.size >= concurrency) {
          await Promise.race(active)
        }
      }
      await Promise.all(active)
    }

    result.durationMs = Date.now() - startMs
    return result
  }

  private preprocessForEmbedding(content: string, indexConfig: IndexConfig): string {
    if (indexConfig.preprocessForEmbedding) {
      return indexConfig.preprocessForEmbedding(content)
    }
    if (indexConfig.stripMarkdownForEmbedding) {
      return stripMarkdown(content)
    }
    return content
  }

  private propagateMetadata(
    doc: RawDocument,
    fields?: string[]
  ): Record<string, unknown> {
    if (!fields) {
      return {
        title: doc.title,
        url: doc.url,
        updatedAt: doc.updatedAt,
      }
    }

    const out: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.startsWith('metadata.')) {
        const key = field.slice('metadata.'.length)
        out[key] = doc.metadata[key]
      } else {
        out[field] = (doc as unknown as Record<string, unknown>)[field]
      }
    }
    return out
  }
}
