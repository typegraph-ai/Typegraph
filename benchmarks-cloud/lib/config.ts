export const BATCH_SIZE = 150

export interface CloudDatasetConfig {
  dataset: string
  displayName: string
  bucketName: string
  blobPrefix: string
  loader: 'beir' | 'graphrag-bench'
}

export const CLOUD_DATASETS: Record<string, CloudDatasetConfig> = {
  'australian-tax-guidance-retrieval': {
    dataset: 'australian-tax-guidance-retrieval',
    displayName: 'AU Tax Guidance Retrieval (isaacus)',
    bucketName: 'australian-tax-guidance-retrieval',
    blobPrefix: 'datasets/isaacus',
    loader: 'beir',
  },
  'graphrag-bench-novel': {
    dataset: 'graphrag-bench-novel',
    displayName: 'GraphRAG-Bench Novel',
    bucketName: 'graphrag-bench-novel',
    blobPrefix: 'datasets/graphrag-bench/novel',
    loader: 'graphrag-bench',
  },
  'graphrag-bench-medical': {
    dataset: 'graphrag-bench-medical',
    displayName: 'GraphRAG-Bench Medical',
    bucketName: 'graphrag-bench-medical',
    blobPrefix: 'datasets/graphrag-bench/medical',
    loader: 'graphrag-bench',
  },
}

export function getCloudConfig(name: string): CloudDatasetConfig {
  const config = CLOUD_DATASETS[name]
  if (!config) {
    const available = Object.keys(CLOUD_DATASETS).join(', ')
    throw new Error(`Unknown dataset: "${name}". Available: ${available}`)
  }
  return config
}
