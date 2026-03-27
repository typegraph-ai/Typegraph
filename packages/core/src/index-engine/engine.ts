import type { IndexConfig } from '../types/bucket.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { IndexOpts, IndexResult } from '../types/index-types.js'
import type { RawDocument, Chunk, Connector } from '../types/connector.js'
import { randomUUID } from 'crypto'
import { IndexError } from '../types/index-types.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { defaultChunker } from './chunker.js'
import { stripMarkdown } from './strip-markdown.js'
import type { TripleExtractor } from './triple-extractor.js'

export class IndexEngine {
  tripleExtractor?: TripleExtractor

  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider
  ) {}

  /**
   * Index documents from a connector into a source.
   * This is the primary method for ingestion jobs.
   */
  async indexWithConnector(
    bucketId: string,
    connector: Connector,
    indexConfig: IndexConfig,
    opts: IndexOpts = {},
  ): Promise<IndexResult> {
    const {
      mode = 'upsert',
      tenantId,
      removeDeleted = false,
      dryRun = false,
      onProgress,
    } = opts

    if (!connector.fetch) throw new Error(`Connector for bucket "${bucketId}" has no fetch()`)

    const modelId = this.embedding.model

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const startMs = Date.now()
    const result: IndexResult = {
      bucketId,
      tenantId,
      mode,
      total: 0,
      skipped: 0,
      updated: 0,
      inserted: 0,
      pruned: 0,
      durationMs: 0,
    }

    if (mode === 'replace' && !dryRun) {
      await this.adapter.delete(modelId, { bucketId, tenantId })
      await this.adapter.hashStore.deleteByBucket(bucketId, tenantId)
    }

    const lastRunTime = mode === 'upsert'
      ? await this.adapter.hashStore.getLastRunTime(bucketId, tenantId)
      : null

    const supportsIncremental = typeof connector.fetchSince === 'function'
    const docs: AsyncIterable<RawDocument> =
      (supportsIncremental && lastRunTime && mode === 'upsert')
        ? connector.fetchSince!(lastRunTime)
        : connector.fetch!()

    const seenKeys = new Set<string>()

    try {
      for await (const doc of docs) {
        result.total++
        const ikey = resolveIdempotencyKey(doc, indexConfig.deduplicateBy)
        const contentHash = sha256(doc.content)
        const storeKey = buildHashStoreKey(tenantId, bucketId, ikey)
        seenKeys.add(ikey)

        onProgress?.({
          ...result,
          phase: 'hash_check',
          done: result.skipped + result.updated + result.inserted,
          failed: 0,
          current: { idempotencyKey: ikey, reason: 'skipped' },
        })

        const stored = await this.adapter.hashStore.get(storeKey)

        if (stored?.contentHash === contentHash && stored.embeddingModel === modelId) {
          const actualChunks = await this.adapter.countChunks(modelId, {
            bucketId,
            tenantId,
            idempotencyKey: ikey,
          })
          if (actualChunks === stored.chunkCount) {
            result.skipped++
            onProgress?.({
              ...result,
              phase: 'hash_check',
              done: result.skipped + result.updated + result.inserted,
              failed: 0,
              current: { idempotencyKey: ikey, reason: 'skipped' },
            })
            continue
          }
        }

        if (stored && stored.embeddingModel !== modelId) {
          await this.adapter.delete(stored.embeddingModel, {
            bucketId,
            tenantId,
            idempotencyKey: ikey,
          })
        }

        let documentId = doc.id ?? randomUUID()
        if (this.adapter.upsertDocumentRecord && !dryRun) {
          const docRecord = await this.adapter.upsertDocumentRecord({
            bucketId,
            tenantId,
            title: doc.title,
            url: doc.url,
            contentHash,
            chunkCount: 0,
            status: 'processing',
            documentType: indexConfig.documentType,
            sourceType: indexConfig.sourceType,
            scope: indexConfig.scope,
            metadata: doc.metadata,
          })
          documentId = docRecord.id
        }

        const chunks = connector.chunk
          ? connector.chunk(doc, indexConfig)
          : defaultChunker(doc, indexConfig)

        onProgress?.({
          ...result,
          phase: 'embed',
          done: result.skipped + result.updated + result.inserted,
          failed: 0,
          current: { idempotencyKey: ikey, reason: stored ? 'hash_changed' : 'new' },
        })

        const textsForEmbedding = chunks.map(c => this.preprocessForEmbedding(c.content, indexConfig))
        const embeddings = await this.embedding.embedBatch(textsForEmbedding)

        const propagated = this.propagateMetadata(doc, indexConfig.propagateMetadata)

        const embeddedChunks = chunks.map((chunk, i) => ({
          idempotencyKey: ikey,
          bucketId,
          tenantId,
          documentId,
          content: chunk.content,
          embedding: embeddings[i]!,
          embeddingModel: modelId,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunks.length,
          metadata: { ...propagated, ...chunk.metadata },
          indexedAt: new Date(),
        }))

        // Extract triples for entity graph (non-blocking)
        if (this.tripleExtractor && !dryRun) {
          for (const chunk of chunks) {
            this.tripleExtractor.extractFromChunk(chunk.content, bucketId, chunk.chunkIndex).catch(() => {})
          }
        }

        if (!dryRun) {
          onProgress?.({
            ...result,
            phase: 'store',
            done: result.skipped + result.updated + result.inserted,
            failed: 0,
            current: { idempotencyKey: ikey, reason: stored ? 'hash_changed' : 'new' },
          })
          await this.adapter.upsertDocument(modelId, embeddedChunks)

          if (this.adapter.updateDocumentStatus) {
            await this.adapter.updateDocumentStatus(documentId, 'complete', chunks.length)
          }

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

        stored ? result.updated++ : result.inserted++
      }
    } catch (error) {
      result.durationMs = Date.now() - startMs
      throw new IndexError(
        `Index failed for bucket "${bucketId}"`,
        result,
        error as Error
      )
    }

    if (removeDeleted && mode === 'upsert' && !dryRun) {
      const storedRecords = await this.adapter.hashStore.listByBucket(bucketId, tenantId)
      const deletedKeys = storedRecords
        .map(r => r.idempotencyKey)
        .filter(k => !seenKeys.has(k))

      for (const key of deletedKeys) {
        onProgress?.({
          ...result,
          phase: 'prune',
          done: result.skipped + result.updated + result.inserted,
          failed: 0,
        })
        const record = storedRecords.find(r => r.idempotencyKey === key)
        const deleteModel = record?.embeddingModel ?? modelId
        await this.adapter.delete(deleteModel, { bucketId, tenantId, idempotencyKey: key })
        await this.adapter.hashStore.delete(buildHashStoreKey(tenantId, bucketId, key))
        result.pruned++
      }
    }

    if (!dryRun) {
      await this.adapter.hashStore.setLastRunTime(bucketId, tenantId, new Date())
    }

    result.durationMs = Date.now() - startMs
    return result
  }

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
    const { tenantId, dryRun = false } = opts

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
        title: doc.title,
        url: doc.url,
        contentHash,
        chunkCount: chunks.length,
        status: 'processing',
        documentType: indexConfig?.documentType,
        sourceType: indexConfig?.sourceType,
        scope: indexConfig?.scope,
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
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      // Extract triples for entity graph (non-blocking)
      if (this.tripleExtractor && !dryRun) {
        for (const chunk of chunks) {
          this.tripleExtractor.extractFromChunk(chunk.content, bucketId, chunk.chunkIndex).catch(() => {})
        }
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
    const { tenantId, dryRun = false } = opts
    const modelId = this.embedding.model
    const startMs = Date.now()

    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const deduplicateBy = indexConfig?.deduplicateBy ?? ['url']

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
      let documentId = doc.id ?? randomUUID()

      if (this.adapter.upsertDocumentRecord && !dryRun) {
        const docRecord = await this.adapter.upsertDocumentRecord({
          bucketId,
          tenantId,
          title: doc.title,
          url: doc.url,
          contentHash,
          chunkCount: chunks.length,
          status: 'processing',
          documentType: indexConfig?.documentType,
          sourceType: indexConfig?.sourceType,
          scope: indexConfig?.scope,
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

    // Phase 3: Per-document upsert + hash store
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

    for (const item of prepared) {
      const { doc, chunks, ikey, contentHash, documentId, textOffset } = item
      const embeddings = allEmbeddings.slice(textOffset, textOffset + chunks.length)
      const propagated = this.propagateMetadata(doc, indexConfig?.propagateMetadata)

      const embeddedChunks = chunks.map((chunk, i) => ({
        idempotencyKey: ikey,
        bucketId,
        tenantId,
        documentId,
        content: chunk.content,
        embedding: embeddings[i]!,
        embeddingModel: modelId,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunks.length,
        metadata: { ...propagated, ...chunk.metadata },
        indexedAt: new Date(),
      }))

      if (this.tripleExtractor && !dryRun) {
        for (const chunk of chunks) {
          this.tripleExtractor.extractFromChunk(chunk.content, bucketId, chunk.chunkIndex).catch(() => {})
        }
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
