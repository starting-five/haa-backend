-- 022_add_retainer_pending_status.sql
--
-- Adds a dedicated status for cases approved by admin and waiting for
-- patient retainer signature, and allows the corresponding admin action in
-- review decision events.

alter table intake_submissions
  drop constraint if exists intake_submissions_status_check;

alter table intake_submissions
  add constraint intake_submissions_status_check
  check (
    status in (
      'intake',
      'submitted',
      'retainer_pending_signature',
      'attorney',
      'doctor',
      'signed',
      'treating',
      'qualified',
      'not_qualified'
    )
  );

alter table review_decision_events
  drop constraint if exists review_decision_events_action_check;

alter table review_decision_events
  add constraint review_decision_events_action_check
  check (action in ('pass_to_lawyer', 'approve_for_retainer', 'accept_case', 'reject_case', 'reopen_case'));