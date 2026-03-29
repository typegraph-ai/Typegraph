-- Clear multihop-rag neural data for reseed with embedding perf fix
-- Neural variant tables use prefix: bench_multihop_neural_
-- Bucket name: multihop-rag-neural
-- Perf: eliminated redundant embed() calls in entity resolver + predicate normalizer

TRUNCATE TABLE bench_multihop_neural__gateway_openai_text_embedding_3_small;
TRUNCATE TABLE bench_multihop_neural__registry;
TRUNCATE TABLE bench_multihop_neural_memories;
TRUNCATE TABLE bench_multihop_neural_entities;
TRUNCATE TABLE bench_multihop_neural_edges;
DELETE FROM d8um_hashes WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'multihop-rag-neural');
DELETE FROM d8um_documents WHERE bucket_id = (SELECT id FROM d8um_buckets WHERE name = 'multihop-rag-neural');
