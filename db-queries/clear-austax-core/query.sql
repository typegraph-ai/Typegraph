-- Clear australian-tax core data for reseed with 2048 chunk size
-- Table prefix: bench_au_tax_core_, Bucket name: au-tax-guidance

TRUNCATE TABLE bench_au_tax_core__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_au_tax_core__registry;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'au-tax-guidance');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'au-tax-guidance');
