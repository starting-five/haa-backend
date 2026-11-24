-- 006_create_agreements.sql
--
-- Records the DocuSign retainer agreement for a submission.
--
-- Agreement state is kept here rather than on intake_submissions. That column's
-- valid set is fixed by 005 to ('in_progress', 'submitted'), and widening it
-- would mean dropping and recreating the constraint, which the migration
-- validator rejects. Signing also has its own lifecycle and timestamps, so a
-- separate row keeps the audit trail readable.
--
-- The signer model is patient-only: one envelope, one recipient. Should an
-- attorney counter-signature be added later, the patient remains the only
-- embedded signer, so the extra recipient lives inside the DocuSign envelope
-- and this table does not change shape.
--
-- The template is not referenced here. It is supplied through configuration
-- (DOCUSIGN_TEMPLATE_ID) so Sandbox and Production can point at different
-- templates and the temporary test template can be replaced by the approved
-- one without a migration.
--
-- Statuses mirror the DocuSign envelope status values the integration acts on.
-- 'created' is the local state between inserting the row and DocuSign
-- confirming the envelope, so a crash mid-create leaves a recoverable record
-- rather than an orphan envelope.

create table if not exists agreements (
  id                       uuid primary key default gen_random_uuid(),
  submission_id            uuid not null references intake_submissions(id) on delete cascade,
  envelope_id              text not null unique,
  status                   text not null default 'created'
                             check (status in ('created', 'sent', 'delivered', 'completed', 'declined', 'voided')),
  -- Correlates the embedded signing session with the recipient DocuSign holds.
  recipient_client_user_id text,
  -- Storage key of the completed PDF, mirroring documents.storage_path.
  signed_document_path     text,
  -- Non-sensitive failure marker only. Never store DocuSign payloads or patient data here.
  error_code               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz
);

-- Duplicate-click protection enforced by the database rather than by application
-- logic: a submission may hold at most one envelope that is still in play.
-- Declined and voided envelopes are excluded so a patient can legitimately start
-- again after either outcome.
create unique index if not exists agreements_one_active_per_submission
  on agreements (submission_id)
  where status not in ('declined', 'voided');

-- Lookups by submission are the common read path; envelope_id is already
-- indexed by its unique constraint, so it needs no separate index.
create index if not exists idx_agreements_submission_id on agreements (submission_id);

-- Same posture as every other table in this schema: row-level security on with
-- no policy, so anon and authenticated are denied outright and only the
-- service-role backend can reach it.
alter table agreements enable row level security;

revoke all on agreements from anon, authenticated;
