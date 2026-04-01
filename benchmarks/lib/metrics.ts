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

// ── GraphRAG-Bench Answer Correctness (LLM-as-judge) ──
// Exact replication of GraphRAG-Bench/GraphRAG-Benchmark/Evaluation/metrics/answer_accuracy.py
// Score = 0.75 * factuality_fbeta + 0.25 * semantic_similarity

// Prompts copied verbatim from the benchmark repo
const STATEMENT_GENERATOR_PROMPT = `Given a question and an answer, analyze the complexity of each sentence in the answer. Break down each sentence into one or more fully understandable statements. Ensure that no pronouns are used in any statement. Format the outputs in JSON.

Example Input:
Question: Who was Albert Einstein and what is he best known for?
Answer: He was a German-born theoretical physicist, widely acknowledged to be one of the greatest and most influential physicists of all time. He was best known for developing the theory of relativity, he also made important contributions to the development of the theory of quantum mechanics.

Example Output:
["Albert Einstein was a German-born theoretical physicist.", "Albert Einstein is recognized as one of the greatest and most influential physicists of all time.","Albert Einstein was best known for developing the theory of relativity.","Albert Einstein also made important contributions to the development of the theory of quantum mechanics."]

Input Text:
Question:{question}
Answer: {answer}

Generated Statements:
`

const CORRECTNESS_EXAMPLES = [
  {
    input: {
      question: "What powers the sun and what is its primary function?",
      answer: [
        "The sun is powered by nuclear fission, similar to nuclear reactors on Earth.",
        "The primary function of the sun is to provide light to the solar system."
      ],
      ground_truth: [
        "The sun is powered by nuclear fusion, where hydrogen atoms fuse to form helium.",
        "This fusion process in the sun's core releases a tremendous amount of energy.",
        "The energy from the sun provides heat and light, which are essential for life on Earth.",
        "The sun's light plays a critical role in Earth's climate system.",
        "Sunlight helps to drive the weather and ocean currents."
      ]
    },
    output: {
      TP: [{ statement: "The primary function of the sun is to provide light to the solar system.", reason: "This statement is somewhat supported by the ground truth mentioning the sun providing light and its roles, though it focuses more broadly on the sun's energy." }],
      FP: [{ statement: "The sun is powered by nuclear fission, similar to nuclear reactors on Earth.", reason: "This statement is incorrect and contradicts the ground truth which states that the sun is powered by nuclear fusion." }],
      FN: [
        { statement: "The sun is powered by nuclear fusion, where hydrogen atoms fuse to form helium.", reason: "This accurate description of the sun's power source is not included in the answer." },
        { statement: "This fusion process in the sun's core releases a tremendous amount of energy.", reason: "This process and its significance are not mentioned in the answer." },
        { statement: "The energy from the sun provides heat and light, which are essential for life on Earth.", reason: "The answer only mentions light, omitting the essential aspects of heat and its necessity for life, which the ground truth covers." },
        { statement: "The sun's light plays a critical role in Earth's climate system.", reason: "This broader impact of the sun's light on Earth's climate system is not addressed in the answer." },
        { statement: "Sunlight helps to drive the weather and ocean currents.", reason: "The effect of sunlight on weather patterns and ocean currents is omitted in the answer." },
      ]
    }
  },
  {
    input: {
      question: "What is the boiling point of water?",
      answer: ["The boiling point of water is 100 degrees Celsius at sea level"],
      ground_truth: [
        "The boiling point of water is 100 degrees Celsius (212 degrees Fahrenheit) at sea level.",
        "The boiling point of water can change with altitude."
      ]
    },
    output: {
      TP: [{ statement: "The boiling point of water is 100 degrees Celsius at sea level", reason: "This statement is directly supported by the ground truth which specifies the boiling point of water as 100 degrees Celsius at sea level." }],
      FP: [],
      FN: [{ statement: "The boiling point of water can change with altitude.", reason: "This additional information about how the boiling point of water can vary with altitude is not mentioned in the answer." }]
    }
  }
]

const CORRECTNESS_PROMPT_TEMPLATE = `Given a ground truth and an answer statements, analyze each statement and classify them in one of the following categories: TP (true positive): statements that are present in answer that are also directly supported by the one or more statements in ground truth, FP (false positive): statements present in the answer but not directly supported by any statement in ground truth, FN (false negative): statements found in the ground truth but not present in answer. Each statement can only belong to one of the categories. Provide a reason for each classification.

Examples:
{examples}

Current Analysis:
Question: {question}
Answer Statements: {answer}
Ground Truth Statements: {ground_truth}
`

function fbetaScore(tp: number, fp: number, fn: number, beta = 1.0): number {
  const precision = tp / (tp + fp + 1e-10)
  const recall = tp / (tp + fn + 1e-10)
  return (1 + beta ** 2) * (precision * recall) / ((beta ** 2 * precision) + recall + 1e-10)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export interface AnswerCorrectnessConfig {
  /** LLM for statement generation + classification. Must support generateJSON/generateText. */
  generateText: (prompt: string) => Promise<string>
  /** Embedding function for semantic similarity. */
  embed: (text: string) => Promise<number[]>
  /** Weights: [factuality, similarity]. Default [0.75, 0.25]. */
  weights?: [number, number]
  /** F-beta parameter. Default 1.0. */
  beta?: number
}

/**
 * GraphRAG-Bench Answer Correctness score.
 * Matches the exact methodology from GraphRAG-Bench/Evaluation/metrics/answer_accuracy.py:
 *   score = 0.75 * factuality_fbeta(TP/FP/FN) + 0.25 * semantic_similarity(answer, gold)
 *
 * Returns 0.0-1.0 continuous score.
 */
export async function answerCorrectness(
  question: string,
  predicted: string,
  gold: string,
  config: AnswerCorrectnessConfig,
): Promise<number> {
  const weights = config.weights ?? [0.75, 0.25]
  const beta = config.beta ?? 1.0

  // Step 1: Generate statements from both answer and gold
  const [answerStatements, gtStatements] = await Promise.all([
    generateStatements(config.generateText, question, predicted),
    generateStatements(config.generateText, question, gold),
  ])

  // Step 2: Calculate factuality (75% weight)
  let factualityScore = 0
  if (weights[0] !== 0) {
    if (answerStatements.length === 0 && gtStatements.length === 0) {
      factualityScore = 1.0
    } else {
      factualityScore = await calculateFactuality(
        config.generateText, question, answerStatements, gtStatements, beta,
      )
    }
  }

  // Step 3: Calculate semantic similarity (25% weight)
  let similarityScore = 0
  if (weights[1] !== 0) {
    const [aEmbed, gtEmbed] = await Promise.all([
      config.embed(predicted),
      config.embed(gold),
    ])
    const cosine = cosineSimilarity(aEmbed, gtEmbed)
    similarityScore = (cosine + 1) / 2  // Scale to [0, 1]
  }

  // Weighted average
  return weights[0] * factualityScore + weights[1] * similarityScore
}

async function generateStatements(
  llm: (prompt: string) => Promise<string>,
  question: string,
  answer: string,
): Promise<string[]> {
  const prompt = STATEMENT_GENERATOR_PROMPT
    .replace('{question}', question)
    .replace('{answer}', answer)

  try {
    const response = await llm(prompt)
    const cleaned = response.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) return parsed.map(String)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['statements', 'answers', 'items', 'list', 'output', 'result']) {
        const val = (parsed as Record<string, unknown>)[key]
        if (Array.isArray(val)) return val.map(String)
      }
      return Object.values(parsed).map(String)
    }
    return [String(parsed)]
  } catch {
    return [answer]  // Fallback: treat entire answer as one statement
  }
}

async function calculateFactuality(
  llm: (prompt: string) => Promise<string>,
  question: string,
  answerStmts: string[],
  gtStmts: string[],
  beta: number,
): Promise<number> {
  const examples = CORRECTNESS_EXAMPLES
    .map(ex => `Input: ${JSON.stringify(ex.input)}\nOutput: ${JSON.stringify(ex.output)}`)
    .join('\n')

  const prompt = CORRECTNESS_PROMPT_TEMPLATE
    .replace('{examples}', examples)
    .replace('{question}', question)
    .replace('{answer}', JSON.stringify(answerStmts))
    .replace('{ground_truth}', JSON.stringify(gtStmts))

  try {
    const response = await llm(prompt)
    const cleaned = response.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()
    const classification = JSON.parse(cleaned) as { TP?: unknown[]; FP?: unknown[]; FN?: unknown[] }
    const tp = Array.isArray(classification.TP) ? classification.TP.length : 0
    const fp = Array.isArray(classification.FP) ? classification.FP.length : 0
    const fn = Array.isArray(classification.FN) ? classification.FN.length : 0
    return fbetaScore(tp, fp, fn, beta)
  } catch {
    return 0  // Minimum score on parse failure
  }
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
