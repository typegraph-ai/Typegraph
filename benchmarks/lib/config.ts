/**
 * config.ts — Benchmark configuration registry
 *
 * All per-benchmark variation is captured here as data, not code.
 * Shared defaults are constants — all 14 current runners use identical values.
 */

// ── Shared defaults (identical across all runners) ──

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMS = 1536
export const LLM_MODEL = 'google/gemini-3.1-flash-lite-preview'
export const CHUNK_SIZE = 2048
export const CHUNK_OVERLAP = 256
export const K = 10
export const QUERY_FETCH = K * 5  // 50
export const BATCH_SIZE = 30

// ── Per-benchmark configuration ──

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
  /** Search modes to run: core=['hybrid','fast'], neural=['neural'] */
  modes: string[]
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
    tablePrefix: 'bench_nfcorpus_core_',
    blobPrefix: 'datasets/beir',
    loader: 'beir',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'nfcorpus/neural': {
    dataset: 'nfcorpus',
    displayName: 'NFCorpus (BEIR)',
    bucketName: 'nfcorpus-neural',
    tablePrefix: 'bench_nfcorpus_neural_',
    blobPrefix: 'datasets/beir',
    loader: 'beir',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Australian Tax Guidance Retrieval (MLEB/isaacus) ──
  'australian-tax-guidance-retrieval/core': {
    dataset: 'australian-tax-guidance-retrieval',
    displayName: 'AU Tax Guidance Retrieval (isaacus)',
    bucketName: 'au-tax-guidance',
    tablePrefix: 'bench_au_tax_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'australian-tax-guidance-retrieval/neural': {
    dataset: 'australian-tax-guidance-retrieval',
    displayName: 'AU Tax Guidance Retrieval (isaacus)',
    bucketName: 'au-tax-guidance-neural',
    tablePrefix: 'bench_au_tax_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── License TLDR Retrieval (MLEB/isaacus) ──
  'license-tldr-retrieval/core': {
    dataset: 'license-tldr-retrieval',
    displayName: 'License TLDR Retrieval (isaacus)',
    bucketName: 'license-tldr',
    tablePrefix: 'bench_license_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'license-tldr-retrieval/neural': {
    dataset: 'license-tldr-retrieval',
    displayName: 'License TLDR Retrieval (isaacus)',
    bucketName: 'license-tldr-neural',
    tablePrefix: 'bench_license_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Contractual Clause Retrieval (MLEB/isaacus) ──
  'contractual-clause-retrieval/core': {
    dataset: 'contractual-clause-retrieval',
    displayName: 'Contractual Clause Retrieval (isaacus)',
    bucketName: 'contractual-clause',
    tablePrefix: 'bench_contract_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'contractual-clause-retrieval/neural': {
    dataset: 'contractual-clause-retrieval',
    displayName: 'Contractual Clause Retrieval (isaacus)',
    bucketName: 'contractual-clause-neural',
    tablePrefix: 'bench_contract_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── MLEB-SCALR (MLEB/isaacus) ──
  'mleb-scalr/core': {
    dataset: 'mleb-scalr',
    displayName: 'MLEB-SCALR (isaacus)',
    bucketName: 'mleb-scalr',
    tablePrefix: 'bench_mleb_core_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'mleb-scalr/neural': {
    dataset: 'mleb-scalr',
    displayName: 'MLEB-SCALR (isaacus)',
    bucketName: 'mleb-scalr-neural',
    tablePrefix: 'bench_mleb_neural_',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── Legal RAG Bench ──
  'legal-rag-bench/core': {
    dataset: 'legal-rag-bench',
    displayName: 'Legal RAG Bench',
    bucketName: 'legal-rag-bench',
    tablePrefix: 'bench_legalrag_core_',
    blobPrefix: '',  // custom loader, not blob-based
    loader: 'legal-rag',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: false,
  },
  'legal-rag-bench/neural': {
    dataset: 'legal-rag-bench',
    displayName: 'Legal RAG Bench',
    bucketName: 'legal-rag-bench-neural',
    tablePrefix: 'bench_legalrag_neural_',
    blobPrefix: '',  // custom loader, not blob-based
    loader: 'legal-rag',
    scorer: 'standard',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: false,
  },

  // ── MultiHop-RAG (COLM 2024) ──
  'multihop-rag/core': {
    dataset: 'multihop-rag',
    displayName: 'MultiHop-RAG (COLM 2024)',
    bucketName: 'multihop-rag',
    tablePrefix: 'bench_multihop_core_',
    blobPrefix: 'datasets',
    loader: 'beir',
    scorer: 'extended',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: true,
  },
  'multihop-rag/neural': {
    dataset: 'multihop-rag',
    displayName: 'MultiHop-RAG (COLM 2024)',
    bucketName: 'multihop-rag-neural',
    tablePrefix: 'bench_multihop_neural_',
    blobPrefix: 'datasets',
    loader: 'beir',
    scorer: 'extended',
    modes: ['neural'],
    variant: 'neural',
    supportsAnswerEval: true,
  },
  // ── GraphRAG-Bench Novel (arXiv:2506.05690) ──
  'graphrag-bench-novel/core': {
    dataset: 'graphrag-bench-novel',
    displayName: 'GraphRAG-Bench Novel (ICLR 2026)',
    bucketName: 'graphrag-bench-novel',
    tablePrefix: 'bench_grbnovel_core_',
    blobPrefix: 'datasets/graphrag-bench/novel',
    loader: 'graphrag-bench',
    scorer: 'standard',  // retrieval metrics have no qrels; answer-gen eval is primary
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },
  'graphrag-bench-novel/neural': {
    dataset: 'graphrag-bench-novel',
    displayName: 'GraphRAG-Bench Novel (ICLR 2026)',
    bucketName: 'graphrag-bench-novel-neural',
    tablePrefix: 'bench_grbnovel_neural_',
    blobPrefix: 'datasets/graphrag-bench/novel',
    loader: 'graphrag-bench',
    scorer: 'standard',
    modes: ['neural'],
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
    tablePrefix: 'bench_grbmed_core_',
    blobPrefix: 'datasets/graphrag-bench/medical',
    loader: 'graphrag-bench',
    scorer: 'standard',
    modes: ['hybrid', 'fast'],
    variant: 'core',
    supportsAnswerEval: true,
    chunkSize: 1200,
    chunkOverlap: 128,
  },
  'graphrag-bench-medical/neural': {
    dataset: 'graphrag-bench-medical',
    displayName: 'GraphRAG-Bench Medical (ICLR 2026)',
    bucketName: 'graphrag-bench-medical-neural',
    tablePrefix: 'bench_grbmed_neural_',
    blobPrefix: 'datasets/graphrag-bench/medical',
    loader: 'graphrag-bench',
    scorer: 'standard',
    modes: ['neural'],
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
