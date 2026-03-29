-- License-TLDR Neural Graph Health Analysis
-- Checking all issues identified in the improvement plan

-- 1. Entity count and type distribution (was: all "entity")
SELECT 'entity_types' AS metric, entity_type AS label, COUNT(*) AS value
FROM bench_license_neural_entities
WHERE invalid_at IS NULL
GROUP BY entity_type
ORDER BY value DESC;

-- 2. Alias coverage (was: zero aliases)
SELECT 'alias_coverage' AS metric,
  COUNT(*) AS total_entities,
  COUNT(*) FILTER (WHERE array_length(aliases, 1) > 0) AS entities_with_aliases,
  COALESCE(SUM(array_length(aliases, 1)), 0) AS total_aliases
FROM bench_license_neural_entities
WHERE invalid_at IS NULL;

-- 3. Embedding coverage (was: 31% missing)
SELECT 'embedding_coverage' AS metric,
  COUNT(*) AS total_entities,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
  COUNT(*) FILTER (WHERE embedding IS NULL) AS without_embedding,
  ROUND(100.0 * COUNT(*) FILTER (WHERE embedding IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS pct_with_embedding
FROM bench_license_neural_entities
WHERE invalid_at IS NULL;

-- 4. Predicate distribution (was: 3,883 unique for 16K edges)
SELECT 'predicate_stats' AS metric,
  COUNT(DISTINCT relation) AS unique_predicates,
  COUNT(*) AS total_edges,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT relation), 0), 1) AS avg_edges_per_predicate
FROM bench_license_neural_edges
WHERE invalid_at IS NULL;

-- 5. Top 20 predicates by frequency
SELECT 'top_predicates' AS metric, relation AS label, COUNT(*) AS value
FROM bench_license_neural_edges
WHERE invalid_at IS NULL
GROUP BY relation
ORDER BY value DESC
LIMIT 20;

-- 6. Generic predicates that should have been filtered
SELECT 'generic_predicates' AS metric, relation AS label, COUNT(*) AS value
FROM bench_license_neural_edges
WHERE invalid_at IS NULL
  AND relation IN ('IS', 'IS_A', 'HAS', 'HAS_A', 'RELATED_TO', 'ASSOCIATED_WITH', 'INVOLVES', 'INCLUDES', 'CONTAINS', 'IS_AN')
GROUP BY relation
ORDER BY value DESC;

-- 7. Edge weight distribution (was: all 1.0)
SELECT 'edge_weights' AS metric,
  MIN(weight) AS min_weight,
  MAX(weight) AS max_weight,
  ROUND(AVG(weight)::numeric, 3) AS avg_weight,
  COUNT(*) FILTER (WHERE weight = 1.0) AS count_weight_1,
  COUNT(*) FILTER (WHERE weight < 1.0) AS count_weight_lt1,
  COUNT(*) FILTER (WHERE weight < 0.5) AS count_weight_lt05
FROM bench_license_neural_edges
WHERE invalid_at IS NULL;

-- 8. CO_OCCURS edges
SELECT 'co_occurs_edges' AS metric,
  COUNT(*) FILTER (WHERE relation = 'CO_OCCURS') AS co_occurs_count,
  COUNT(*) FILTER (WHERE relation != 'CO_OCCURS') AS explicit_count,
  COUNT(*) AS total
FROM bench_license_neural_edges
WHERE invalid_at IS NULL;

-- 9. Graph connectivity: edges per entity ratio
SELECT 'graph_density' AS metric,
  (SELECT COUNT(*) FROM bench_license_neural_entities WHERE invalid_at IS NULL) AS entities,
  (SELECT COUNT(*) FROM bench_license_neural_edges WHERE invalid_at IS NULL) AS edges,
  ROUND((SELECT COUNT(*) FROM bench_license_neural_edges WHERE invalid_at IS NULL)::numeric /
    NULLIF((SELECT COUNT(*) FROM bench_license_neural_entities WHERE invalid_at IS NULL), 0), 2) AS edges_per_entity;

-- 10. Memory table (was: 0 rows)
SELECT 'memories' AS metric, COUNT(*) AS value FROM bench_license_neural_memories;

-- 11. HNSW index check
SELECT 'indexes' AS metric, indexname AS label, indexdef AS value
FROM pg_indexes
WHERE tablename = 'bench_license_neural_entities'
ORDER BY indexname;

-- 12. Entity name duplicates (was: 20 duplicate "X" entities)
SELECT 'duplicate_entities' AS metric, LOWER(name) AS label, COUNT(*) AS value
FROM bench_license_neural_entities
WHERE invalid_at IS NULL
GROUP BY LOWER(name)
HAVING COUNT(*) > 1
ORDER BY value DESC
LIMIT 15;

-- 13. Connected components estimate: sample 5 entities and check 2-hop reachability
WITH seeds AS (
  SELECT id FROM bench_license_neural_entities
  WHERE invalid_at IS NULL AND embedding IS NOT NULL
  ORDER BY random()
  LIMIT 5
),
hop1 AS (
  SELECT DISTINCT CASE WHEN e.source_entity_id = s.id THEN e.target_entity_id ELSE e.source_entity_id END AS reached
  FROM bench_license_neural_edges e
  JOIN seeds s ON e.source_entity_id = s.id OR e.target_entity_id = s.id
  WHERE e.invalid_at IS NULL
),
hop2 AS (
  SELECT DISTINCT CASE WHEN e.source_entity_id = h.reached THEN e.target_entity_id ELSE e.source_entity_id END AS reached
  FROM bench_license_neural_edges e
  JOIN hop1 h ON e.source_entity_id = h.reached OR e.target_entity_id = h.reached
  WHERE e.invalid_at IS NULL
)
SELECT 'connectivity_2hop' AS metric,
  (SELECT COUNT(*) FROM seeds) AS seed_count,
  (SELECT COUNT(*) FROM hop1) AS hop1_reached,
  (SELECT COUNT(*) FROM hop2) AS hop2_reached,
  (SELECT COUNT(*) FROM bench_license_neural_entities WHERE invalid_at IS NULL) AS total_entities;
