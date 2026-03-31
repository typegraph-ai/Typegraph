-- Verify neural reseed edge properties (fixed column names)

-- 1. Sample edge properties — check for documentId, chunkIndex, metadata
SELECT id, source_entity_id, relation, properties::text
FROM bench_multihop_neural_edges
LIMIT 5;

-- 2. Count edges WITH vs WITHOUT documentId in properties
SELECT
  COUNT(*) FILTER (WHERE properties->>'documentId' IS NOT NULL) AS with_doc_id,
  COUNT(*) FILTER (WHERE properties->>'documentId' IS NULL) AS without_doc_id,
  COUNT(*) FILTER (WHERE properties->'metadata' IS NOT NULL) AS with_metadata,
  COUNT(*) AS total_edges
FROM bench_multihop_neural_edges;

-- 3. Entity embedding coverage
SELECT COUNT(*) AS total, COUNT(embedding) AS with_embedding,
  ROUND(COUNT(embedding)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS pct
FROM bench_multihop_neural_entities;

-- 4. Edge predicate distribution (CO_OCCURS should be 0)
SELECT relation, COUNT(*) FROM bench_multihop_neural_edges
GROUP BY relation ORDER BY COUNT(*) DESC LIMIT 15;

-- 5. Ingestion progress: hash entries + documents
SELECT COUNT(*) AS hash_entries FROM d8um_hashes WHERE bucket_id = 'dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc';

SELECT COUNT(*) AS docs, COUNT(*) FILTER (WHERE status = 'complete') AS complete
FROM d8um_documents WHERE bucket_id = 'dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc';

-- 6. Current table sizes
SELECT 'chunks' AS tbl, COUNT(*) AS cnt FROM bench_multihop_neural__gateway_openai_text_embedding_3_small
UNION ALL SELECT 'entities', COUNT(*) FROM bench_multihop_neural_entities
UNION ALL SELECT 'edges', COUNT(*) FROM bench_multihop_neural_edges;
