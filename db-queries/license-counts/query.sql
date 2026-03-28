SELECT 'documents' AS label, COUNT(*) AS cnt FROM d8um_documents WHERE id IN (SELECT DISTINCT document_id FROM bench_license_core__model_1)
UNION ALL
SELECT 'chunks', COUNT(*) FROM bench_license_core__model_1
UNION ALL
SELECT 'chunks_with_corpusId', COUNT(*) FROM bench_license_core__model_1 WHERE metadata->>'corpusId' IS NOT NULL
UNION ALL
SELECT 'chunks_without_corpusId', COUNT(*) FROM bench_license_core__model_1 WHERE metadata->>'corpusId' IS NULL
UNION ALL
SELECT 'hashes', COUNT(*) FROM d8um_hashes WHERE store_key LIKE '%license%'
ORDER BY label;
