-- 012_add_profile_avatar_storage_policies.sql
--
-- Adds storage access controls for ambassador profile avatars.
--
-- Avatar uploads are written to: ambassadors/{auth.uid()}/avatar.{ext}
-- The bucket itself is provisioned by src/scripts/provision-storage.ts.

-- Avatar replacement uses Storage upsert, which requires UPDATE privilege.
grant update on storage.objects to authenticated;

drop policy if exists profile_avatars_select_own on storage.objects;
create policy profile_avatars_select_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = 'ambassadors'
  and (storage.foldername(name))[2] = (select auth.uid())::text
);

drop policy if exists profile_avatars_insert_own on storage.objects;
create policy profile_avatars_insert_own
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = 'ambassadors'
  and (storage.foldername(name))[2] = (select auth.uid())::text
);

drop policy if exists profile_avatars_update_own on storage.objects;
create policy profile_avatars_update_own
on storage.objects
for update
to authenticated
using (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = 'ambassadors'
  and (storage.foldername(name))[2] = (select auth.uid())::text
)
with check (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = 'ambassadors'
  and (storage.foldername(name))[2] = (select auth.uid())::text
);