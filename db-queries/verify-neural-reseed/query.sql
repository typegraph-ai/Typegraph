-- Verify neural reseed is populating edge properties correctly
-- Check that Phase 1 changes (documentId, chunkIndex, metadata in edges) are working

-- 1. Current table counts (are we ingesting?)
SELECT 'chunks' AS tbl, COUNT(*) AS cnt FROM bench_multihop_neural__gateway_openai_text_embedding_3_small
UNION ALL SELECT 'registry', COUNT(*) FROM bench_multihop_neural__registry
UNION ALL SELECT 'entities', COUNT(*) FROM bench_multihop_neural_entities
UNION ALL SELECT 'edges', COUNT(*) FROM bench_multihop_neural_edges
UNION ALL SELECT 'memories', COUNT(*) FROM bench_multihop_neural_memories;

-- 2. Sample edge properties — do they have documentId, chunkIndex, metadata?
SELECT id, subject_id, predicate, properties::text
FROM bench_multihop_neural_edges
ORDER BY created_at DESC LIMIT 5;

-- 3. Count edges WITH vs WITHOUT documentId in properties
SELECT
  COUNT(*) FILTER (WHERE properties->>'documentId' IS NOT NULL) AS with_doc_id,
  COUNT(*) FILTER (WHERE properties->>'documentId' IS NULL) AS without_doc_id,
  COUNT(*) FILTER (WHERE properties->>'chunkIndex' IS NOT NULL) AS with_chunk_idx,
  COUNT(*) FILTER (WHERE properties->>'metadata' IS NOT NULL) AS with_metadata,
  COUNT(*) AS total_edges
FROM bench_multihop_neural_edges;

-- 4. Entity embedding coverage (target: 100%)
SELECT COUNT(*) AS total_entities, COUNT(embedding) AS with_embedding,
  ROUND(COUNT(embedding)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS pct
FROM bench_multihop_neural_entities;

-- 5. Edge predicate distribution (CO_OCCURS should be 0)
SELECT predicate, COUNT(*) FROM bench_multihop_neural_edges
GROUP BY predicate ORDER BY COUNT(*) DESC LIMIT 15;

-- 6. Hash store entries for neural bucket (should be growing as docs complete)
SELECT COUNT(*) AS neural_hash_entries
FROM d8um_hashes
WHERE bucket_id = 'dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc';

-- 7. Document records for neural bucket
SELECT COUNT(*) AS doc_count, COUNT(*) FILTER (WHERE status = 'complete') AS complete
FROM d8um_documents
WHERE bucket_id = 'dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc';
