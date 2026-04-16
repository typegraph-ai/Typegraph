export { QueryPlanner, resolveSignals, signalLabel, computeCompositeScore } from './planner.js'
export { classifyQuery, type QueryClassification, type QueryType } from './classifier.js'
export { mergeAndRank, minMaxNormalize, dedupKey, normalizeRRF, normalizePPR, calibrateSemantic, calibrateKeyword } from './merger.js'
export type { NormalizedResult } from './merger.js'
// assemble is internal — users access formatting via opts.format on query()
export { IndexedRunner } from './runners/indexed.js'
