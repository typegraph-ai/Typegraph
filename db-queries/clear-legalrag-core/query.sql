-- Clear legal-rag-bench core data for reseed with 2048 chunk size
-- Bucket ID: 785b3595-580f-4451-bc8d-1a934b598b20 (name: legal-rag-bench)

TRUNCATE TABLE bench_legalrag_core__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_legalrag_core__registry;
DELETE FROM d8um_hashes WHERE bucket_id = '785b3595-580f-4451-bc8d-1a934b598b20';
DELETE FROM d8um_documents WHERE bucket_id = '785b3595-580f-4451-bc8d-1a934b598b20';
