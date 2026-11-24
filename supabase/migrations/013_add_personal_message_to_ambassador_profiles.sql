-- 013_add_personal_message_to_ambassador_profiles.sql
--
-- Persists the ambassador personal share message used by onboarding and
-- dashboard share-it flows.

alter table public.ambassador_profiles
  add column if not exists personal_message text;
