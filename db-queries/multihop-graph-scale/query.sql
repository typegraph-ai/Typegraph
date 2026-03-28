WITH counts AS (
  SELECT
    (SELECT COUNT(*) FROM bench_multihop_neural_entities) AS entity_count,
    (SELECT COUNT(*) FROM bench_multihop_neural_edges) AS edge_count,
    (SELECT COUNT(*) FROM bench_multihop_neural_memories) AS memory_count,
    (SELECT COUNT(*) FROM bench_multihop_neural_gateway_openai_text_embedding_3_small) AS chunk_count,
    (SELECT COUNT(DISTINCT document_id) FROM bench_multihop_neural_gateway_openai_text_embedding_3_small) AS document_count
),
entity_types AS (
  SELECT entity_type, COUNT(*) AS cnt
  FROM bench_multihop_neural_entities
  GROUP BY entity_type
  ORDER BY cnt DESC
),
memory_categories AS (
  SELECT category, COUNT(*) AS cnt
  FROM bench_multihop_neural_memories
  GROUP BY category
  ORDER BY cnt DESC
),
ratios AS (
  SELECT
    ROUND(entity_count::numeric / NULLIF(document_count, 0), 2) AS entities_per_doc,
    ROUND(edge_count::numeric / NULLIF(entity_count, 0), 2) AS edges_per_entity,
    ROUND(chunk_count::numeric / NULLIF(document_count, 0), 2) AS chunks_per_doc,
    ROUND(edge_count::numeric / NULLIF(chunk_count, 0), 2) AS edges_per_chunk
  FROM counts
)
SELECT 'scale' AS section, 'entity_count' AS metric, entity_count::text AS value FROM counts
UNION ALL SELECT 'scale', 'edge_count', edge_count::text FROM counts
UNION ALL SELECT 'scale', 'memory_count', memory_count::text FROM counts
UNION ALL SELECT 'scale', 'chunk_count', chunk_count::text FROM counts
UNION ALL SELECT 'scale', 'document_count', document_count::text FROM counts
UNION ALL SELECT 'ratio', 'entities_per_doc', entities_per_doc::text FROM ratios
UNION ALL SELECT 'ratio', 'edges_per_entity', edges_per_entity::text FROM ratios
UNION ALL SELECT 'ratio', 'chunks_per_doc', chunks_per_doc::text FROM ratios
UNION ALL SELECT 'ratio', 'edges_per_chunk', edges_per_chunk::text FROM ratios
UNION ALL SELECT 'entity_type', entity_type, cnt::text FROM entity_types
UNION ALL SELECT 'memory_category', category, cnt::text FROM memory_categories
