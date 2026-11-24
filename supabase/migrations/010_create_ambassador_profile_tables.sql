-- 010_create_ambassador_profile_tables.sql
--
-- Recreates ambassador profile tables that are used by the frontend onboarding
-- flow, including RLS policies for authenticated users to manage only their own
-- rows.

create extension if not exists citext;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  phone text,
  first_name text,
  last_name text,
  preferred_name text,
  organization text,
  city text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists phone text;

create table if not exists public.user_roles (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role),
  constraint user_roles_role_check check (role in ('doctor', 'lawyer', 'brand_ambassador'))
);

create table if not exists public.ambassador_profiles (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  role_key text,
  display_name text,
  username citext,
  referral_link_key text,
  short_link text,
  qr_code_url text,
  provider_partner_id text,
  provider_link_id text,
  onboarding_status text not null default 'started',
  provisioning_status text not null default 'pending',
  provisioning_error_code text,
  provisioned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ambassador_profiles_role_key_check check (
    role_key is null or role_key in ('influencer', 'communityLeader', 'marketer', 'dj', 'promoter', 'artist', 'citizen', 'other')
  ),
  constraint ambassador_profiles_username_format_check check (
    username is null or username::text ~ '^[a-z0-9][a-z0-9._]{2,29}$'
  )
);

create unique index if not exists ambassador_profiles_username_unique
  on public.ambassador_profiles (username)
  where username is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_ambassador_profiles_updated_at on public.ambassador_profiles;
create trigger set_ambassador_profiles_updated_at
before update on public.ambassador_profiles
for each row
execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.ambassador_profiles enable row level security;

revoke all on public.profiles from anon;
revoke all on public.user_roles from anon;
revoke all on public.ambassador_profiles from anon;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.user_roles to authenticated;
grant select, insert, update on public.ambassador_profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own
on public.user_roles
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists user_roles_insert_own on public.user_roles;
create policy user_roles_insert_own
on public.user_roles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists ambassador_profiles_select_own on public.ambassador_profiles;
create policy ambassador_profiles_select_own
on public.ambassador_profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists ambassador_profiles_insert_own on public.ambassador_profiles;
create policy ambassador_profiles_insert_own
on public.ambassador_profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists ambassador_profiles_update_own on public.ambassador_profiles;
create policy ambassador_profiles_update_own
on public.ambassador_profiles
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
