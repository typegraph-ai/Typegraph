-- Clear license-tldr neural data for reseed with 2048 chunk size
-- Bucket ID: f8ae6099-d491-40e9-98f9-4e908c06cbaa (name: license-tldr-neural)

TRUNCATE TABLE bench_license_neural__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_license_neural__registry;
TRUNCATE TABLE bench_license_neural_memories;
TRUNCATE TABLE bench_license_neural_entities;
TRUNCATE TABLE bench_license_neural_edges;
DELETE FROM d8um_hashes WHERE bucket_id = 'f8ae6099-d491-40e9-98f9-4e908c06cbaa';
DELETE FROM d8um_documents WHERE bucket_id = 'f8ae6099-d491-40e9-98f9-4e908c06cbaa';
