-- 015_align_intake_submission_status_default.sql
--
-- 014 renamed the opening status from 'in_progress' to 'intake' and tightened
-- intake_submissions_status_check to match, but left the column default at
-- 'in_progress'. The table was therefore self-contradictory: any insert that
-- omitted status took a default the check immediately rejected.
--
-- Nothing in the application hits that path — every writer names the status —
-- so this is not a live outage, but a default that cannot be used is a trap
-- for the next writer and for anything that inserts by hand.

alter table intake_submissions
  alter column status set default 'intake';
