-- Clear license-tldr neural data for reseed with fixed graph pipeline
-- Fixes: CO_OCCURS explosion, embedding COALESCE, HNSW index, entity dedup cache

TRUNCATE TABLE bench_license_neural__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_license_neural__registry;
TRUNCATE TABLE bench_license_neural_memories;
TRUNCATE TABLE bench_license_neural_entities;
TRUNCATE TABLE bench_license_neural_edges;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'license-tldr-neural');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'license-tldr-neural');
