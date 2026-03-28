SELECT bucket_id, COUNT(*) AS cnt FROM d8um_hashes GROUP BY bucket_id ORDER BY cnt DESC
