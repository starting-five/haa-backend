-- 014_expand_intake_submission_statuses.sql
--
-- Consolidated status migration for claimant lifecycle:
-- 1) expand constraint to allow both legacy and new values,
-- 2) backfill legacy in_progress -> intake,
-- 3) tighten constraint to remove in_progress.
--
-- This keeps the migration idempotent enough for clean environments while also
-- completing the one-time data transition for existing rows.

alter table intake_submissions
  drop constraint if exists intake_submissions_status_check;

alter table intake_submissions
  add constraint intake_submissions_status_check
  check (
    status in (
      'in_progress',
      'intake',
      'submitted',
      'attorney',
      'doctor',
      'signed',
      'treating',
      'qualified',
      'not_qualified'
    )
  );

update intake_submissions
set status = 'intake'
where status = 'in_progress';

alter table intake_submissions
  drop constraint if exists intake_submissions_status_check;

alter table intake_submissions
  add constraint intake_submissions_status_check
  check (
    status in (
      'intake',
      'submitted',
      'attorney',
      'doctor',
      'signed',
      'treating',
      'qualified',
      'not_qualified'
    )
  );
