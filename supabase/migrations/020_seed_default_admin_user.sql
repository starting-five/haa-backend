-- 019_seed_default_admin_user.sql
--
-- Boots the production admin account into public.admin_users after the Auth
-- user has been created. This intentionally does not create auth.users rows;
-- Supabase Auth owns that table and the user should be created through Auth.

insert into public.admin_users (user_id)
select id
from auth.users
where email = 'admin@helpafteraccident.com'
on conflict (user_id) do nothing;
