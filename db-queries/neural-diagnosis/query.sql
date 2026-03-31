-- Deep diagnosis: why neural = core on multihop-rag
-- Check alias state, entity type distribution, and graph reachability

-- 1. Confirm current alias state
SELECT
  COUNT(*) AS total_entities,
  COUNT(*) FILTER (WHERE COALESCE(array_length(aliases, 1), 0) > 0) AS with_aliases,
  ROUND(AVG(COALESCE(array_length(aliases, 1), 0)), 2) AS avg_aliases,
  MAX(COALESCE(array_length(aliases, 1), 0)) AS max_aliases
FROM bench_multihop_neural_entities;

-- 2. Entity type distribution (should be diverse, not all 'entity')
SELECT entity_type, COUNT(*) AS cnt,
  ROUND(COUNT(*)::numeric / (SELECT COUNT(*) FROM bench_multihop_neural_entities) * 100, 1) AS pct
FROM bench_multihop_neural_entities
GROUP BY entity_type ORDER BY cnt DESC;

-- 3. How many unique predicates, and predicate diversity
SELECT
  COUNT(DISTINCT relation) AS unique_predicates,
  COUNT(*) AS total_edges
FROM bench_multihop_neural_edges;

-- 4. How many entities have edges at all? (non-isolated)
SELECT
  COUNT(DISTINCT entity_id) AS entities_with_edges,
  (SELECT COUNT(*) FROM bench_multihop_neural_entities) AS total_entities
FROM (
  SELECT source_entity_id AS entity_id FROM bench_multihop_neural_edges
  UNION
  SELECT target_entity_id FROM bench_multihop_neural_edges
) sub;

-- 5. PPR reachability: from 10 random seed entities (simulating a query), how many nodes reachable in 2 hops?
WITH seeds AS (
  SELECT id FROM bench_multihop_neural_entities ORDER BY RANDOM() LIMIT 10
),
hop1_edges AS (
  SELECT e.source_entity_id, e.target_entity_id
  FROM bench_multihop_neural_edges e
  WHERE e.source_entity_id IN (SELECT id FROM seeds)
     OR e.target_entity_id IN (SELECT id FROM seeds)
),
hop1_nodes AS (
  SELECT DISTINCT n AS id FROM (
    SELECT source_entity_id AS n FROM hop1_edges
    UNION SELECT target_entity_id FROM hop1_edges
  ) sub
),
hop2_edges AS (
  SELECT e.source_entity_id, e.target_entity_id
  FROM bench_multihop_neural_edges e
  WHERE e.source_entity_id IN (SELECT id FROM hop1_nodes)
     OR e.target_entity_id IN (SELECT id FROM hop1_nodes)
),
hop2_nodes AS (
  SELECT DISTINCT n AS id FROM (
    SELECT source_entity_id AS n FROM hop2_edges
    UNION SELECT target_entity_id FROM hop2_edges
  ) sub
)
SELECT
  (SELECT COUNT(*) FROM seeds) AS seed_count,
  (SELECT COUNT(*) FROM hop1_nodes) AS after_1hop,
  (SELECT COUNT(*) FROM hop2_nodes) AS after_2hops,
  (SELECT COUNT(*) FROM bench_multihop_neural_entities) AS total_entities,
  ROUND((SELECT COUNT(*) FROM hop2_nodes)::numeric / (SELECT COUNT(*) FROM bench_multihop_neural_entities) * 100, 2) AS pct_reached;

-- 6. How many unique chunks does the graph actually store? (in edge properties)
SELECT
  COUNT(*) AS total_edges_with_content,
  COUNT(DISTINCT LEFT(properties->>'content', 200)) AS unique_chunk_prefixes,
  COUNT(DISTINCT properties->>'bucketId') AS unique_buckets
FROM bench_multihop_neural_edges
WHERE properties->>'content' IS NOT NULL;

-- 7. Check if aliases would have been extracted: sample 5 entities that appear in 3+ edges
-- to see if the LLM found them with different names
WITH entity_edge_counts AS (
  SELECT entity_id, COUNT(*) AS edge_count FROM (
    SELECT source_entity_id AS entity_id FROM bench_multihop_neural_edges
    UNION ALL
    SELECT target_entity_id FROM bench_multihop_neural_edges
  ) sub
  GROUP BY entity_id
  HAVING COUNT(*) >= 3
  ORDER BY RANDOM()
  LIMIT 5
)
SELECT e.name, e.entity_type, e.aliases, ec.edge_count
FROM entity_edge_counts ec
JOIN bench_multihop_neural_entities e ON e.id = ec.entity_id;
