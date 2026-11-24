import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import {
  resolveClaimantForUser,
  resolveOwnedSubmission,
  resolveRegistrationStatus,
  resolveResumableSubmission,
  type ResumableSubmissionResult,
} from "../lib/patient-identity";
import { normalizePhone } from "../lib/phone";
import {
  type AccidentInput,
  type StartIntakePayload,
  type CompleteIntakePayload,
  type DeleteDocumentPayload,
  type DocumentUploadUrlPayload,
  type RegistrationStatusPayload,
  type RegistrationStatusResponse,
} from "../types/intake";
import { notifyCaseEvent } from "../lib/case-notifications";
import { notifyReferringAmbassador } from "../lib/ambassador-notifications";
import { canCompleteIntake } from "../lib/case-status";
import { locationColumns } from "../lib/location-columns";

export const intakeRouter = Router();

// The front door of the new-patient flow, and the only route here that runs
// before a session exists.
//
// Registration used to be checked for the first time at /intake/start, which is
// three screens and a verification code later. A patient who already had an
// account walked the whole new-patient flow before anything noticed. This
// answers the same question at the point the flow actually begins.
//
// It is a gate, not the guarantee: /intake/start still resolves the claimant
// from the verified session and still refuses to register one number twice, so
// a caller who skips this route or races it gains nothing. What this adds is
// that the patient is told before they start rather than after they finish.
//
// It does confirm to an unauthenticated caller that a number belongs to a
// patient, which is the cost of telling a real patient why they were stopped —
// a deliberate trade, made explicit by returning that single bit and no other
// field.
intakeRouter.post("/registration-status", async (req: Request, res: Response) => {
  const { phone } = (req.body ?? {}) as Partial<RegistrationStatusPayload>;

  // The same normalisation the session bridge uses, so "(407) 555-1234",
  // "+14075551234" and "1 407 555 1234" cannot answer differently.
  const normalized = normalizePhone(phone);
  if (!normalized) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const result = await resolveRegistrationStatus(normalized);

  if (result.error) {
    res.status(500).json({ error: "registration_lookup_failed" });
    return;
  }

  const body: RegistrationStatusResponse = { status: result.status };
  res.status(200).json(body);
});

/**
 * Records the accident for a submission, whether or not one is already there.
 *
 * A case opened at verification has no accident row yet, so the answers that
 * arrive afterwards have nothing to update. Update first — that is the ordinary
 * path for a resumed intake, and it keeps the row's identity — then insert only
 * when the update matched nothing. Either way one submission ends with one
 * accident, so a patient who answers the location screen twice cannot leave two.
 */
async function writeAccident(submissionId: string, accident: AccidentInput): Promise<string | null> {
  const columns = {
    incident_type: accident.incidentType,
    incident_location: accident.incidentLocation,
    incident_date: accident.incidentDate ?? null,
    ...locationColumns(accident.incidentLocationDetails, "incident"),
  };

  const { data: updated, error: updateError } = await supabase
    .from("accidents")
    .update(columns)
    .eq("submission_id", submissionId)
    .select("id");

  if (updateError) return updateError.code ?? "update_failed";
  if (updated?.length) return null;

  const { error: insertError } = await supabase.from("accidents").insert({ submission_id: submissionId, ...columns });

  return insertError ? (insertError.code ?? "insert_failed") : null;
}

/**
 * Writes the details a patient has just typed onto the claimant they already
 * have. A resumed intake and a claimant reopened without a case both keep what
 * was entered this time, not what was entered on an earlier attempt.
 */
async function refreshClaimant(
  claimantId: string,
  claimant: StartIntakePayload["claimant"],
  locale: string
): Promise<string | null> {
  const { error } = await supabase
    .from("claimants")
    .update({
      first_name: claimant.firstName,
      last_name: claimant.lastName,
      email: claimant.email ?? null,
      preferred_language: locale,
    })
    .eq("id", claimantId);

  return error ? (error.code ?? "update_failed") : null;
}

type OpenSubmissionResult =
  | { submissionId: string; created: boolean; error?: undefined }
  | { submissionId?: undefined; created?: undefined; error: string };

/**
 * Opens the claimant's case, or joins the one a concurrent start opened first.
 *
 * Two first starts for one patient can both get here, each having seen a
 * claimant with no submission because neither had inserted yet. Migration 016
 * allows one submission in intake per claimant, so the later insert is refused
 * with a unique violation and that request carries on with the case the earlier
 * one opened — no second case, and no failure shown to the patient.
 */
async function openSubmission(claimantId: string, locale: string): Promise<OpenSubmissionResult> {
  const submissionId = randomUUID();

  const { error } = await supabase.from("intake_submissions").insert({
    id: submissionId,
    claimant_id: claimantId,
    status: "intake",
    locale,
  });

  if (!error) return { submissionId, created: true };
  if (error.code !== "23505") return { error: error.code ?? "insert_failed" };

  const winner = await resolveResumableSubmission(claimantId);
  if (winner.kind !== "resume") return { error: "open_submission_conflict" };
  return { submissionId: winner.submissionId, created: false };
}

// Called right after OTP verification, and again from the location screen with
// the accident once the patient has answered those screens.
//
// The claimant is resolved from the verified session, never from the payload:
// the phone travels in the body as intake data, but it selects nothing. A
// returning patient — a claimant with a submitted case — is still answered
// `existing` and receives no submission; whether one patient may hold several
// cases is an open product decision and is deliberately unchanged here. A
// claimant whose intake was abandoned before submission resumes that submission
// instead, refreshed with what they have just entered. A claimant with no
// submission at all — left by a first start that failed after creating them —
// is given a case exactly as a new claimant is.
intakeRouter.post("/start", requireAuth, async (req: Request, res: Response) => {
  const payload = req.body as StartIntakePayload;
  const { locale, claimant, accident } = payload;

  if (!claimant?.mobile) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // The accident is optional here. Verification happens before the patient has
  // said anything about the crash, and the case is opened at that moment so an
  // abandoned intake is still a patient we know about and can resume. The
  // accident arrives on a later call, once they have answered those screens.
  //
  // A partial accident is treated as no accident rather than written with the
  // gaps filled in: a row that says the crash was "other" somewhere "Unknown"
  // on the day the patient happened to verify is not missing data, it is wrong
  // data, and nothing downstream can tell it from an answer.
  const accidentInput = accident?.incidentType && accident?.incidentLocation ? accident : null;

  const identity = await resolveClaimantForUser(req.user!.id, req.user!.phone, {
    firstName: claimant.firstName,
    lastName: claimant.lastName,
    mobile: claimant.mobile,
    email: claimant.email,
    preferredLanguage: locale,
  });

  if (identity.error === "phone_mismatch") {
    res.status(403).json({ error: "phone_mismatch" });
    return;
  }
  if (identity.error === "claimant_owned_by_another_user") {
    res.status(403).json({ error: "claimant_owned_by_another_user" });
    return;
  }
  if (identity.error) {
    res.status(500).json({ error: "Failed to resolve claimant" });
    return;
  }

  // A new claimant has no case yet, so there is nothing to look up.
  const resumable: ResumableSubmissionResult = identity.claimant.preexisting
    ? await resolveResumableSubmission(identity.claimant.claimantId)
    : { kind: "none" };

  if (resumable.error) {
    res.status(500).json({ error: "Failed to look up submission" });
    return;
  }
  if (resumable.kind === "returning") {
    res.status(200).json({ existing: true });
    return;
  }

  if (resumable.kind === "resume") {
    // Claim the submission while it is still in progress before writing anything
    // else, so a start that overlaps /intake/complete cannot rewrite a case that has
    // just been submitted. Every write here updates an existing row and none inserts
    // one: concurrent starts for one patient share the submission, and the last
    // request's answers win.
    const { data: claimed, error: claimError } = await supabase
      .from("intake_submissions")
      .update({ locale })
      .eq("id", resumable.submissionId)
      .in("status", ["intake", "in_progress"])
      .select("id");

    if (claimError) {
      console.error("intake_submissions resume claim failed:", { code: claimError.code });
      res.status(500).json({ error: "Failed to save submission" });
      return;
    }
    if (!claimed?.length) {
      res.status(200).json({ existing: true });
      return;
    }

    const resumeClaimantError = await refreshClaimant(identity.claimant.claimantId, claimant, locale);
    if (resumeClaimantError) {
      console.error("claimants resume update failed:", { code: resumeClaimantError });
      res.status(500).json({ error: "Failed to update claimant" });
      return;
    }

    if (accidentInput) {
      const accidentError = await writeAccident(resumable.submissionId, accidentInput);
      if (accidentError) {
        console.error("accidents resume write failed:", { code: accidentError });
        res.status(500).json({ error: "Failed to save accident details" });
        return;
      }
    }

    void notifyCaseEvent({
      submissionId: resumable.submissionId,
      eventType: "intake_started",
      claimantFirstName: claimant.firstName,
      claimantLastName: claimant.lastName,
      locale,
      claimantId: identity.claimant.claimantId,
    })
      .then((result) => {
        console.info("intake started notification result", {
          submissionId: resumable.submissionId,
          ...result,
        });
      })
      .catch((error) => {
        console.error("intake started notification failed", {
          submissionId: resumable.submissionId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      });

    void notifyCaseEvent({
      submissionId: resumable.submissionId,
      eventType: "patient_intake_started",
      claimantFirstName: claimant.firstName,
      claimantLastName: claimant.lastName,
      claimantMobile: claimant.mobile,
      locale,
      claimantId: identity.claimant.claimantId,
    })
      .then((result) => {
        console.info("patient intake started notification result", {
          submissionId: resumable.submissionId,
          ...result,
        });
      })
      .catch((error) => {
        console.error("patient intake started notification failed", {
          submissionId: resumable.submissionId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      });

    res.status(200).json({ existing: false, submissionId: resumable.submissionId });
    return;
  }

  // A claimant found without a case typed their details again on the way here,
  // and those are the ones to keep.
  if (identity.claimant.preexisting) {
    const refreshError = await refreshClaimant(identity.claimant.claimantId, claimant, locale);
    if (refreshError) {
      console.error("claimants update failed:", { code: refreshError });
      res.status(500).json({ error: "Failed to update claimant" });
      return;
    }
  }

  const opened = await openSubmission(identity.claimant.claimantId, locale);
  if (opened.error !== undefined) {
    console.error("intake_submissions insert failed:", { code: opened.error });
    res.status(500).json({ error: "Failed to save submission" });
    return;
  }
  const submissionId = opened.submissionId;

  if (accidentInput) {
    const accidentError = await writeAccident(submissionId, accidentInput);
    if (accidentError) {
      console.error("accidents insert failed:", { code: accidentError });
      res.status(500).json({ error: "Failed to save accident details" });
      return;
    }
  }

  void notifyCaseEvent({
    submissionId,
    eventType: "intake_started",
    claimantFirstName: claimant.firstName,
    claimantLastName: claimant.lastName,
    locale,
    claimantId: identity.claimant.claimantId,
  })
    .then((result) => {
      console.info("intake started notification result", {
        submissionId,
        ...result,
      });
    })
    .catch((error) => {
      console.error("intake started notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });

  void notifyCaseEvent({
    submissionId,
    eventType: "patient_intake_started",
    claimantFirstName: claimant.firstName,
    claimantLastName: claimant.lastName,
    claimantMobile: claimant.mobile,
    locale,
    claimantId: identity.claimant.claimantId,
  })
    .then((result) => {
      console.info("patient intake started notification result", {
        submissionId,
        ...result,
      });
    })
    .catch((error) => {
      console.error("patient intake started notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });

  // 201 when this request opened the case, 200 when it joined one a concurrent
  // start had just opened.
  res.status(opened.created ? 201 : 200).json({ existing: false, submissionId });
});

export const DOCUMENTS_BUCKET = "submissions";

// Strips directory separators and anything else that would let a caller
// escape the submission folder or produce an unreadable object key.
function safeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Makes one object key per upload by inserting a short random token before the
 * extension, so two files that happen to share a name cannot land on the same
 * key. Phones supply colliding names constantly — IMG_0001.jpg from two
 * different sources is the normal case, not the edge case — and with `upsert`
 * the second upload silently replaced the first, losing evidence the patient
 * believed they had attached.
 *
 * Both halves matter: unique keys stop the collision, and `upsert: false` makes
 * an unexpected collision fail loudly instead of overwriting. The extension is
 * kept so Storage still serves a sensible content type.
 */
function uniqueObjectName(name: string): string {
  const suffix = randomUUID().slice(0, 8);
  const dot = name.lastIndexOf(".");
  // A leading dot is the whole name, not an extension, so it is left alone.
  if (dot <= 0) return `${name}-${suffix}`;
  return `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`;
}

export function normalizeStoragePath(storagePath: string): string {
  return storagePath.replace(/^\/+/, "").replace(new RegExp(`^${DOCUMENTS_BUCKET}/`), "");
}

// Evidence files go straight from the browser to Storage, but the bucket is
// private and has no anonymous policy — the token minted here is what
// authorizes the upload, scoped to one object key.
intakeRouter.post("/documents/upload-url", requireAuth, async (req: Request, res: Response) => {
  const { submissionId, fileName, category } = req.body as DocumentUploadUrlPayload;

  if (!submissionId || !fileName) {
    res.status(400).json({ error: "Missing submissionId or fileName" });
    return;
  }

  const name = safeFileName(fileName);
  if (!name) {
    res.status(400).json({ error: "Invalid fileName" });
    return;
  }

  // A signed upload URL is a capability, so ownership is settled before one is
  // minted rather than after. A submission the caller does not own answers the
  // same way as one that does not exist.
  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to look up submission" });
    return;
  }
  if (owned.error) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const folder = category ? safeFileName(category) : "uncategorized";
  // Built from the submission the server verified, not from anything the
  // caller sent, so the key cannot escape its own namespace.
  const storagePath = `${owned.submission.submissionId}/${folder}/${uniqueObjectName(name)}`;

  // Every call mints a fresh key, so a retry writes to a new object rather than
  // needing permission to replace one. Nothing this route issues can overwrite
  // an existing file.
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });

  if (error || !data) {
    console.error("createSignedUploadUrl failed:", { name: error?.name });
    res.status(500).json({ error: "Failed to create upload URL" });
    return;
  }

  res.status(200).json({ bucket: DOCUMENTS_BUCKET, storagePath, token: data.token });
});

// Deletes one evidence object from the authenticated patient's own submission.
intakeRouter.post("/documents/delete", requireAuth, async (req: Request, res: Response) => {
  const { submissionId, storagePath } = req.body as Partial<DeleteDocumentPayload>;

  if (!submissionId || !storagePath) {
    res.status(400).json({ error: "Missing submissionId or storagePath" });
    return;
  }

  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to look up submission" });
    return;
  }
  if (owned.error) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const normalizedStoragePath = normalizeStoragePath(storagePath);
  if (!normalizedStoragePath.startsWith(`${owned.submission.submissionId}/`)) {
    res.status(403).json({ error: "document_outside_submission" });
    return;
  }

  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([normalizedStoragePath]);

  if (error) {
    console.error("documents/delete remove failed:", { name: error.name });
    res.status(500).json({ error: "Failed to delete document" });
    return;
  }

  res.status(200).json({ deleted: true, storagePath: normalizedStoragePath });
});

// Called after "My treatment location" for first-time claimants only —
// fills in everything gathered since /start and marks the submission submitted.
intakeRouter.post("/complete", requireAuth, async (req: Request, res: Response) => {
  const payload = req.body as CompleteIntakePayload;
  const { submissionId, claimant, accident, treatmentArea, documents, companions } = payload;

  if (!submissionId) {
    res.status(400).json({ error: "Missing submissionId" });
    return;
  }

  // This route rewrites the claimant, the accident and the submission's status
  // in one pass, so ownership is settled before the first write. Everything
  // below is a mutation; nothing may run until the caller is known to own it.
  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to look up submission" });
    return;
  }
  if (owned.error) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  // Completing again would put a decided case back in review and rewrite the
  // facts the decision — and any signed retainer — rests on.
  if (!canCompleteIntake(owned.submission.status)) {
    res.status(409).json({ error: "case_already_reviewed" });
    return;
  }

  // Evidence metadata names a Storage object. A row may only point inside the
  // caller's own submission folder, or a patient could attach another patient's
  // evidence to their case and surface it in the portal.
  const foreignDocument = (documents ?? []).find(
    (doc) => !doc.storagePath?.startsWith(`${owned.submission.submissionId}/`)
  );
  if (foreignDocument) {
    res.status(403).json({ error: "document_outside_submission" });
    return;
  }

  const { error: claimantError } = await supabase
    .from("claimants")
    .update({
      residence: claimant.residence ?? null,
      ...locationColumns(claimant.residenceLocationDetails, "residence"),
    })
    .eq("id", owned.submission.claimantId);

  if (claimantError) {
    console.error("claimants update failed:", { code: claimantError.code });
    res.status(500).json({ error: "Failed to update claimant" });
    return;
  }

  const { error: accidentError } = await supabase
    .from("accidents")
    .update({
      role: accident.role ?? null,
      description: accident.description ?? null,
      ...(accident.incidentType && { incident_type: accident.incidentType }),
      ...(accident.incidentDate && { incident_date: accident.incidentDate }),
      ...(accident.incidentLocation && { incident_location: accident.incidentLocation }),
      ...(accident.injuries && { injuries: accident.injuries }),
      ...(accident.injuryTypes && { injury_types: accident.injuryTypes }),
      ...(accident.incidentLocationDetails !== undefined &&
        locationColumns(accident.incidentLocationDetails, "incident")),
    })
    .eq("submission_id", submissionId);

  if (accidentError) {
    console.error("accidents update failed:", { code: accidentError.code });
    res.status(500).json({ error: "Failed to update accident details" });
    return;
  }

  const { error: submissionError } = await supabase
    .from("intake_submissions")
    .update({
      treatment_area: treatmentArea ?? null,
      ...(payload.treatmentAreaLocationDetails !== undefined &&
        locationColumns(payload.treatmentAreaLocationDetails, "treatment_area")),
      status: "submitted",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", submissionId);

  if (submissionError) {
    console.error("intake_submissions update failed:", { code: submissionError.code });
    res.status(500).json({ error: "Failed to submit case" });
    return;
  }

  if (documents && documents.length > 0) {
    const { error: documentsError } = await supabase.from("documents").insert(
      documents.map((doc) => ({
        submission_id: submissionId,
        storage_path: doc.storagePath,
        file_name: doc.fileName,
        mime_type: doc.mimeType || null,
        file_size: doc.fileSize || null,
        category: doc.category ?? null,
      }))
    );

    if (documentsError) {
      console.error("documents insert failed:", { code: documentsError.code });
      res.status(500).json({ error: "Failed to save documents" });
      return;
    }
  }

  if (companions && companions.length > 0) {
    const { error: companionsError } = await supabase.from("submission_companions").insert(
      companions.map((companion) => ({
        submission_id: submissionId,
        first_name: companion.firstName.trim(),
        last_name: companion.lastName.trim(),
        relation: companion.relation.trim(),
        cell_number: companion.cellNumber.trim(),
        email: companion.email?.trim() ? companion.email.trim() : null,
      }))
    );

    if (companionsError) {
      console.error("submission_companions insert failed:", { code: companionsError.code });
      res.status(500).json({ error: "Failed to save companions" });
      return;
    }
  }

  void notifyCaseEvent({
    submissionId,
    eventType: "intake_submitted",
    claimantFirstName: owned.submission.firstName,
    claimantLastName: owned.submission.lastName,
    locale: owned.submission.locale,
    claimantId: owned.submission.claimantId,
  })
    .then((result) => {
      console.info("intake submitted notification result", {
        submissionId,
        ...result,
      });
    })
    .catch((error) => {
      console.error("intake submitted notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });

  void notifyCaseEvent({
    submissionId,
    eventType: "patient_intake_submitted",
    claimantFirstName: owned.submission.firstName,
    claimantLastName: owned.submission.lastName,
    locale: owned.submission.locale,
    claimantId: owned.submission.claimantId,
    ...(req.user?.phone ? { claimantMobile: req.user.phone } : {}),
  })
    .then((result) => {
      console.info("patient intake submitted notification result", {
        submissionId,
        ...result,
      });
    })
    .catch((error) => {
      console.error("patient intake submitted notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });

  // The ambassador whose link brought this patient in, now that the intake is
  // submitted (not when it was started). The referral comes from the provider's
  // own attribution, never from anything in this request. A repeated completion
  // finds the text already sent and sends nothing more.
  void notifyReferringAmbassador({
    submissionId,
    patientUserId: req.user?.id ?? null,
    locale: owned.submission.locale,
  })
    .then((result) => {
      console.info("ambassador onboarded notification result", { submissionId, ...result });
    })
    .catch((error) => {
      console.error("ambassador onboarded notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });

  res.status(200).json({ submissionId });
});
