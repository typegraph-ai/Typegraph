-- Clear license-tldr core data for reseed with 2048 chunk size
-- Bucket ID: 2c119c78-3318-4801-8041-9f755e680dec (name: license-tldr)

TRUNCATE TABLE bench_license_core__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_license_core__registry;
DELETE FROM d8um_hashes WHERE bucket_id = '2c119c78-3318-4801-8041-9f755e680dec';
DELETE FROM d8um_documents WHERE bucket_id = '2c119c78-3318-4801-8041-9f755e680dec';
