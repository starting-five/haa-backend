-- 021_create_case_notifications.sql
--
-- Delivery log for case lifecycle notifications (currently SMS).
--
-- The table is both an audit trail and an idempotency guard:
-- one successful send per submission/event/channel/recipient.

create table if not exists case_notifications (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  event_type text not null,
  channel text not null check (channel in ('sms')),
  recipient text not null,
  message_body text,
  status text not null check (status in ('sent', 'failed')),
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_case_notifications_submission_id
  on case_notifications(submission_id);

create index if not exists idx_case_notifications_created_at
  on case_notifications(created_at desc);

create unique index if not exists uq_case_notifications_sent_once
  on case_notifications(submission_id, event_type, channel, recipient)
  where status = 'sent';

alter table case_notifications enable row level security;
revoke all on case_notifications from anon, authenticated;
