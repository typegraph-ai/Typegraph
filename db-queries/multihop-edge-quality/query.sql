WITH relation_counts AS (
  SELECT relation, COUNT(*) AS cnt
  FROM bench_multihop_neural_edges
  GROUP BY relation
  ORDER BY cnt DESC
),
relation_stats AS (
  SELECT
    COUNT(DISTINCT relation) AS unique_relations,
    COUNT(*) AS total_edges
  FROM bench_multihop_neural_edges
),
generic_relations AS (
  SELECT COUNT(*) AS generic_count
  FROM bench_multihop_neural_edges
  WHERE relation IN ('RELATED_TO', 'HAS', 'IS', 'IS_A', 'HAS_A', 'ASSOCIATED_WITH', 'INVOLVES', 'INCLUDES', 'CONTAINS', 'IS_RELATED_TO')
),
weight_stats AS (
  SELECT
    ROUND(MIN(weight)::numeric, 4) AS min_weight,
    ROUND(MAX(weight)::numeric, 4) AS max_weight,
    ROUND(AVG(weight)::numeric, 4) AS avg_weight,
    ROUND(STDDEV(weight)::numeric, 4) AS stddev_weight,
    COUNT(*) FILTER (WHERE weight = 1.0) AS weight_eq_1,
    COUNT(*) FILTER (WHERE weight != 1.0) AS weight_ne_1
  FROM bench_multihop_neural_edges
),
provenance AS (
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE properties->>'content' IS NOT NULL AND properties->>'content' != '') AS has_content,
    COUNT(*) FILTER (WHERE properties->>'bucketId' IS NOT NULL) AS has_bucket,
    COUNT(*) FILTER (WHERE properties->>'chunkIndex' IS NOT NULL) AS has_chunk_index,
    ROUND(AVG(length(properties->>'content'))::numeric, 0) AS avg_content_len
  FROM bench_multihop_neural_edges
),
top_relations AS (
  SELECT relation, cnt FROM relation_counts LIMIT 30
)
SELECT 'relation_stats' AS section, 'unique_relations' AS key1, unique_relations::text AS value1, '' AS value2
  FROM relation_stats
UNION ALL
SELECT 'relation_stats', 'total_edges', total_edges::text, '' FROM relation_stats
UNION ALL
SELECT 'relation_stats', 'generic_count', generic_count::text, '' FROM generic_relations
UNION ALL
SELECT 'weight', 'min', min_weight::text, '' FROM weight_stats
UNION ALL
SELECT 'weight', 'max', max_weight::text, '' FROM weight_stats
UNION ALL
SELECT 'weight', 'avg', avg_weight::text, '' FROM weight_stats
UNION ALL
SELECT 'weight', 'stddev', stddev_weight::text, '' FROM weight_stats
UNION ALL
SELECT 'weight', 'count_eq_1', weight_eq_1::text, '' FROM weight_stats
UNION ALL
SELECT 'weight', 'count_ne_1', weight_ne_1::text, '' FROM weight_stats
UNION ALL
SELECT 'provenance', 'has_content', has_content::text, total::text FROM provenance
UNION ALL
SELECT 'provenance', 'has_bucket', has_bucket::text, total::text FROM provenance
UNION ALL
SELECT 'provenance', 'has_chunk_index', has_chunk_index::text, total::text FROM provenance
UNION ALL
SELECT 'provenance', 'avg_content_len', avg_content_len::text, '' FROM provenance
UNION ALL
SELECT 'top_relation', relation, cnt::text, '' FROM top_relations
