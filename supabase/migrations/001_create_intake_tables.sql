-- claimants: identity, created once per phone number (first intake step)
-- user_id is nullable for now since real phone auth (auth.users) isn't wired up yet;
-- mobile is the interim lookup/uniqueness key until then.
create table if not exists claimants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  mobile text not null unique,
  email text,
  residence text,
  preferred_language text not null default 'en',
  created_at timestamptz not null default now()
);

-- intake_submissions: one per accident/case, many can belong to the same claimant
create table if not exists intake_submissions (
  id uuid primary key,
  claimant_id uuid not null references claimants(id) on delete cascade,
  status text not null default 'in_progress',
  locale text not null default 'en',
  communication_consent boolean not null default true,
  treatment_area text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

-- accidents: incident details from step 2
create table if not exists accidents (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  incident_type text not null,
  incident_location text not null,
  incident_date date,
  description text,
  role text,
  injuries text,
  injury_types text,
  created_at timestamptz not null default now()
);

-- documents: file metadata from step 3 (files live in Supabase Storage)
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size integer,
  category text,
  created_at timestamptz not null default now()
);

-- submission_companions: people who were with the claimant during the incident
create table if not exists submission_companions (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references intake_submissions(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  relation text not null,
  cell_number text not null,
  email text,
  created_at timestamptz not null default now()
);

-- indexes for common lookups
create index if not exists idx_claimants_user_id on claimants(user_id);
create index if not exists idx_intake_submissions_claimant_id on intake_submissions(claimant_id);
create index if not exists idx_accidents_submission_id on accidents(submission_id);
create index if not exists idx_documents_submission_id on documents(submission_id);
create index if not exists idx_submission_companions_submission_id on submission_companions(submission_id);

-- lawyers: profile data linked to Supabase auth user (auth handled via phone OTP)
create table if not exists lawyers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  phone      text not null,
  email      text,
  first_name text,
  last_name  text,
  practice   text,
  role       text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lawyers_user_id on lawyers(user_id);
