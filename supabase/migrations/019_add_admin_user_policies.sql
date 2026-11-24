-- 018_add_admin_user_policies.sql
--
-- Allows authenticated users listed in public.admin_users to read, edit, and
-- delete rows used by the admin dashboard.
--
-- Review workflow tables are optional here. If that branch has already been
-- applied, this migration grants admin access to those tables too. If not, it
-- skips them so the admin user policies can still be deployed from main.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;
grant select on public.admin_users to authenticated;

drop policy if exists admin_users_select_self on public.admin_users;
create policy admin_users_select_self
on public.admin_users
for select
to authenticated
using ((select auth.uid()) = user_id);

do $$
declare
  table_name text;
  dashboard_tables text[] := array[
    'claimants',
    'intake_submissions',
    'accidents',
    'documents',
    'submission_companions',
    'agreements',
    'lawyers',
    'profiles',
    'user_roles',
    'ambassador_profiles'
  ];
  optional_dashboard_tables text[] := array[
    'review_assignments',
    'review_decision_events'
  ];
begin
  foreach table_name in array dashboard_tables loop
    execute format('grant select, update, delete on table public.%I to authenticated', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || '_select_admin', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_select_admin',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_update_admin', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid()))) with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_update_admin',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_delete_admin', table_name);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_delete_admin',
      table_name
    );
  end loop;

  foreach table_name in array optional_dashboard_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise notice 'Skipping admin policies for missing optional table public.%', table_name;
      continue;
    end if;

    execute format('grant select, update, delete on table public.%I to authenticated', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || '_select_admin', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_select_admin',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_update_admin', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid()))) with check (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_update_admin',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_delete_admin', table_name);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (exists (select 1 from public.admin_users where user_id = (select auth.uid())))',
      table_name || '_delete_admin',
      table_name
    );
  end loop;
end $$;
