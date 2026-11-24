-- Adds the existing Auth accounts used by the admin team to public.admin_users.
-- This does not create auth.users rows; Supabase Auth owns those accounts.

insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) in (
  'laura@helpafteraccident.com',
  'mhuraira@helpafteraccident.com',
  'rain@helpafteraccident.com',
  'omar@helpafteraccident.com',
  'thomas@helpafteraccident.com',
  'pooja@helpafteraccident.com'
)
on conflict (user_id) do nothing;
