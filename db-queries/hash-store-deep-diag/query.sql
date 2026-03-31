-- Deep diagnostic: understand hash store state for multihop-rag buckets

-- 1. All buckets with their UUIDs
SELECT id, name FROM d8um_buckets WHERE name LIKE 'multihop%' ORDER BY name;

-- 2. Hash entries grouped by bucket_id, joined with bucket names
SELECT h.bucket_id, b.name AS bucket_name, COUNT(*) AS hash_count
FROM d8um_hashes h
LEFT JOIN d8um_buckets b ON h.bucket_id = b.id
GROUP BY h.bucket_id, b.name
ORDER BY hash_count DESC;

-- 3. Sample store_key values (to see the format and which bucket UUID is embedded)
SELECT store_key, bucket_id, content_hash, embedding_model
FROM d8um_hashes
WHERE bucket_id IN (SELECT id FROM d8um_buckets WHERE name LIKE 'multihop%')
LIMIT 5;

-- 4. Check if there are hash entries where store_key CONTAINS the neural bucket UUID
SELECT COUNT(*) AS neural_store_key_count
FROM d8um_hashes
WHERE store_key LIKE '%dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc%';

-- 5. Check neural chunk/entity/edge table counts (are they really empty after TRUNCATE?)
SELECT 'chunks' AS tbl, COUNT(*) AS cnt FROM bench_multihop_neural__gateway_openai_text_embedding_3_small
UNION ALL SELECT 'registry', COUNT(*) FROM bench_multihop_neural__registry
UNION ALL SELECT 'entities', COUNT(*) FROM bench_multihop_neural_entities
UNION ALL SELECT 'edges', COUNT(*) FROM bench_multihop_neural_edges
UNION ALL SELECT 'memories', COUNT(*) FROM bench_multihop_neural_memories;

-- 6. Check d8um_documents for neural bucket
SELECT COUNT(*) AS doc_count FROM d8um_documents WHERE bucket_id = 'dc4b61c6-44ac-4eed-9abc-a199fc4b7bbc';
