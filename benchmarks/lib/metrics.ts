/**
 * metrics.ts — IR evaluation metrics (shared across all benchmarks)
 */

export function dcg(relevances: number[], k: number): number {
  let sum = 0
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    sum += relevances[i]! / Math.log2(i + 2)
  }
  return sum
}

export function ndcg(retrieved: string[], relevant: Map<string, number>, k: number): number {
  const retrievedRels = retrieved.slice(0, k).map(id => relevant.get(id) ?? 0)
  const actualDCG = dcg(retrievedRels, k)
  const idealRels = [...relevant.values()].sort((a, b) => b - a)
  const idealDCG = dcg(idealRels, k)
  return idealDCG === 0 ? 0 : actualDCG / idealDCG
}

export function averagePrecision(retrieved: string[], relevant: Set<string>, k: number): number {
  let hits = 0
  let sum = 0
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.has(retrieved[i]!)) {
      hits++
      sum += hits / (i + 1)
    }
  }
  return relevant.size === 0 ? 0 : sum / relevant.size
}

export function recall(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = new Set(retrieved.slice(0, k))
  let hits = 0
  for (const id of relevant) {
    if (topK.has(id)) hits++
  }
  return relevant.size === 0 ? 0 : hits / relevant.size
}

export function precision(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k)
  let hits = 0
  for (const id of topK) {
    if (relevant.has(id)) hits++
  }
  return topK.length === 0 ? 0 : hits / topK.length
}

export function reciprocalRank(retrieved: string[], relevant: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.has(retrieved[i]!)) return 1 / (i + 1)
  }
  return 0
}

export function hitAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.has(retrieved[i]!)) return 1
  }
  return 0
}

// ── Answer-generation evaluation metrics ──

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

export function substringAccuracy(predicted: string, gold: string): number {
  return normalizeAnswer(predicted).includes(normalizeAnswer(gold)) ? 1 : 0
}

export function exactMatch(predicted: string, gold: string): number {
  return normalizeAnswer(predicted) === normalizeAnswer(gold) ? 1 : 0
}

export function tokenF1(predicted: string, gold: string): number {
  const predTokens = normalizeAnswer(predicted).split(/\s+/).filter(Boolean)
  const goldTokens = normalizeAnswer(gold).split(/\s+/).filter(Boolean)
  if (goldTokens.length === 0) return predTokens.length === 0 ? 1 : 0
  const goldSet = new Set(goldTokens)
  const common = predTokens.filter(t => goldSet.has(t)).length
  if (common === 0) return 0
  const precision = common / predTokens.length
  const recall = common / goldTokens.length
  return 2 * precision * recall / (precision + recall)
}

// ── Retrieval helpers ──

export function deduplicateToDocuments(
  results: Array<{ metadata: Record<string, unknown> }>,
  limit: number,
): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const r of results) {
    const id = r.metadata['corpusId'] as string
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
      if (ids.length >= limit) break
    }
  }
  return ids
}

export function scoreAllQueries(
  allResults: Map<string, string[]>,
  qrelsMap: Map<string, Map<string, number>>,
  k: number,
) {
  let sumNDCG = 0
  let sumAP = 0
  let sumRecall = 0
  let sumPrecision = 0
  let scored = 0

  for (const [queryId, retrieved] of allResults) {
    const rels = qrelsMap.get(queryId)
    if (!rels) continue

    const relevantSet = new Set(
      [...rels.entries()].filter(([, score]) => score > 0).map(([id]) => id),
    )

    sumNDCG += ndcg(retrieved, rels, k)
    sumAP += averagePrecision(retrieved, relevantSet, k)
    sumRecall += recall(retrieved, relevantSet, k)
    sumPrecision += precision(retrieved, relevantSet, k)
    scored++
  }

  return {
    metrics: {
      'nDCG@10': sumNDCG / scored,
      'MAP@10': sumAP / scored,
      'Recall@10': sumRecall / scored,
      'Precision@10': sumPrecision / scored,
    },
    scored,
  }
}

/**
 * Extended scoring: standard 4 metrics + MRR@K and Hit@K.
 * Used by benchmarks that report MRR and Hit (e.g. MultiHop-RAG).
 */
export function scoreAllQueriesExtended(
  allResults: Map<string, string[]>,
  qrelsMap: Map<string, Map<string, number>>,
  k: number,
) {
  let sumNDCG = 0
  let sumAP = 0
  let sumRecall = 0
  let sumPrecision = 0
  let sumMRR = 0
  let sumHit = 0
  let scored = 0

  for (const [queryId, retrieved] of allResults) {
    const rels = qrelsMap.get(queryId)
    if (!rels) continue

    const relevantSet = new Set(
      [...rels.entries()].filter(([, score]) => score > 0).map(([id]) => id),
    )

    sumNDCG += ndcg(retrieved, rels, k)
    sumAP += averagePrecision(retrieved, relevantSet, k)
    sumRecall += recall(retrieved, relevantSet, k)
    sumPrecision += precision(retrieved, relevantSet, k)
    sumMRR += reciprocalRank(retrieved, relevantSet, k)
    sumHit += hitAtK(retrieved, relevantSet, k)
    scored++
  }

  return {
    metrics: {
      'nDCG@10': sumNDCG / scored,
      'MAP@10': sumAP / scored,
      'Recall@10': sumRecall / scored,
      'Precision@10': sumPrecision / scored,
      'MRR@10': sumMRR / scored,
      'Hit@10': sumHit / scored,
    },
    scored,
  }
}
