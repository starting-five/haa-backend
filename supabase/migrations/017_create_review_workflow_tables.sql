-- 017_create_review_workflow_tables.sql
--
-- Adds tables required for the lawyer review workflow:
-- 1) review_assignments: case handoff records (admin -> lawyer)
-- 2) review_decision_events: immutable decision audit log

create table if not exists review_assignments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  assigned_by_user_id uuid not null,
  assigned_lawyer_user_id uuid,
  assignment_mode text not null default 'invite_link',
  status text not null default 'pending',
  review_link_token_hash text,
  expires_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_assignments_mode_check
    check (assignment_mode in ('internal_user', 'invite_link')),
  constraint review_assignments_status_check
    check (status in ('pending', 'accepted', 'rejected', 'expired', 'revoked'))
);

create index if not exists idx_review_assignments_submission_id
  on review_assignments(submission_id);

create index if not exists idx_review_assignments_status
  on review_assignments(status);

create unique index if not exists idx_review_assignments_pending_per_submission
  on review_assignments(submission_id)
  where status = 'pending';

create unique index if not exists idx_review_assignments_token_hash
  on review_assignments(review_link_token_hash)
  where review_link_token_hash is not null;

create table if not exists review_decision_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  assignment_id uuid references review_assignments(id) on delete set null,
  claimant_user_id uuid not null,
  actor_user_id uuid not null,
  actor_role text not null,
  action text not null,
  previous_status text,
  next_status text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint review_decision_events_actor_role_check
    check (actor_role in ('admin', 'lawyer')),
  constraint review_decision_events_action_check
    check (action in ('pass_to_lawyer', 'accept_case', 'reject_case', 'reopen_case'))
);

create index if not exists idx_review_decision_events_submission_id_created_at
  on review_decision_events(submission_id, created_at desc);

create index if not exists idx_review_decision_events_actor_user_id
  on review_decision_events(actor_user_id);

create index if not exists idx_review_decision_events_assignment_id
  on review_decision_events(assignment_id);

create index if not exists idx_review_decision_events_action_created_at
  on review_decision_events(action, created_at desc);

-- set_updated_at is created in 010_create_ambassador_profile_tables.sql
-- and may not exist in older manually-provisioned environments.
do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'set_updated_at'
      and pg_function_is_visible(oid)
  ) then
    if not exists (
      select 1
      from pg_trigger
      where tgname = 'set_review_assignments_updated_at'
    ) then
      create trigger set_review_assignments_updated_at
      before update on review_assignments
      for each row
      execute function public.set_updated_at();
    end if;
  end if;
end;
$$;

alter table review_assignments enable row level security;
alter table review_decision_events enable row level security;

revoke all on review_assignments from anon, authenticated;
revoke all on review_decision_events from anon, authenticated;
