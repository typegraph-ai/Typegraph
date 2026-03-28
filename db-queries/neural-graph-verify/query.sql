SELECT 'license_memories' AS tbl, COUNT(*) AS rows FROM bench_license_neural_memories
UNION ALL SELECT 'license_entities', COUNT(*) FROM bench_license_neural_entities
UNION ALL SELECT 'license_edges', COUNT(*) FROM bench_license_neural_edges
UNION ALL SELECT 'au_tax_memories', COUNT(*) FROM bench_au_tax_neural_memories
UNION ALL SELECT 'au_tax_entities', COUNT(*) FROM bench_au_tax_neural_entities
UNION ALL SELECT 'au_tax_edges', COUNT(*) FROM bench_au_tax_neural_edges
