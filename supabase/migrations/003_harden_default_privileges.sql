-- 003_harden_default_privileges.sql
--
-- Stops future objects in the public schema from being granted to anon and
-- authenticated automatically.
--
-- Migration 002 revoked the client grants from the seven tables that existed at
-- the time. It did not change the *default* privileges, which is where the
-- exposure actually originates: Supabase ships this project with default ACLs
-- that grant anon and authenticated every table privilege on anything created
-- afterwards in public, plus EXECUTE on functions and full access on sequences.
--
--   default for role postgres, schema public, tables
--     -> anon=arwdDxtm, authenticated=arwdDxtm
--
-- The practical effect is that 002 was a one-time cleanup rather than a policy.
-- The next migration that adds a table would silently reopen the same hole,
-- because the grant is applied at CREATE time by Postgres and nothing in the
-- repository would flag it. This migration makes default-deny the standing rule
-- so a new table is closed unless someone opens it deliberately.
--
-- Functions are revoked from PUBLIC as well as from anon and authenticated,
-- because Postgres grants EXECUTE to PUBLIC on every new function by default --
-- revoking the two Supabase roles alone would leave that path open.
--
-- Only the defaults owned by role postgres are changed here. The same schema
-- also carries defaults owned by supabase_admin, which cannot be altered from
-- this connection (postgres is not a member of supabase_admin). Those apply
-- only to objects created *by* supabase_admin, which no application migration
-- does, so the operative path is covered. The residual is recorded in the
-- security report as an admin-only action.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke all on types from anon, authenticated, public;
