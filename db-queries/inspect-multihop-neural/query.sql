-- Inspect multihop-rag neural graph health after successful seed
-- prefix: bench_multihop_neural_

-- 1. Entity count + embedding coverage (target: 100%)
SELECT COUNT(*) AS total_entities, COUNT(embedding) AS with_embedding,
  ROUND(COUNT(embedding)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS embedding_pct
FROM bench_multihop_neural_entities;

-- 2. Edge distribution by relation (CO_OCCURS should be 0 or near-0)
SELECT relation, COUNT(*) AS edge_count
FROM bench_multihop_neural_edges
GROUP BY relation ORDER BY edge_count DESC LIMIT 25;

-- 3. Total edges + density
SELECT
  (SELECT COUNT(*) FROM bench_multihop_neural_edges) AS total_edges,
  (SELECT COUNT(*) FROM bench_multihop_neural_entities) AS total_entities,
  ROUND((SELECT COUNT(*) FROM bench_multihop_neural_edges)::numeric / NULLIF((SELECT COUNT(*) FROM bench_multihop_neural_entities), 0), 2) AS edges_per_entity;

-- 4. HNSW index check
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'bench_multihop_neural_entities' AND indexname LIKE '%embedding%';

-- 5. Entity duplicates (case-insensitive, target: <10 pairs)
SELECT LOWER(name) AS lname, COUNT(*) AS cnt
FROM bench_multihop_neural_entities
GROUP BY LOWER(name) HAVING COUNT(*) > 1
ORDER BY cnt DESC LIMIT 20;

-- 6. Entity type distribution
SELECT entity_type, COUNT(*) AS cnt
FROM bench_multihop_neural_entities
GROUP BY entity_type ORDER BY cnt DESC;

-- 7. Top predicates (should be diverse, no single predicate dominating)
SELECT relation, COUNT(*) AS cnt
FROM bench_multihop_neural_edges
WHERE relation != 'CO_OCCURS'
GROUP BY relation ORDER BY cnt DESC LIMIT 20;

-- 8. Chunk and doc counts
SELECT
  (SELECT COUNT(*) FROM bench_multihop_neural__gateway_openai_text_embedding_3_small) AS total_chunks,
  (SELECT COUNT(*) FROM bench_multihop_neural__registry) AS registry_entries;

-- 9. Memories count
SELECT COUNT(*) AS total_memories FROM bench_multihop_neural_memories;
