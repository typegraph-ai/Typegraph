WITH degree AS (
  SELECT entity_id, SUM(cnt) AS degree FROM (
    SELECT source_entity_id AS entity_id, COUNT(*) AS cnt FROM bench_multihop_neural_edges GROUP BY source_entity_id
    UNION ALL
    SELECT target_entity_id, COUNT(*) FROM bench_multihop_neural_edges GROUP BY target_entity_id
  ) sub
  GROUP BY entity_id
),
entity_with_degree AS (
  SELECT e.id, e.name, e.entity_type, COALESCE(array_length(e.aliases, 1), 0) AS alias_count,
         COALESCE(d.degree, 0) AS degree, length(e.name) AS name_len
  FROM bench_multihop_neural_entities e
  LEFT JOIN degree d ON d.entity_id = e.id
),
name_len_buckets AS (
  SELECT
    CASE
      WHEN name_len <= 3 THEN '1-3_chars'
      WHEN name_len <= 10 THEN '4-10_chars'
      WHEN name_len <= 20 THEN '11-20_chars'
      WHEN name_len <= 40 THEN '21-40_chars'
      ELSE '41+_chars'
    END AS bucket,
    COUNT(*) AS cnt
  FROM entity_with_degree
  GROUP BY bucket
),
alias_stats AS (
  SELECT
    ROUND(AVG(alias_count), 2) AS avg_aliases,
    MAX(alias_count) AS max_aliases,
    COUNT(*) FILTER (WHERE alias_count = 0) AS entities_no_aliases,
    COUNT(*) FILTER (WHERE alias_count >= 3) AS entities_3plus_aliases
  FROM entity_with_degree
),
top_by_degree AS (
  SELECT name, entity_type, degree, alias_count
  FROM entity_with_degree
  ORDER BY degree DESC
  LIMIT 25
),
top_by_aliases AS (
  SELECT e.name, e.entity_type, COALESCE(array_length(e.aliases, 1), 0) AS alias_count,
         array_to_string(e.aliases[1:10], ' | ') AS sample_aliases
  FROM bench_multihop_neural_entities e
  WHERE COALESCE(array_length(e.aliases, 1), 0) >= 3
  ORDER BY COALESCE(array_length(e.aliases, 1), 0) DESC
  LIMIT 15
),
potential_dupes AS (
  SELECT a.id AS id_a, a.name AS name_a, b.id AS id_b, b.name AS name_b,
         a.entity_type AS type_a, b.entity_type AS type_b
  FROM bench_multihop_neural_entities a
  JOIN bench_multihop_neural_entities b ON a.id < b.id
    AND LOWER(TRIM(a.name)) = LOWER(TRIM(b.name))
  LIMIT 20
)
SELECT 'name_length' AS section, bucket AS key1, '' AS key2, cnt::text AS value, '' AS extra
  FROM name_len_buckets
UNION ALL
SELECT 'alias_stats', 'avg_aliases', '', avg_aliases::text, '' FROM alias_stats
UNION ALL
SELECT 'alias_stats', 'max_aliases', '', max_aliases::text, '' FROM alias_stats
UNION ALL
SELECT 'alias_stats', 'entities_no_aliases', '', entities_no_aliases::text, '' FROM alias_stats
UNION ALL
SELECT 'alias_stats', 'entities_3plus_aliases', '', entities_3plus_aliases::text, '' FROM alias_stats
UNION ALL
SELECT 'top_degree', name, entity_type, degree::text, alias_count::text FROM top_by_degree
UNION ALL
SELECT 'top_aliases', name, entity_type, alias_count::text, sample_aliases FROM top_by_aliases
UNION ALL
SELECT 'potential_dupes', name_a, name_b, type_a, type_b FROM potential_dupes
