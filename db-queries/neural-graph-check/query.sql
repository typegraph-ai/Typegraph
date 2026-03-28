-- Check if graph tables exist and have data for license-tldr neural benchmark
-- Tables should be: bench_license_neural_memories, bench_license_neural_entities, bench_license_neural_edges

SELECT 'memories' AS table_name, COUNT(*) AS row_count FROM bench_license_neural_memories
UNION ALL
SELECT 'entities' AS table_name, COUNT(*) AS row_count FROM bench_license_neural_entities
UNION ALL
SELECT 'edges' AS table_name, COUNT(*) AS row_count FROM bench_license_neural_edges;
