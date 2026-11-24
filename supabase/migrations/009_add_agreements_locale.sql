-- 009_add_agreements_locale.sql
--
-- Records which language retainer an agreement was created for, so agreement
-- reuse is locale-aware. Without it the reuse lookup keys on submission_id
-- alone, and an English envelope is handed back for a Spanish signing request
-- (and vice versa) after the patient switches language before signing.
--
-- The application resolves the language from the patient's current selection and
-- only ever writes 'en' or 'es'; the check is defense in depth. The column is
-- nullable so rows created before it existed still load — the reuse logic treats
-- a null as "unknown language" and supersedes such a row rather than reusing it
-- across languages, so no backfill is required.

alter table if exists agreements
  add column if not exists locale text
    constraint agreements_locale_check check (locale is null or locale in ('en', 'es'));
