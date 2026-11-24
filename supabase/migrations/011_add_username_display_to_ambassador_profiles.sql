-- 011_add_username_display_to_ambassador_profiles.sql
--
-- Adds a display-form username that preserves user-entered casing while
-- canonical lowercase username remains the unique comparison key.

alter table public.ambassador_profiles
  add column if not exists username_display text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ambassador_profiles_username_display_format_check'
      and conrelid = 'public.ambassador_profiles'::regclass
  ) then
    alter table public.ambassador_profiles
      add constraint ambassador_profiles_username_display_format_check
      check (
        username_display is null or username_display ~ '^[A-Za-z0-9][A-Za-z0-9._]{2,29}$'
      );
  end if;
end
$$;
