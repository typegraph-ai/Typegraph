/**
 * config.ts — Benchmark configuration registry
 *
 * All per-benchmark variation is captured here as data, not code.
 * Shared defaults are constants — all 14 current runners use identical values.
 */

// ── Shared defaults (identical across all runners) ──

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMS = 1536
export const LLM_MODEL = 'openai/gpt-5.4-mini'
/** LLM used for triple extraction in neural mode. Defaults to LLM_MODEL. Override to use a reasoning model. */
export const EXTRACTION_MODEL = 'xai/grok-4.20-reasoning'
export const CHUNK_SIZE = 2048
export const CHUNK_OVERLAP = 256
export const K = 10
export const QUERY_FETCH = K * 5  // 50
export const BATCH_SIZE = 30

// ── Per-benchmark configuration ──

/** Which retrieval signals to activate. Mirrors @d8um-ai/core QuerySignals. */
export interface BenchSignals {
  vector?: boolean
  keyword?: boolean
  graph?: boolean
  memory?: boolean
}

/** Human-readable label from active signals (e.g. "vector+keyword"). */
export function signalLabel(signals: BenchSignals): string {
  const active: string[] = []
  if (signals.vector) active.push('vector')
  if (signals.keyword) active.push('keyword')
  if (signals.graph) active.push('graph')
  if (signals.memory) active.push('memory')
  return active.join('+') || 'none'
}

/** Common signal presets */
export const SIGNALS = {
  vector: { vector: true } as BenchSignals,
  vectorKeyword: { vector: true, keyword: true } as BenchSignals,
  neural: { vector: true, keyword: true, graph: true, memory: true } as BenchSignals,
} as const

export interface BenchmarkConfig {
  /** Directory name under benchmarks/ */
  dataset: string
  /** Human-readable name for reports */
  displayName: string
  /** Neon bucket name */
  bucketName: string
  /** DB table prefix */
  tablePrefix: string
  /** Blob storage prefix for dataset files */
  blobPrefix: string
  /** Dataset loading strategy */
  loader: 'beir' | 'legal-rag' | 'graphrag-bench'
  /** Metrics to compute: standard (4 metrics) or extended (+MRR, Hit) */
  scorer: 'standard' | 'extended'
  /** Signal configurations to test */
  signals: BenchSignals[]
  /** Variant label for results */
  variant: 'core' | 'neural'
  /** Whether this benchmark supports --eval-answers flags */
  supportsAnswerEval: boolean
  /** Optional overrides for shared defaults */
  chunkSize?: number
  chunkOverlap?: number
  embeddingModel?: string
  embeddingDims?: number
}

/**
 * Registry of all benchmark configurations.
 * Key format: "dataset/variant" (e.g., "nfcorpus/core", "multihop-rag/neural")
 */
export const BENCHMARK_CONFIGS: Record<string, BenchmarkConfig> = {
  // ── NFCorpus (BEIR) ──
  'nfcorpus/core': {
    dataset: 'nfcorpus',
    displayName: 'NFCorpus (BEIR)',
    bucketName: 'nfcorpus',
    tablePrefix: 'nfcorpus_core_',
    blobPrefix: 'datasets/beir',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'nfcorpus/neural': {
    dataset: 'nfcorpus',
    displayName: 'NFCorpus (BEIR)',
    bucketName: 'nfcorpus-neural',
    tablePrefix: 'nfcorpus_neural_',
    blobPrefix: 'datasets/beir',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Australian Tax Guidance Retrieval (MLEB/isaacus) ──
  'australian-tax-guidance-retrieval/core': {
    dataset: 'australian-tax-guidance-retrieval',
    displayName: 'AU Tax Guidance Retrieval (isaacus)',
    bucketName: 'au-tax-guidance',
    tablePrefix: 'au_tax_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'australian-tax-guidance-retrieval/neural': {
    dataset: 'australian-tax-guidance-retrieval',
    displayName: 'AU Tax Guidance Retrieval (isaacus)',
    bucketName: 'au-tax-guidance-neural',
    tablePrefix: 'au_tax_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── License TLDR Retrieval (MLEB/isaacus) ──
  'license-tldr-retrieval/core': {
    dataset: 'license-tldr-retrieval',
    displayName: 'License TLDR Retrieval (isaacus)',
    bucketName: 'license-tldr',
    tablePrefix: 'license_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'license-tldr-retrieval/neural': {
    dataset: 'license-tldr-retrieval',
    displayName: 'License TLDR Retrieval (isaacus)',
    bucketName: 'license-tldr-neural',
    tablePrefix: 'license_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Contractual Clause Retrieval (MLEB/isaacus) ──
  'contractual-clause-retrieval/core': {
    dataset: 'contractual-clause-retrieval',
    displayName: 'Contractual Clause Retrieval (isaacus)',
    bucketName: 'contractual-clause',
    tablePrefix: 'contract_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'contractual-clause-retrieval/neural': {
    dataset: 'contractual-clause-retrieval',
    displayName: 'Contractual Clause Retrieval (isaacus)',
    bucketName: 'contractual-clause-neural',
    tablePrefix: 'contract_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── MLEB-SCALR (MLEB/isaacus) ──
  'mleb-scalr/core': {
    dataset: 'mleb-scalr',
    displayName: 'MLEB-SCALR (isaacus)',
    bucketName: 'mleb-scalr',
    tablePrefix: 'mleb_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'mleb-scalr/neural': {
    dataset: 'mleb-scalr',
    displayName: 'MLEB-SCALR (isaacus)',
    bucketName: 'mleb-scalr-neural',
    tablePrefix: 'mleb_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Legal RAG Bench ──
  'legal-rag-bench/core': {
    dataset: 'legal-rag-bench',
    displayName: 'Legal RAG Bench',
    bucketName: 'legal-rag-bench',
    tablePrefix: 'legalrag_core_',
    blobPrefix: '',  // custom loader, not blob-based
    loader: 'legal-rag',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'legal-rag-bench/neural': {
    dataset: 'legal-rag-bench',
    displayName: 'Legal RAG Bench',
    bucketName: 'legal-rag-bench-neural',
    tablePrefix: 'legalrag_neural_',
    blobPrefix: '',  // custom loader, not blob-based
    loader: 'legal-rag',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── MultiHop-RAG (COLM 2024) ──
  // Paper uses 256-token chunks (Table 5 setup) — NOT the shared 2048 default
  'multihop-rag/core': {
    dataset: 'multihop-rag',
    displayName: 'MultiHop-RAG (COLM 2024)',
    bucketName: 'multihop-rag',
    tablePrefix: 'multihop_core_',
    blobPrefix: 'datasets',
    loader: 'beir',
    scorer: 'extended',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: true,
    chunkSize: 256,
    chunkOverlap: 32,
  },
  'multihop-rag/neural': {
    dataset: 'multihop-rag',
    displayName: 'MultiHop-RAG (COLM 2024)',
    bucketName: 'multihop-rag-neural',
    tablePrefix: 'multihop_neural_',
    blobPrefix: 'datasets',
    loader: 'beir',
    scorer: 'extended',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: true,
    chunkSize: 256,
    chunkOverlap: 32,
  },
  // ── GraphRAG-Bench Novel (arXiv:2506.05690) ──
  'graphrag-bench-novel/core': {
    dataset: 'graphrag-bench-novel',
    displayName: 'GraphRAG-Bench Novel (ICLR 2026)',
    bucketName: 'graphrag-bench-novel',
    tablePrefix: 'grbnovel_core_',
    blobPrefix: 'datasets/graphrag-bench/novel',
    loader: 'graphrag-bench',
    scorer: 'standard',  // retrieval metrics have no qrels; answer-gen eval is primary
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },
  'graphrag-bench-novel/neural': {
    dataset: 'graphrag-bench-novel',
    displayName: 'GraphRAG-Bench Novel (ICLR 2026)',
    bucketName: 'graphrag-bench-novel-neural',
    tablePrefix: 'grbnovel_neural_',
    blobPrefix: 'datasets/graphrag-bench/novel',
    loader: 'graphrag-bench',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },

  // ── GraphRAG-Bench Medical (arXiv:2506.05690) ──
  'graphrag-bench-medical/core': {
    dataset: 'graphrag-bench-medical',
    displayName: 'GraphRAG-Bench Medical (ICLR 2026)',
    bucketName: 'graphrag-bench-medical',
    tablePrefix: 'grbmed_core_',
    blobPrefix: 'datasets/graphrag-bench/medical',
    loader: 'graphrag-bench',
    scorer: 'standard',
    signals: [SIGNALS.vector, SIGNALS.vectorKeyword],
    variant: 'core',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },
  'graphrag-bench-medical/neural': {
    dataset: 'graphrag-bench-medical',
    displayName: 'GraphRAG-Bench Medical (ICLR 2026)',
    bucketName: 'graphrag-bench-medical-neural',
    tablePrefix: 'grbmed_neural_',
    blobPrefix: 'datasets/graphrag-bench/medical',
    loader: 'graphrag-bench',
    scorer: 'standard',
    signals: [SIGNALS.neural],
    variant: 'neural',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },
}

/** Get config by key or throw */
export function getConfig(key: string): BenchmarkConfig {
  const config = BENCHMARK_CONFIGS[key]
  if (!config) {
    const available = Object.keys(BENCHMARK_CONFIGS).join(', ')
    throw new Error(`Unknown benchmark: "${key}". Available: ${available}`)
  }
  return config
}

/** Resolve a config value with optional override */
export function resolveChunkSize(config: BenchmarkConfig): number {
  return config.chunkSize ?? CHUNK_SIZE
}
export function resolveChunkOverlap(config: BenchmarkConfig): number {
  return config.chunkOverlap ?? CHUNK_OVERLAP
}
export function resolveEmbeddingModel(config: BenchmarkConfig): string {
  return config.embeddingModel ?? EMBEDDING_MODEL
}
export function resolveEmbeddingDims(config: BenchmarkConfig): number {
  return config.embeddingDims ?? EMBEDDING_DIMS
}
