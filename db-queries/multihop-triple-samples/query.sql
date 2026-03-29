WITH edge_samples AS (
  SELECT e.relation,
         src.name AS source_name, src.entity_type AS source_type,
         tgt.name AS target_name, tgt.entity_type AS target_type,
         LEFT(e.properties->>'content', 150) AS chunk_snippet
  FROM bench_multihop_neural_edges e
  JOIN bench_multihop_neural_entities src ON src.id = e.source_entity_id
  JOIN bench_multihop_neural_entities tgt ON tgt.id = e.target_entity_id
  ORDER BY RANDOM()
  LIMIT 20
),
other_entities AS (
  SELECT name, COALESCE(array_length(aliases, 1), 0) AS alias_count,
         LEFT(array_to_string(aliases, ' | '), 100) AS sample_aliases
  FROM bench_multihop_neural_entities
  WHERE entity_type = 'other'
  ORDER BY RANDOM()
  LIMIT 15
),
memory_samples AS (
  SELECT category, subject, predicate, object, ROUND(confidence::numeric, 3) AS confidence,
         LEFT(content, 120) AS content_snippet
  FROM bench_multihop_neural_memories
  WHERE subject IS NOT NULL
  ORDER BY RANDOM()
  LIMIT 15
)
SELECT 'edge_sample' AS section, source_name AS col1, relation AS col2, target_name AS col3, source_type AS col4, target_type AS col5, chunk_snippet AS col6
  FROM edge_samples
UNION ALL
SELECT 'other_entity', name, alias_count::text, sample_aliases, '', '', '' FROM other_entities
UNION ALL
SELECT 'memory_sample', subject, predicate, object, confidence::text, category, content_snippet FROM memory_samples
