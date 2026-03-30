-- Check if the bucket still exists and verify hash entries
SELECT id, name FROM d8um_buckets WHERE name = 'multihop-rag-neural';

-- Count remaining hash entries that reference this bucket
SELECT COUNT(*) AS hash_count FROM d8um_hashes WHERE bucket_id IN (SELECT id FROM d8um_buckets WHERE name = 'multihop-rag-neural');

-- Check if hashes might be stored differently (check a sample)
SELECT bucket_id, COUNT(*) FROM d8um_hashes GROUP BY bucket_id ORDER BY COUNT(*) DESC LIMIT 5;
