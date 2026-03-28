WITH degree AS (
  SELECT entity_id, SUM(cnt) AS degree FROM (
    SELECT source_entity_id AS entity_id, COUNT(*) AS cnt FROM bench_multihop_neural_edges GROUP BY source_entity_id
    UNION ALL
    SELECT target_entity_id, COUNT(*) FROM bench_multihop_neural_edges GROUP BY target_entity_id
  ) sub
  GROUP BY entity_id
),
all_entities AS (
  SELECT e.id, e.name, COALESCE(d.degree, 0) AS degree
  FROM bench_multihop_neural_entities e
  LEFT JOIN degree d ON d.entity_id = e.id
),
degree_distribution AS (
  SELECT
    CASE
      WHEN degree = 0 THEN '0_isolated'
      WHEN degree = 1 THEN '1'
      WHEN degree = 2 THEN '2'
      WHEN degree BETWEEN 3 AND 5 THEN '3-5'
      WHEN degree BETWEEN 6 AND 10 THEN '6-10'
      WHEN degree BETWEEN 11 AND 20 THEN '11-20'
      WHEN degree BETWEEN 21 AND 50 THEN '21-50'
      WHEN degree BETWEEN 51 AND 100 THEN '51-100'
      ELSE '100+'
    END AS bucket,
    COUNT(*) AS cnt
  FROM all_entities
  GROUP BY bucket
),
degree_stats AS (
  SELECT
    ROUND(AVG(degree)::numeric, 2) AS avg_degree,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY degree) AS median_degree,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY degree) AS p90_degree,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY degree) AS p99_degree,
    MAX(degree) AS max_degree,
    COUNT(*) FILTER (WHERE degree > 50) AS hubs_gt_50,
    COUNT(*) FILTER (WHERE degree = 0) AS isolated
  FROM all_entities
),
-- Connected components estimate: pick 5 random seeds, expand 2 hops, count reachable
component_sample AS (
  SELECT id AS seed FROM bench_multihop_neural_entities ORDER BY RANDOM() LIMIT 5
),
hop1 AS (
  SELECT DISTINCT CASE WHEN e.source_entity_id = cs.seed THEN e.target_entity_id ELSE e.source_entity_id END AS neighbor
  FROM bench_multihop_neural_edges e
  JOIN component_sample cs ON e.source_entity_id = cs.seed OR e.target_entity_id = cs.seed
),
hop2 AS (
  SELECT DISTINCT CASE WHEN e.source_entity_id = h.neighbor THEN e.target_entity_id ELSE e.source_entity_id END AS neighbor
  FROM bench_multihop_neural_edges e
  JOIN hop1 h ON e.source_entity_id = h.neighbor OR e.target_entity_id = h.neighbor
),
reachable AS (
  SELECT COUNT(DISTINCT n) AS reachable_from_5_seeds FROM (
    SELECT seed AS n FROM component_sample
    UNION SELECT neighbor FROM hop1
    UNION SELECT neighbor FROM hop2
  ) sub
),
-- 1-hop neighbor count for top-5 highest degree entities (PPR cost proxy)
top5_entities AS (
  SELECT id, name, degree FROM all_entities ORDER BY degree DESC LIMIT 5
),
top5_neighbor_counts AS (
  SELECT t.id, t.name, t.degree,
    (SELECT COUNT(DISTINCT n) FROM (
      SELECT e.target_entity_id AS n FROM bench_multihop_neural_edges e WHERE e.source_entity_id = t.id
      UNION SELECT e.source_entity_id FROM bench_multihop_neural_edges e WHERE e.target_entity_id = t.id
    ) sub) AS unique_neighbors
  FROM top5_entities t
)
SELECT 'degree_dist' AS section, bucket AS key1, cnt::text AS value1, '' AS value2 FROM degree_distribution
UNION ALL
SELECT 'degree_stats', 'avg_degree', avg_degree::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'median_degree', median_degree::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'p90_degree', p90_degree::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'p99_degree', p99_degree::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'max_degree', max_degree::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'hubs_gt_50', hubs_gt_50::text, '' FROM degree_stats
UNION ALL
SELECT 'degree_stats', 'isolated', isolated::text, '' FROM degree_stats
UNION ALL
SELECT 'component_estimate', 'reachable_from_5_seeds', reachable_from_5_seeds::text, '' FROM reachable
UNION ALL
SELECT 'top5_hubs', name, degree::text, unique_neighbors::text FROM top5_neighbor_counts
