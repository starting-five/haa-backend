-- 005_constrain_status_and_locale.sql
--
-- Adds value constraints to the three columns whose valid set is fixed and
-- verifiable from the application source.
--
-- None of the enum-like columns in this schema are constrained, so the database
-- accepts anything the API sends. That is not theoretical: probing the intake
-- API with deliberately invalid values wrote incident_type = 'spaceship' and
-- role = 'astronaut' into accidents, and both were accepted with HTTP 200.
--
-- Only three columns are constrained here, and deliberately so:
--
--   intake_submissions.status      written by the backend only, and only ever
--                                  as 'in_progress' (intake.ts:60) or
--                                  'submitted' (intake.ts:144)
--   intake_submissions.locale      derived from the route locale segment
--   claimants.preferred_language   set from the same locale segment
--
-- incident_type, role, relation and documents.category are deliberately left
-- unconstrained. Their option sets live in the UI rather than in a shared
-- constant, so pinning them in the database risks rejecting a value the product
-- legitimately adds later. The correct fix for those is request validation in
-- the backend, which currently casts the request body without parsing it
-- (intake.ts:89, `req.body as CompleteIntakePayload`); that is recorded in the
-- security report as an application change rather than forced in here.
--
-- Existing rows were checked before writing this migration: status holds only
-- in_progress and submitted, locale and preferred_language only 'en'. Nothing
-- currently violates these constraints, so the migration cannot fail on data.
--
-- not valid is not used: the intent is to reject bad values from now on *and*
-- to assert the existing rows are clean.

alter table intake_submissions
  add constraint intake_submissions_status_check
  check (status in ('in_progress', 'submitted'));

alter table intake_submissions
  add constraint intake_submissions_locale_check
  check (locale in ('en', 'es'));

alter table claimants
  add constraint claimants_preferred_language_check
  check (preferred_language in ('en', 'es'));
