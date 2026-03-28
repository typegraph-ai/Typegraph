SELECT bucket_id, COUNT(*) AS cnt, MIN(indexed_at) AS earliest, MAX(indexed_at) AS latest
FROM d8um_hashes
GROUP BY bucket_id
ORDER BY cnt DESC
