SELECT 'chunks' AS label, COUNT(*) AS cnt FROM bench_license_core__gateway_openai_text_embedding_3_small
UNION ALL
SELECT 'with_corpusId', COUNT(*) FROM bench_license_core__gateway_openai_text_embedding_3_small WHERE metadata->>'corpusId' IS NOT NULL
UNION ALL
SELECT 'without_corpusId', COUNT(*) FROM bench_license_core__gateway_openai_text_embedding_3_small WHERE metadata->>'corpusId' IS NULL
UNION ALL
SELECT 'documents', COUNT(*) FROM d8um_documents
UNION ALL
SELECT 'hashes', COUNT(*) FROM d8um_hashes
UNION ALL
SELECT 'buckets', COUNT(*) FROM d8um_buckets
ORDER BY label;
