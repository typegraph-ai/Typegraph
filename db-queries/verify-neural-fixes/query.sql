-- Verify all 4 neural graph fixes on license-tldr-neural post-reseed
-- Fix 1: CO_OCCURS explosion (was 22,021 → target <100)
-- Fix 2: Embedding coverage (was 45.9% → target ~100%)
-- Fix 3: HNSW index (was missing → should exist)
-- Fix 2b: Entity duplicates (was 15 pairs → target 0)

-- 1. Entity count and embedding coverage
SELECT
  COUNT(*) AS total_entities,
  COUNT(embedding) AS with_embedding,
  ROUND(COUNT(embedding)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS embedding_pct
FROM bench_license_neural_entities;

-- 2. CO_OCCURS vs explicit edges
SELECT
  relation,
  COUNT(*) AS edge_count
FROM bench_license_neural_edges
GROUP BY relation
ORDER BY edge_count DESC
LIMIT 20;

-- 3. Total edges and density
SELECT
  (SELECT COUNT(*) FROM bench_license_neural_edges) AS total_edges,
  (SELECT COUNT(*) FROM bench_license_neural_entities) AS total_entities,
  ROUND((SELECT COUNT(*) FROM bench_license_neural_edges)::numeric / NULLIF((SELECT COUNT(*) FROM bench_license_neural_entities), 0), 2) AS edges_per_entity;

-- 4. HNSW index check
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'bench_license_neural_entities' AND indexname LIKE '%embedding%';

-- 5. Entity duplicates (case-insensitive)
SELECT LOWER(name) AS lname, COUNT(*) AS cnt
FROM bench_license_neural_entities
GROUP BY LOWER(name)
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 20;

-- 6. Entity type distribution
SELECT entity_type, COUNT(*) AS cnt
FROM bench_license_neural_entities
GROUP BY entity_type
ORDER BY cnt DESC;

-- 7. Top predicates (should be diverse, no generics)
SELECT relation, COUNT(*) AS cnt
FROM bench_license_neural_edges
WHERE relation != 'CO_OCCURS'
GROUP BY relation
ORDER BY cnt DESC
LIMIT 15;
