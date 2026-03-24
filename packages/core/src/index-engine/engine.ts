import type { d8umSource } from '../types/source.js'
import type { VectorStoreAdapter } from '../types/adapter.js'
import type { EmbeddingProvider } from '../embedding/provider.js'
import type { IndexOpts, IndexResult } from '../types/index-types.js'
import type { RawDocument } from '../types/connector.js'
import { IndexError } from '../types/index-types.js'
import { sha256, resolveIdempotencyKey, buildHashStoreKey } from './hash.js'
import { defaultChunker } from './chunker.js'

export class IndexEngine {
  constructor(
    private adapter: VectorStoreAdapter,
    private embedding: EmbeddingProvider
  ) {}

  async indexSource(source: d8umSource, opts: IndexOpts = {}): Promise<IndexResult> {
    const {
      mode = 'upsert',
      tenantId,
      pruneDeleted = false,
      dryRun = false,
      onProgress,
    } = opts

    if (!source.index) throw new Error(`Source "${source.id}" has no index config`)
    if (!source.connector.fetch) throw new Error(`Source "${source.id}" connector has no fetch()`)

    const modelId = this.embedding.model

    // Ensure the adapter has storage for this model's dimensions
    if (!dryRun) {
      await this.adapter.ensureModel(modelId, this.embedding.dimensions)
    }

    const startMs = Date.now()
    const result: IndexResult = {
      sourceId: source.id,
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
      await this.adapter.delete(modelId, { sourceId: source.id, tenantId })
      await this.adapter.hashStore.deleteBySource(source.id, tenantId)
    }

    const lastRunTime = mode === 'upsert'
      ? await this.adapter.hashStore.getLastRunTime(source.id, tenantId)
      : null

    const supportsIncremental = typeof source.connector.fetchSince === 'function'
    const docs: AsyncIterable<RawDocument> =
      (supportsIncremental && lastRunTime && mode === 'upsert')
        ? source.connector.fetchSince!(lastRunTime)
        : source.connector.fetch!()

    const seenKeys = new Set<string>()

    try {
      for await (const doc of docs) {
        result.total++
        const ikey = resolveIdempotencyKey(doc, source.index.idempotencyKey)
        const contentHash = sha256(doc.content)
        const storeKey = buildHashStoreKey(tenantId, source.id, ikey)
        seenKeys.add(ikey)

        onProgress?.({
          ...result,
          phase: 'hash_check',
          done: result.skipped + result.updated + result.inserted,
          failed: 0,
          current: { idempotencyKey: ikey, reason: 'skipped' },
        })

        const stored = await this.adapter.hashStore.get(storeKey)

        // Skip if content unchanged AND embedding model unchanged
        if (stored?.contentHash === contentHash && stored.embeddingModel === modelId) {
          const actualChunks = await this.adapter.countChunks(modelId, {
            sourceId: source.id,
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

        // If embedding model changed, delete old chunks from the old model's table
        if (stored && stored.embeddingModel !== modelId) {
          await this.adapter.delete(stored.embeddingModel, {
            sourceId: source.id,
            tenantId,
            idempotencyKey: ikey,
          })
        }

        const chunks = source.connector.chunk
          ? source.connector.chunk(doc, source.index)
          : defaultChunker(doc, source.index)

        onProgress?.({
          ...result,
          phase: 'embed',
          done: result.skipped + result.updated + result.inserted,
          failed: 0,
          current: { idempotencyKey: ikey, reason: stored ? 'hash_changed' : 'new' },
        })
        const embeddings = await this.embedding.embedBatch(chunks.map(c => c.content))

        const propagated = this.propagateMetadata(doc, source.index.propagateMetadata)

        const embeddedChunks = chunks.map((chunk, i) => ({
          idempotencyKey: ikey,
          sourceId: source.id,
          tenantId,
          documentId: doc.id,
          content: chunk.content,
          embedding: embeddings[i]!,
          embeddingModel: modelId,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunks.length,
          metadata: { ...propagated, ...chunk.metadata },
          indexedAt: new Date(),
        }))

        if (!dryRun) {
          onProgress?.({
            ...result,
            phase: 'store',
            done: result.skipped + result.updated + result.inserted,
            failed: 0,
            current: { idempotencyKey: ikey, reason: stored ? 'hash_changed' : 'new' },
          })
          await this.adapter.upsertDocument(modelId, embeddedChunks)

          await this.adapter.hashStore.set(storeKey, {
            idempotencyKey: ikey,
            contentHash,
            sourceId: source.id,
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
        `Index failed for source "${source.id}"`,
        result,
        error as Error
      )
    }

    if (pruneDeleted && mode === 'upsert' && !dryRun) {
      const storedRecords = await this.adapter.hashStore.listBySource(source.id, tenantId)
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
        // Delete from the model table recorded in the hash store
        const record = storedRecords.find(r => r.idempotencyKey === key)
        const deleteModel = record?.embeddingModel ?? modelId
        await this.adapter.delete(deleteModel, { sourceId: source.id, tenantId, idempotencyKey: key })
        await this.adapter.hashStore.delete(buildHashStoreKey(tenantId, source.id, key))
        result.pruned++
      }
    }

    if (!dryRun) {
      await this.adapter.hashStore.setLastRunTime(source.id, tenantId, new Date())
    }

    result.durationMs = Date.now() - startMs
    return result
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
