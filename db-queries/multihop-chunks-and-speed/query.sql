WITH chunk_stats AS (
  SELECT
    COUNT(*) AS total_chunks,
    COUNT(DISTINCT document_id) AS distinct_docs,
    COUNT(DISTINCT bucket_id) AS distinct_buckets,
    ROUND(AVG(length(content))::numeric, 0) AS avg_content_len,
    ROUND(AVG(total_chunks)::numeric, 1) AS avg_chunks_per_doc,
    MIN(total_chunks) AS min_chunks_per_doc,
    MAX(total_chunks) AS max_chunks_per_doc
  FROM bench_multihop_neural__gateway_openai_text_embedding_3_small
),
chunk_len_distribution AS (
  SELECT
    CASE
      WHEN length(content) < 500 THEN 'lt_500'
      WHEN length(content) < 1000 THEN '500-999'
      WHEN length(content) < 1500 THEN '1000-1499'
      WHEN length(content) < 2000 THEN '1500-1999'
      ELSE '2000+'
    END AS bucket,
    COUNT(*) AS cnt
  FROM bench_multihop_neural__gateway_openai_text_embedding_3_small
  GROUP BY bucket
),
edge_fanout AS (
  SELECT entity_id, SUM(cnt) AS degree FROM (
    SELECT source_entity_id AS entity_id, COUNT(*) AS cnt FROM bench_multihop_neural_edges GROUP BY source_entity_id
    UNION ALL
    SELECT target_entity_id, COUNT(*) FROM bench_multihop_neural_edges GROUP BY target_entity_id
  ) sub
  GROUP BY entity_id
),
fanout_percentiles AS (
  SELECT
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY degree) AS p25,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY degree) AS p50,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY degree) AS p75,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY degree) AS p90,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY degree) AS p95
  FROM edge_fanout
),
seed_cost_estimate AS (
  SELECT
    ROUND((p50 * 10)::numeric, 0) AS est_1hop_edges_10_median_seeds,
    ROUND((p75 * 10)::numeric, 0) AS est_1hop_edges_10_p75_seeds,
    ROUND((p90 * 10)::numeric, 0) AS est_1hop_edges_10_p90_seeds
  FROM fanout_percentiles
),
index_info AS (
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'bench_multihop_neural_entities'
),
embedding_coverage AS (
  SELECT
    COUNT(*) AS total_entities,
    COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS entities_with_embedding
  FROM bench_multihop_neural_entities
)
SELECT 'chunk_stats' AS section, 'total_chunks' AS key1, total_chunks::text AS value1, '' AS value2 FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'distinct_docs', distinct_docs::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'distinct_buckets', distinct_buckets::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'avg_content_len', avg_content_len::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'avg_chunks_per_doc', avg_chunks_per_doc::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'min_chunks_per_doc', min_chunks_per_doc::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_stats', 'max_chunks_per_doc', max_chunks_per_doc::text, '' FROM chunk_stats
UNION ALL SELECT 'chunk_len_dist', bucket, cnt::text, '' FROM chunk_len_distribution
UNION ALL SELECT 'fanout_percentile', 'p25', p25::text, '' FROM fanout_percentiles
UNION ALL SELECT 'fanout_percentile', 'p50', p50::text, '' FROM fanout_percentiles
UNION ALL SELECT 'fanout_percentile', 'p75', p75::text, '' FROM fanout_percentiles
UNION ALL SELECT 'fanout_percentile', 'p90', p90::text, '' FROM fanout_percentiles
UNION ALL SELECT 'fanout_percentile', 'p95', p95::text, '' FROM fanout_percentiles
UNION ALL SELECT 'seed_cost', 'est_1hop_10_median', est_1hop_edges_10_median_seeds::text, '' FROM seed_cost_estimate
UNION ALL SELECT 'seed_cost', 'est_1hop_10_p75', est_1hop_edges_10_p75_seeds::text, '' FROM seed_cost_estimate
UNION ALL SELECT 'seed_cost', 'est_1hop_10_p90', est_1hop_edges_10_p90_seeds::text, '' FROM seed_cost_estimate
UNION ALL SELECT 'entity_index', indexname, indexdef, '' FROM index_info
UNION ALL SELECT 'embedding_coverage', 'total', total_entities::text, '' FROM embedding_coverage
UNION ALL SELECT 'embedding_coverage', 'with_embedding', entities_with_embedding::text, '' FROM embedding_coverage
