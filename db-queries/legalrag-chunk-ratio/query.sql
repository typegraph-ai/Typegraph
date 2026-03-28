SELECT 'chunks' AS metric, COUNT(*) AS count FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
UNION ALL
SELECT 'distinct_document_ids', COUNT(DISTINCT document_id) FROM bench_legalrag_core__gateway_openai_text_embedding_3_small
UNION ALL
SELECT 'documents_in_bucket', COUNT(*) FROM d8um_documents WHERE bucket_id = '785b3595-580f-4451-bc8d-1a934b598b20';
