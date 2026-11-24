import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { resolveVerifiedPatient, type PatientIdentityError, type VerifiedPatient } from "../lib/patient-identity";
import {
  createEnvelopeFromTemplate,
  DocusignRequestError,
  isAccountCapacityError,
  createRecipientView,
  refreshEnvelopeTextTabs,
  buildEmbeddedSigningClient,
  buildEmbeddedSigningOrigins,
  loadDocusignConfig,
  getEnvelopeStatus,
  isAgreementLocale,
  type EnvelopeSigner,
  type AgreementTextTab,
  type AgreementLocale,
} from "../lib/docusign";
import { formatDateOfLoss, signingDateParts } from "../lib/agreement-dates";
import { storeSignedDocument } from "../lib/agreement-document";
import { AGREEMENT_READY_STATUS, isReadyForAgreement } from "../lib/case-status";
import { notifyCaseEvent } from "../lib/case-notifications";
import { passNewlySignedCaseToLawyer } from "../lib/lawyer-handoff";
import { type AgreementPayload } from "../types/intake";

/** RFC 2606 reserves .invalid; nothing here can ever receive mail. */
const SIGNER_ADDRESS_DOMAIN = "haa-agreements.invalid";

export const agreementsRouter = Router();

// A reservation is a row that exists before DocuSign has confirmed an envelope.
// It is normally replaced within a second; anything older than this means the
// request that created it died mid-flight, so the next caller takes it over
// rather than being blocked forever by the partial unique index.
const STALE_RESERVATION_MS = 60_000;

// Mirrors agreements_one_active_per_submission: declined and voided rows are
// finished, so a patient may start again after either.
const INACTIVE_STATUSES = "(declined,voided)";

interface AgreementRow {
  id: string;
  status: string;
  envelope_id: string | null;
  signed_document_path: string | null;
  created_at: string;
  /** The retainer language this agreement is for. Null on rows predating migration 009. */
  locale: string | null;
}

// Only an approved case becomes 'signed'. A completed agreement on a case the
// admin never approved — one signed before this lifecycle — must not skip the
// approval on its way to a lawyer.
//
// This is the one place a case becomes 'signed', and it is reached only once
// DocuSign reports the envelope completed. The update is conditional on the
// status it moves away from, so of any number of reconciliations — retried,
// refreshed or concurrent — exactly one changes the row, and only that one
// tells the admins and hands the case to a lawyer. Every later call matches
// nothing, sends nothing and hands nothing on.
async function markSubmissionSigned(submissionId: string): Promise<void> {
  const { data, error } = await supabase
    .from("intake_submissions")
    .update({ status: "signed" })
    .eq("id", submissionId)
    .eq("status", AGREEMENT_READY_STATUS)
    .select("id, claimant_id, locale");

  if (error) {
    console.error("submission signed status update failed:", { code: error.code, submissionId });
    return;
  }

  const signed = data?.[0];
  if (!signed) return;

  // After the status is stored, and without holding up the patient's response:
  // a failed send is recorded in case_notifications and leaves 'signed' as it is.
  void notifyCaseEvent({
    submissionId,
    eventType: "retainer_signed",
    locale: typeof signed.locale === "string" ? signed.locale : "en",
    ...(typeof signed.claimant_id === "string" ? { claimantId: signed.claimant_id } : {}),
  }).catch((notifyError) => {
    console.error("retainer signed notification failed", {
      submissionId,
      error: notifyError instanceof Error ? notifyError.message : "unknown_error",
    });
  });

  // Signing is the last step before a lawyer, so the case goes straight on
  // (lib/lawyer-handoff.ts). Awaited so the patient's next read already sees
  // where the case stands; it never throws, and a case it cannot hand on stays
  // 'signed' for the Admin Dashboard's pass_to_lawyer.
  if (typeof signed.claimant_id === "string") {
    await passNewlySignedCaseToLawyer(submissionId, signed.claimant_id);
  }
}

/**
 * One line per agreement decision, for local and test debugging. Ids and locales
 * only — never a token, a signing URL, DocuSign payloads, or patient data.
 */
function logAgreementDecision(fields: {
  submissionId: string;
  requestedLocale: string;
  action:
    | "reused_same_locale"
    | "created"
    | "superseded_other_locale"
    | "already_completed"
    | "refused_account_capacity"
    | "envelope_creation_failed";
  templateLanguage?: string;
  previousLocale?: string | null;
}): void {
  console.log("agreement decision:", fields);
}

function respondToIdentityError(res: Response, error: PatientIdentityError): void {
  if (error === "submission_not_found") {
    res.status(404).json({ error: "submission_not_found" });
    return;
  }
  if (error === "submission_not_submitted") {
    res.status(409).json({ error: "submission_not_submitted" });
    return;
  }
  res.status(500).json({ error: "identity_lookup_failed" });
}

async function findActiveAgreement(submissionId: string): Promise<AgreementRow | null | "error"> {
  const { data, error } = await supabase
    .from("agreements")
    .select("id, status, envelope_id, signed_document_path, created_at, locale")
    .eq("submission_id", submissionId)
    .not("status", "in", INACTIVE_STATUSES)
    .maybeSingle();

  if (error) {
    console.error("agreements lookup failed:", { code: error.code });
    return "error";
  }

  return data;
}

/**
 * A patient is identified by phone, and email is optional throughout intake, so
 * the signer address cannot come from the patient.
 *
 * DocuSign's templateRoles schema requires an address, but for an embedded
 * recipient — one carrying a clientUserId — it never sends mail to it: the
 * signing ceremony is reached through the recipient view instead. The address
 * is therefore a recipient key, not a mailbox, so it is derived from the
 * agreement row in a domain reserved by RFC 2606 that can never receive mail.
 * Verified against Sandbox: envelope creation and recipient view both accept it.
 *
 * It is deterministic per agreement, so reusing an agreement reproduces the same
 * recipient. It is server-side only and never reaches the browser.
 */
function signerFor(patient: VerifiedPatient, agreementId: string): EnvelopeSigner {
  return {
    email: `agreement-${agreementId}@${SIGNER_ADDRESS_DOMAIN}`,
    // The real name still appears on the document, which is what is signed.
    name: `${patient.firstName} ${patient.lastName}`.trim(),
    // The agreement row, never the submission — a submission id travels through
    // the browser and identifies the flow, not the signature.
    clientUserId: agreementId,
  };
}

function requireFrontendUrl(): string {
  const frontendUrl = process.env.FRONTEND_URL?.trim();
  if (!frontendUrl) {
    throw new Error("Missing FRONTEND_URL, required to build the DocuSign return URL");
  }
  return frontendUrl;
}

/**
 * Where DocuSign sends the patient back to. Built entirely from configuration
 * and a locale the database constrains, so nothing the caller supplies can
 * redirect the patient off the application.
 */
function buildReturnUrl(locale: string): string {
  const safeLocale = locale === "es" ? "es" : "en";
  return `${requireFrontendUrl().replace(/\/+$/, "")}/${safeLocale}/intake/agreement/return`;
}

/**
 * The signing session is shown inside the application's own agreement screen,
 * so the view is minted with the application's origin as the only page that
 * may frame it — again from configuration, never from the request.
 */
function buildSigningEmbedding() {
  const config = loadDocusignConfig();
  return {
    origins: buildEmbeddedSigningOrigins(requireFrontendUrl(), config.oauthHost),
    client: buildEmbeddedSigningClient(config.oauthHost, config.integrationKey),
  };
}

// The retainer's data labels. The client name is auto-filled by DocuSign from
// the recipient, signatures and date-signed are the template's own tabs, and
// every patient choice (SSN, authorized contact, initials, ...) is left to the
// signer. HAA fills only these, and both language templates share the labels, so
// one mapping serves English and Spanish alike.
const TAB_LABEL = {
  dateOfLoss: "dateOfLoss",
  signedDay: "agreementSignedDay",
  signedMonth: "agreementSignedMonth",
  signedYear: "agreementSignedYear",
} as const;

/**
 * The signing-date tabs for the "DATED this __ day of __, 20__" line, for the
 * moment the ceremony is opened. A DocuSign Date-Signed tab cannot fill three
 * separate day/month/year boxes, so the sender supplies them; the reuse path
 * refreshes them so a later signing is dated correctly.
 */
function signingDateTabsFor(locale: string, openedAt: Date): AgreementTextTab[] {
  const parts = signingDateParts(openedAt, locale);
  return [
    { tabLabel: TAB_LABEL.signedDay, value: parts.day },
    { tabLabel: TAB_LABEL.signedMonth, value: parts.month },
    { tabLabel: TAB_LABEL.signedYear, value: parts.year },
  ];
}

type DateOfLossResult = { value: string | null } | { error: "lookup_failed" };

/**
 * The accident's date, formatted for the patient's language. The retainer's
 * date-of-loss field is locked, so its value can only be the reported accident
 * date — never invented, never entered by the patient during signing.
 */
async function loadDateOfLoss(submissionId: string, locale: string): Promise<DateOfLossResult> {
  const { data, error } = await supabase
    .from("accidents")
    .select("incident_date")
    .eq("submission_id", submissionId)
    .maybeSingle();

  if (error) {
    console.error("accident lookup failed:", { code: error.code });
    return { error: "lookup_failed" };
  }

  const incidentDate = typeof data?.incident_date === "string" ? data.incident_date : null;
  return { value: incidentDate ? formatDateOfLoss(incidentDate, locale) : null };
}

// Creates the patient's agreement, or hands back the one already in play.
//
// The row is reserved before DocuSign is called. Two simultaneous taps
// therefore contend in the database, where the partial unique index settles it,
// instead of both reaching DocuSign and orphaning an envelope.
agreementsRouter.post("/agreement", requireAuth, async (req: Request, res: Response) => {
  const { submissionId, locale: requestedLocale } = req.body as Partial<AgreementPayload>;

  if (!submissionId) {
    res.status(400).json({ error: "missing_submission_id" });
    return;
  }

  // The patient's current language selection is the source of truth for which
  // retainer is used. It is validated and fails closed: an unknown or missing
  // value is rejected rather than defaulted to a language.
  if (typeof requestedLocale !== "string" || !isAgreementLocale(requestedLocale)) {
    res.status(400).json({ error: "invalid_locale" });
    return;
  }
  const locale: AgreementLocale = requestedLocale;

  const identity = await resolveVerifiedPatient(req, submissionId);
  if (identity.error) {
    respondToIdentityError(res, identity.error);
    return;
  }
  const patient = identity.patient;

  // Signing follows the Admin Dashboard's approval (approve_for_retainer), not
  // submission. A case still in review, turned down, already signed or passed
  // on is refused here — before any row is written or DocuSign is asked for
  // anything — whatever screen the request came from.
  if (!isReadyForAgreement(patient.status)) {
    res.status(409).json({ error: "case_not_approved" });
    return;
  }

  // Keep the stored locale in step with the current selection, so the persisted
  // record — read by the dashboard and any later request — is the same source of
  // truth as the template about to be used. Non-fatal: the request locale is
  // authoritative for this operation regardless of the write's outcome.
  if (patient.locale !== locale) {
    const { error: localeError } = await supabase
      .from("intake_submissions")
      .update({ locale })
      .eq("id", patient.submissionId);
    if (localeError) console.error("submission locale update failed:", { code: localeError.code });
  }

  // Computed once, at the moment the ceremony is opened. Both a newly created
  // envelope and a reused one are dated from here, so the signing date reflects
  // this session rather than whenever the envelope first came into being.
  const openedAt = new Date();
  const signingDateTabs = signingDateTabsFor(locale, openedAt);

  let existing = await findActiveAgreement(submissionId);
  if (existing === "error") {
    res.status(500).json({ error: "agreement_lookup_failed" });
    return;
  }

  // Nothing left to sign, and no signing URL to mint.
  if (existing?.status === "completed") {
    await markSubmissionSigned(submissionId);
    logAgreementDecision({
      submissionId,
      requestedLocale: locale,
      action: "already_completed",
      previousLocale: existing.locale,
    });
    res.status(200).json({ status: "completed" });
    return;
  }

  let returnUrl: string;
  let embedding: ReturnType<typeof buildSigningEmbedding>;
  try {
    returnUrl = buildReturnUrl(locale);
    embedding = buildSigningEmbedding();
  } catch (error) {
    console.error("return URL configuration missing:", (error as Error).message);
    res.status(500).json({ error: "agreement_not_configured" });
    return;
  }

  // Language is the source of truth: an active agreement for the OTHER language
  // must never be handed back. Supersede it (void), then fall through to create
  // the correct locale-specific agreement. A null locale is a pre-009 row of
  // unknown language and is superseded for the same reason. After this, any
  // surviving `existing` is guaranteed to match the requested language, so the
  // reuse paths below can never cross a language boundary.
  if (existing && existing.locale !== locale) {
    const { error: voidError } = await supabase
      .from("agreements")
      .update({ status: "voided", error_code: "locale_superseded", updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (voidError) {
      console.error("locale supersede failed:", { code: voidError.code });
      res.status(500).json({ error: "agreement_update_failed" });
      return;
    }
    logAgreementDecision({
      submissionId,
      requestedLocale: locale,
      action: "superseded_other_locale",
      previousLocale: existing.locale,
    });
    existing = null;
  }

  // Mints a view for an agreement that already has an envelope. Views are
  // single-use and short-lived, so an existing envelope is always re-viewed
  // rather than reused, and never a second envelope.
  const respondWithExistingEnvelope = async (agreement: AgreementRow & { envelope_id: string }) => {
    try {
      // Re-date the existing envelope to this session before showing it, so a
      // patient returning on a later day signs a document dated that day. A
      // failure here is not worth blocking the signature — the envelope keeps the
      // date it was created with — so it is logged and the flow continues.
      try {
        await refreshEnvelopeTextTabs(agreement.envelope_id, signingDateTabs);
      } catch (refreshError) {
        console.error("signing-date refresh failed:", (refreshError as Error).message);
      }

      const signingUrl = await createRecipientView(
        agreement.envelope_id,
        signerFor(patient, agreement.id),
        returnUrl,
        embedding.origins
      );
      res.status(200).json({ status: agreement.status, signingUrl, embed: embedding.client });
    } catch (error) {
      console.error("recipient view failed:", (error as Error).message);
      res.status(502).json({ error: "signing_url_failed" });
    }
  };

  // An envelope already exists for the requested language — mint a fresh view
  // rather than a second envelope. (Any other-language agreement was superseded
  // above, so this can only be a same-locale reuse.)
  if (existing?.envelope_id) {
    logAgreementDecision({
      submissionId,
      requestedLocale: locale,
      action: "reused_same_locale",
      templateLanguage: existing.locale ?? locale,
    });
    await respondWithExistingEnvelope({ ...existing, envelope_id: existing.envelope_id });
    return;
  }

  // A reservation without an envelope belongs to a request that is still
  // running; only take it over once it is old enough to be abandoned.
  if (existing && Date.now() - Date.parse(existing.created_at) < STALE_RESERVATION_MS) {
    res.status(409).json({ error: "agreement_in_progress" });
    return;
  }

  // The retainer's date-of-loss field is required and locked, so the envelope
  // cannot be completed without it. Resolve it before reserving a row or calling
  // DocuSign, so a submission that somehow lacks it fails cleanly here rather
  // than stranding the patient on an unsignable document.
  const dateOfLoss = await loadDateOfLoss(patient.submissionId, locale);
  if ("error" in dateOfLoss) {
    res.status(500).json({ error: "agreement_lookup_failed" });
    return;
  }
  if (!dateOfLoss.value) {
    console.error("agreement blocked: submission has no usable date of loss");
    res.status(409).json({ error: "date_of_loss_missing" });
    return;
  }

  let agreementId = existing?.id;

  if (!agreementId) {
    const reserved = randomUUID();
    const { error: insertError } = await supabase.from("agreements").insert({
      id: reserved,
      submission_id: submissionId,
      status: "created",
      recipient_client_user_id: reserved,
      locale,
    });

    if (insertError?.code === "23505") {
      // Another request reserved first. Reuse its agreement — never create a
      // second envelope for the same submission.
      const winner = await findActiveAgreement(submissionId);
      if (winner === "error" || !winner) {
        res.status(500).json({ error: "agreement_lookup_failed" });
        return;
      }
      if (winner.status === "completed") {
        res.status(200).json({ status: "completed" });
        return;
      }
      // A concurrent request created an agreement for the other language (rare —
      // the client serializes createAgreement). Do not serve the wrong language;
      // report in-progress so the client retries, and the retry supersedes it.
      if (winner.locale !== locale) {
        res.status(409).json({ error: "agreement_in_progress" });
        return;
      }
      if (winner.envelope_id) {
        await respondWithExistingEnvelope({ ...winner, envelope_id: winner.envelope_id });
        return;
      }
      // The winner is still creating its envelope. There is no signing URL to
      // hand back yet, and inventing one would mean a second envelope.
      res.status(409).json({ error: "agreement_in_progress" });
      return;
    }

    if (insertError) {
      console.error("agreements insert failed:", { code: insertError.code });
      res.status(500).json({ error: "agreement_reservation_failed" });
      return;
    }

    agreementId = reserved;
  }

  const signer = signerFor(patient, agreementId);

  // The signing-date pieces plus the date of loss. Everything else on the
  // retainer is the template's own tab or a patient choice.
  const creationTabs: AgreementTextTab[] = [
    ...signingDateTabs,
    { tabLabel: TAB_LABEL.dateOfLoss, value: dateOfLoss.value },
  ];

  logAgreementDecision({ submissionId, requestedLocale: locale, action: "created", templateLanguage: locale });

  let envelopeId: string;
  try {
    envelopeId = await createEnvelopeFromTemplate(signer, locale, creationTabs);
  } catch (error) {
    // Release the reservation so the partial unique index stops blocking a
    // retry. 'voided' is already excluded by it, so no new status is needed.
    // The row keeps DocuSign's code so a refused attempt can be told apart
    // from an application fault after the fact.
    const capacity = isAccountCapacityError(error);
    await supabase
      .from("agreements")
      .update({
        status: "voided",
        error_code: error instanceof DocusignRequestError ? `docusign_${error.errorCode.toLowerCase()}` : "envelope_creation_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", agreementId);

    console.error("envelope creation failed:", (error as Error).message);
    logAgreementDecision({
      submissionId,
      requestedLocale: locale,
      action: capacity ? "refused_account_capacity" : "envelope_creation_failed",
      templateLanguage: locale,
    });
    // Capacity is DocuSign's account limit, not this request: the patient's
    // case is intact and a later attempt may succeed, so it is reported as the
    // service being unavailable rather than as a broken flow.
    if (capacity) {
      res.status(503).json({ error: "signing_capacity_exceeded" });
      return;
    }
    res.status(502).json({ error: "envelope_creation_failed" });
    return;
  }

  const { error: updateError } = await supabase
    .from("agreements")
    .update({ envelope_id: envelopeId, status: "sent", updated_at: new Date().toISOString() })
    .eq("id", agreementId);

  if (updateError) {
    console.error("agreements update failed:", { code: updateError.code });
    res.status(500).json({ error: "agreement_update_failed" });
    return;
  }

  try {
    const signingUrl = await createRecipientView(envelopeId, signer, returnUrl, embedding.origins);
    res.status(201).json({ status: "sent", signingUrl, embed: embedding.client });
  } catch (error) {
    console.error("recipient view failed:", (error as Error).message);
    res.status(502).json({ error: "signing_url_failed" });
  }
});

// The authoritative status. The browser is told nothing it could have forged:
// no event parameter is read, and the envelope id never leaves the backend.
agreementsRouter.get("/agreement/:submissionId", requireAuth, async (req: Request, res: Response) => {
  const submissionId = typeof req.params.submissionId === "string" ? req.params.submissionId : "";

  if (!submissionId) {
    res.status(400).json({ error: "missing_submission_id" });
    return;
  }

  const identity = await resolveVerifiedPatient(req, submissionId);
  if (identity.error) {
    respondToIdentityError(res, identity.error);
    return;
  }

  const agreement = await findActiveAgreement(submissionId);
  if (agreement === "error") {
    res.status(500).json({ error: "agreement_lookup_failed" });
    return;
  }

  if (!agreement) {
    res.status(404).json({ error: "agreement_not_found" });
    return;
  }

  // Terminal, or not yet an envelope — nothing to ask DocuSign about.
  if (agreement.status === "completed" || !agreement.envelope_id) {
    // Completion is settled, but the signed PDF may still be missing: the
    // retrieval that follows a status change can fail on its own. Reconciling
    // again is how it is retried, so this is the path that has to attempt it.
    if (agreement.status === "completed" && agreement.envelope_id && !agreement.signed_document_path) {
      await storeSignedDocument(agreement.id, submissionId, agreement.envelope_id);
    }
    if (agreement.status === "completed") {
      await markSubmissionSigned(submissionId);
    }
    res.status(200).json({ status: agreement.status });
    return;
  }

  let latest: string | null;
  try {
    latest = await getEnvelopeStatus(agreement.envelope_id);
  } catch (error) {
    // A refresh failure is not a status. Report what is stored rather than
    // guessing, and never fall back to something the browser suggested.
    console.error("envelope status refresh failed:", (error as Error).message);
    res.status(200).json({ status: agreement.status });
    return;
  }

  if (!latest || latest === agreement.status) {
    res.status(200).json({ status: agreement.status });
    return;
  }

  const { error: updateError } = await supabase
    .from("agreements")
    .update({
      status: latest,
      updated_at: new Date().toISOString(),
      ...(latest === "completed" && { completed_at: new Date().toISOString() }),
    })
    .eq("id", agreement.id);

  if (updateError) {
    console.error("agreements status update failed:", { code: updateError.code });
  }

  // The signed PDF is retrieved and kept once the envelope is finished. It is
  // deliberately not part of the status contract: the patient is told the
  // agreement is complete either way, and a retrieval failure is retried by the
  // next reconciliation rather than holding up the flow or being reported as a
  // signing problem.
  if (latest === "completed") {
    await storeSignedDocument(agreement.id, submissionId, agreement.envelope_id);
    await markSubmissionSigned(submissionId);
  }

  res.status(200).json({ status: latest });
});
