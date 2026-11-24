-- 023_add_review_decision_deadline.sql
--
-- Separates the lawyer review link lifetime from the lawyer decision window.
-- expires_at keeps the link open/closed, while decision_expires_at controls
-- whether Accept or Reject may still be submitted.

alter table public.review_assignments
  add column if not exists decision_expires_at timestamptz;

create index if not exists idx_review_assignments_decision_expires_at
  on public.review_assignments(decision_expires_at);

update public.review_assignments
set decision_expires_at = created_at + interval '30 minutes'
where status = 'pending'
  and decision_expires_at is null;

do $$
begin
  if to_regclass('public.admin_users') is not null then
    grant select, insert, update, delete on table public.review_assignments to authenticated;

    drop policy if exists review_assignments_select_admin on public.review_assignments;
    create policy review_assignments_select_admin
    on public.review_assignments
    for select
    to authenticated
    using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

    drop policy if exists review_assignments_update_admin on public.review_assignments;
    create policy review_assignments_update_admin
    on public.review_assignments
    for update
    to authenticated
    using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))
    with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

    drop policy if exists review_assignments_insert_admin on public.review_assignments;
    create policy review_assignments_insert_admin
    on public.review_assignments
    for insert
    to authenticated
    with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())));

    drop policy if exists review_assignments_delete_admin on public.review_assignments;
    create policy review_assignments_delete_admin
    on public.review_assignments
    for delete
    to authenticated
    using (exists (select 1 from public.admin_users where user_id = (select auth.uid())));
  end if;
end $$;
