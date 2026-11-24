-- 002_enable_row_level_security.sql
--
-- Closes the public exposure of the application tables.
--
-- Every table in this schema was created without row-level security and with the
-- default Supabase grants, which give anon and authenticated full DML. Because
-- the Data API exposes the public schema, that made every row readable and
-- writable by anyone holding the publishable key -- and that key is shipped in
-- the browser bundle, so it is public by design.
--
-- The application does not need direct client access to any of these tables. The
-- frontend talks only to the backend API and to Storage; every table operation
-- happens server-side under the service-role key, which bypasses row-level
-- security. Default-deny is therefore the correct posture: enable RLS and add no
-- policies, so anon and authenticated match nothing while the backend is
-- unaffected.
--
-- Grants are revoked as well as enabling RLS, for two reasons. Revoking is
-- defence in depth if a permissive policy is ever added by mistake, and row-level
-- security does not restrict every statement type -- the table-wide privileges
-- have to go for the tables to be genuinely closed.
--
-- Idempotent: enabling RLS that is already enabled and revoking privileges that
-- are already absent are both no-ops.

alter table claimants             enable row level security;
alter table intake_submissions    enable row level security;
alter table accidents             enable row level security;
alter table documents             enable row level security;
alter table submission_companions enable row level security;
alter table lawyers               enable row level security;
alter table haa_schema_migrations enable row level security;

revoke all on claimants             from anon, authenticated;
revoke all on intake_submissions    from anon, authenticated;
revoke all on accidents             from anon, authenticated;
revoke all on documents             from anon, authenticated;
revoke all on submission_companions from anon, authenticated;
revoke all on lawyers               from anon, authenticated;
revoke all on haa_schema_migrations from anon, authenticated;

-- service_role keeps the privileges the backend depends on and is untouched here.
-- Storage is deliberately not modified: the submissions bucket is already private
-- and storage.objects already carries an insert-only policy for the intake upload.
