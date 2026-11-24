-- 018_add_review_token_usage_columns.sql
--
-- Adds usage tracking and limits for reusable lawyer review link tokens.

alter table review_assignments
  add column if not exists token_use_count integer not null default 0;

alter table review_assignments
  add column if not exists token_max_uses integer not null default 20;

alter table review_assignments
  add column if not exists last_token_used_at timestamptz;

alter table review_assignments
  add constraint review_assignments_token_use_count_non_negative
  check (token_use_count >= 0);

alter table review_assignments
  add constraint review_assignments_token_max_uses_positive
  check (token_max_uses > 0);
