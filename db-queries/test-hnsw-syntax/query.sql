-- Test HNSW index creation approaches on the entity table
-- The table uses untyped VECTOR column

-- Check current column type
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_name = 'bench_license_neural_entities' AND column_name = 'embedding';

-- Check pgvector version
SELECT extversion FROM pg_extension WHERE extname = 'vector';

-- Try approach 1: expression-based index with cast
-- CREATE INDEX IF NOT EXISTS bench_license_neural_entities_hnsw_test1
--   ON bench_license_neural_entities USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
--   WITH (m = 16, ef_construction = 200);

-- Try approach 2: alter column to typed vector first, then create index
ALTER TABLE bench_license_neural_entities ALTER COLUMN embedding TYPE vector(1536);

CREATE INDEX IF NOT EXISTS bench_license_neural_entities_embedding_idx
  ON bench_license_neural_entities USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Verify index was created
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'bench_license_neural_entities' AND indexname LIKE '%embedding%';
