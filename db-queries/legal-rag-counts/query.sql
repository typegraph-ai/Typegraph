-- Count documents and chunks for legal-rag-bench, and check metadata propagation
SELECT 'documents' AS table_name, COUNT(*) AS row_count FROM bench_legalrag_core__documents
UNION ALL
SELECT 'chunks', COUNT(*) FROM bench_legalrag_core__model_1
UNION ALL
SELECT 'chunks_with_corpusId', COUNT(*) FROM bench_legalrag_core__model_1 WHERE metadata->>'corpusId' IS NOT NULL
UNION ALL
SELECT 'chunks_without_corpusId', COUNT(*) FROM bench_legalrag_core__model_1 WHERE metadata->>'corpusId' IS NULL
UNION ALL
SELECT 'hashes', COUNT(*) FROM d8um_hashes WHERE store_key LIKE '%legalrag%'
ORDER BY table_name;
