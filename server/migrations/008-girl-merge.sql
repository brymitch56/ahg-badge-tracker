-- 008-girl-merge: duplicate girl records merged from the admin screen
-- (server/lib/girlmerge.js). The merged-away record is kept for history:
-- inactive, status 'merged', and pointing at the record that took its data.
ALTER TABLE girls ADD COLUMN merged_into_girl_id INTEGER REFERENCES girls(id);
