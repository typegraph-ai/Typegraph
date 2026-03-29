-- Inspect the 8 remaining duplicate pairs to understand WHY they weren't deduped
-- Look at name, entity_type, aliases for each duplicate set

SELECT name, entity_type, aliases, id
FROM bench_license_neural_entities
WHERE LOWER(name) IN ('licensed program', 'rsv', 'google', 'latex', 'jdk', 'oracle america, inc.', 'license agreement', 'cpal')
ORDER BY LOWER(name), id;
