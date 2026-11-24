alter table if exists claimants
  add column if not exists residence_lat double precision,
  add column if not exists residence_lng double precision,
  add column if not exists residence_place_id text,
  add column if not exists residence_city text,
  add column if not exists residence_state text,
  add column if not exists residence_postal_code text,
  add column if not exists residence_source text,
  add column if not exists residence_precision text;

alter table if exists intake_submissions
  add column if not exists treatment_area_lat double precision,
  add column if not exists treatment_area_lng double precision,
  add column if not exists treatment_area_place_id text,
  add column if not exists treatment_area_city text,
  add column if not exists treatment_area_state text,
  add column if not exists treatment_area_postal_code text,
  add column if not exists treatment_area_source text,
  add column if not exists treatment_area_precision text;

alter table if exists accidents
  add column if not exists incident_lat double precision,
  add column if not exists incident_lng double precision,
  add column if not exists incident_place_id text,
  add column if not exists incident_city text,
  add column if not exists incident_state text,
  add column if not exists incident_postal_code text,
  add column if not exists incident_source text,
  add column if not exists incident_precision text;
