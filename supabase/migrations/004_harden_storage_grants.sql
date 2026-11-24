-- 004_harden_storage_grants.sql
--
-- Reduces the client roles to the single Storage capability the intake flow
-- actually needs.
--
-- The browser uploads evidence directly to Storage with the publishable key, so
-- anon genuinely needs to insert into storage.objects. It does not need
-- anything else, but the stock grants give anon and authenticated the full set
-- on storage.objects and storage.buckets -- including the table-emptying
-- privilege, which row-level security does not restrain. Nothing in the Data
-- API can reach that privilege today, so this is defence in depth rather than
-- a live hole, but there is no reason for a browser role to hold it.
--
-- What the application relies on, confirmed by probing the running site:
--   * insert into storage.objects, gated by the "intake anon upload" policy
--     which is scoped to bucket_id = 'submissions'
--   * select on storage.buckets, so the client can resolve the bucket
--     (row-level security still returns nothing, which is why an anonymous
--     bucket listing comes back as an empty array)
--
-- select is retained on storage.objects because the upload path reads the row
-- back; row-level security has no select policy, so an anonymous read still
-- returns nothing. Update and delete are dropped: both were already refused by
-- row-level security, and removing the grant turns a policy refusal into a
-- privilege refusal, one layer earlier.
--
-- buckets_analytics is an unused Supabase feature that carries the same broad
-- client grants; nothing in this project writes to it.
--
-- Written as revoke-then-grant rather than naming individual privileges so the
-- result is an exact allowlist rather than a subtraction that has to be kept in
-- step with whatever Supabase adds later.
--
-- Note for reviewers: storage is a platform-managed schema. A future Supabase
-- upgrade may reassert its own grants here, so this migration is not
-- self-defending -- the security report lists a periodic re-check.

revoke all on storage.buckets from anon, authenticated;
grant select on storage.buckets to anon, authenticated;

revoke all on storage.objects from anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;

revoke all on storage.buckets_analytics from anon, authenticated;
