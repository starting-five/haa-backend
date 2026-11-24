import type { Request } from "express";
import { isSubmittedCase, SUBMITTED_CASE_STATUSES } from "./case-status";
import { supabase } from "./supabase";

// Answers one question for the protected patient routes: who is the verified
// patient, and do they own the thing they are asking about?
//
// Authority comes from the session and from nowhere else. The submission id in
// a request names a resource; it never proves a right to it. The chain is
//
//   JWT.sub -> auth.users.id -> claimants.user_id -> intake_submissions.claimant_id
//
// and every link is read from the database rather than from the caller.
//
// A submission belonging to someone else is reported as missing. Distinguishing
// "not yours" from "does not exist" would confirm to a caller that another
// patient's case exists, so both answer the same way.

/** The patient a signature would be attributed to. */
export interface VerifiedPatient {
  claimantId: string;
  submissionId: string;
  firstName: string;
  lastName: string;
  /** Optional throughout intake; agreement creation cannot proceed without it. */
  email: string | null;
  locale: string;
  /** Where the case stands. Opening a signing session also needs it approved — see lib/case-status.ts. */
  status: string;
}

export type PatientIdentityError = "submission_not_found" | "submission_not_submitted" | "identity_lookup_failed";

/** A submission the authenticated patient demonstrably owns. */
export interface OwnedSubmission {
  submissionId: string;
  claimantId: string;
  status: string;
  locale: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

export type OwnedSubmissionResult =
  { submission: OwnedSubmission; error?: undefined } | { submission?: undefined; error: PatientIdentityError };

export type PatientIdentityResult =
  { patient: VerifiedPatient; error?: undefined } | { patient?: undefined; error: PatientIdentityError };

export interface RequestClaimant {
  claimantId: string;
  firstName: string;
  lastName: string;
  mobile: string;
  email: string | null;
}

export type RequestClaimantResult =
  { claimant: RequestClaimant | null; error?: undefined } | { claimant?: undefined; error: "identity_lookup_failed" };

/** The claimant an authenticated user owns, and how that ownership came about. */
export interface ResolvedClaimant {
  claimantId: string;
  /** True when the claimant already existed, which the start route reports as `existing`. */
  preexisting: boolean;
}

export type ClaimantResolutionError =
  "phone_mismatch" | "claimant_owned_by_another_user" | "claimant_lookup_failed" | "claimant_write_failed";

export type ClaimantResolutionResult =
  { claimant: ResolvedClaimant; error?: undefined } | { claimant?: undefined; error: ClaimantResolutionError };

/** auth.users.phone has no leading plus; claimants.mobile keeps one. */
function samePhone(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.replace(/^\+/, "") === b!.replace(/^\+/, "");
}

export interface ClaimantSeed {
  firstName?: string | undefined;
  lastName?: string | undefined;
  mobile: string;
  email?: string | undefined;
  preferredLanguage?: string | undefined;
}

/**
 * Resolves the claimant belonging to an authenticated user, creating one the
 * first time. The authenticated user is the only identity authority here:
 * nothing the browser sends can select a different claimant.
 *
 * The user's own id is tried first, so a patient who already has a claimant
 * always lands on it. Only when they have none is the phone consulted, and then
 * solely to adopt a record created before authentication existed — a claimant
 * already owned by someone else is refused rather than reassigned.
 */
export async function resolveClaimantForUser(
  authUserId: string,
  authPhone: string | undefined,
  seed: ClaimantSeed
): Promise<ClaimantResolutionResult> {
  // The phone in the payload is intake data, never identity. It disagreeing
  // with the verified phone is not something the app can produce, so it is
  // refused rather than resolved in the caller's favour.
  if (!samePhone(authPhone, seed.mobile)) {
    return { error: "phone_mismatch" };
  }

  const { data: owned, error: ownedError } = await supabase
    .from("claimants")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (ownedError) {
    console.error("claimants lookup by user failed:", { code: ownedError.code });
    return { error: "claimant_lookup_failed" };
  }
  if (owned) return { claimant: { claimantId: owned.id, preexisting: true } };

  const { data: byPhone, error: phoneError } = await supabase
    .from("claimants")
    .select("id, user_id")
    .eq("mobile", seed.mobile)
    .maybeSingle();

  if (phoneError) {
    console.error("claimants lookup by mobile failed:", { code: phoneError.code });
    return { error: "claimant_lookup_failed" };
  }

  if (byPhone) {
    // Someone else already owns this record. Reassigning it would hand one
    // patient another patient's case, so it is refused outright.
    if (byPhone.user_id && byPhone.user_id !== authUserId) {
      return { error: "claimant_owned_by_another_user" };
    }

    // Created before authentication existed. Adopt it, but only if it is still
    // unowned — the guard above already excluded anything else.
    const { error: bindError } = await supabase
      .from("claimants")
      .update({ user_id: authUserId })
      .eq("id", byPhone.id)
      .is("user_id", null);

    if (bindError) {
      console.error("claimant binding failed:", { code: bindError.code });
      return { error: "claimant_write_failed" };
    }

    return { claimant: { claimantId: byPhone.id, preexisting: true } };
  }

  const { data: created, error: createError } = await supabase
    .from("claimants")
    .insert({
      user_id: authUserId,
      first_name: seed.firstName,
      last_name: seed.lastName,
      mobile: seed.mobile,
      email: seed.email ?? null,
      preferred_language: seed.preferredLanguage,
    })
    .select("id")
    .single();

  if (createError) {
    // Two first-time requests raced. claimants.user_id and claimants.mobile are
    // both unique, so one insert wins and the loser re-reads rather than
    // creating a second claimant for the same patient.
    if (createError.code === "23505") {
      const { data: winner } = await supabase.from("claimants").select("id").eq("user_id", authUserId).maybeSingle();
      // Reported as pre-existing, not new. The row was already there by the time
      // this request looked, and the caller uses `preexisting` to decide whether
      // to create a submission — answering `false` here gave the losing request
      // a second submission for a claimant that only ever registered once.
      if (winner) return { claimant: { claimantId: winner.id, preexisting: true } };
    }

    console.error("claimants insert failed:", { code: createError.code });
    return { error: "claimant_write_failed" };
  }

  return { claimant: { claimantId: created.id, preexisting: false } };
}

export type ResumableSubmissionResult =
  | { kind: "returning"; submissionId?: undefined; error?: undefined }
  | { kind: "resume"; submissionId: string; error?: undefined }
  | { kind: "none"; submissionId?: undefined; error?: undefined }
  | { kind?: undefined; submissionId?: undefined; error: "identity_lookup_failed" };

/**
 * Where an existing claimant stands, as far as opening a case goes.
 *
 * `returning` — the claimant has a case past intake. Whether one patient may
 * hold several cases is still an open product decision, so the start route
 * answers `existing` and creates nothing.
 *
 * `resume` — the newest submission still in intake, left by an intake
 * abandoned before submission.
 *
 * `none` — the claimant holds no submission at all. That is what a first start
 * leaves behind when it creates the claimant and then fails to open the case.
 * It used to be answered `existing` too, which sent the patient to attorney
 * matching with no case behind it, and every retry did the same. A patient in
 * that state could never open a case. A first start still racing to insert
 * looks identical from here; migration 016 allows one open intake per claimant,
 * so the start route can open a case for both and let the database pick one.
 */
export async function resolveResumableSubmission(claimantId: string): Promise<ResumableSubmissionResult> {
  const { data, error } = await supabase
    .from("intake_submissions")
    .select("id, status")
    .eq("claimant_id", claimantId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("resumable submission lookup failed:", { code: error.code });
    return { error: "identity_lookup_failed" };
  }

  const submissions = (data ?? []) as { id: string; status: string }[];
  if (submissions.some((submission) => isSubmittedCase(submission.status))) {
    return { kind: "returning" };
  }

  // This used to require the submission to have its accident row, as a stand-in
  // for "finished being written" — every case was opened with one, so a case
  // without one meant a start that had failed part-way. That is no longer true:
  // the case is opened when the number is verified, and the accident arrives on
  // a later call once the patient has answered those screens. A case with no
  // accident is now the ordinary state of an intake between the code screen and
  // the location screen, and refusing to resume it would strand exactly the
  // patient this function exists to help.
  const resumable = submissions.find((submission) => ["intake", "in_progress"].includes(submission.status));
  if (resumable) return { kind: "resume", submissionId: resumable.id };

  // Only a claimant with nothing at all is given a new case. Every submission
  // having moved past intake without ever being `submitted` is still a patient
  // with a case, and is treated as returning, as before.
  if (submissions.length === 0) return { kind: "none" };
  return { kind: "returning" };
}

/**
 * Whether a phone number already belongs to a patient who can sign in.
 *
 * "existing" means a claimant holds this number *and* has at least one
 * submitted case — exactly the condition `GET /patient/dashboard` requires, so
 * a patient told to sign in always lands somewhere. A claimant whose intake was
 * abandoned before submission is reported as "new": sending them to a login
 * that has nothing to show them would strand them, and they create no duplicate
 * by continuing, because `resolveClaimantForUser` already refuses to register
 * their number twice.
 */
export type RegistrationStatus = "new" | "existing";

export type RegistrationStatusResult =
  { status: RegistrationStatus; error?: undefined } | { status?: undefined; error: "registration_lookup_failed" };

/**
 * Answers that question for an unauthenticated caller, and answers nothing
 * else. The caller has proved nothing at this point in the flow, so the result
 * is one enum value: no name, no email, no case, no count, no identifier. The
 * number must already be normalised — comparing raw input against
 * claimants.mobile is how a formatting difference slips past the check.
 */
export async function resolveRegistrationStatus(mobile: string): Promise<RegistrationStatusResult> {
  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("id")
    .eq("mobile", mobile)
    .maybeSingle();

  if (claimantError) {
    console.error("registration status claimant lookup failed:", { code: claimantError.code });
    return { error: "registration_lookup_failed" };
  }

  if (!claimant) return { status: "new" };

  // Every submitted-case status, not 'submitted' alone: once the Admin Dashboard
  // accepts a case it is 'qualified', and that patient still has to be able to
  // sign in to reach their agreement.
  const { data: submitted, error: submittedError } = await supabase
    .from("intake_submissions")
    .select("id")
    .eq("claimant_id", claimant.id)
    .in("status", [...SUBMITTED_CASE_STATUSES])
    .limit(1);

  if (submittedError) {
    console.error("registration status submission lookup failed:", { code: submittedError.code });
    return { error: "registration_lookup_failed" };
  }

  return { status: (submitted ?? []).length > 0 ? "existing" : "new" };
}

/**
 * Resolves a submission the authenticated caller owns, without caring what
 * stage it has reached. Upload authorisation needs this: evidence is attached
 * while intake is still in progress.
 *
 * Ownership is established before anything else is read, and a submission the
 * caller does not own is indistinguishable from one that does not exist.
 */
export async function resolveOwnedSubmission(request: Request, submissionId: string): Promise<OwnedSubmissionResult> {
  const authUserId = request.user?.id;
  if (!authUserId) {
    // requireAuth should have refused already; failing closed rather than
    // trusting that it did.
    return { error: "submission_not_found" };
  }

  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("id, first_name, last_name, email")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (claimantError) {
    console.error("claimant lookup failed", { code: claimantError.code });
    return { error: "identity_lookup_failed" };
  }

  // No claimant means this patient owns nothing at all.
  if (!claimant) return { error: "submission_not_found" };

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id, claimant_id, status, locale")
    .eq("id", submissionId)
    .maybeSingle();

  if (submissionError) {
    console.error("submission lookup failed", { code: submissionError.code });
    return { error: "identity_lookup_failed" };
  }

  if (!submission) return { error: "submission_not_found" };

  // The assertion this module exists for. Checked before anything else is
  // reported, so status can never reveal that another patient's case exists.
  if (submission.claimant_id !== claimant.id) return { error: "submission_not_found" };

  return {
    submission: {
      submissionId: submission.id,
      claimantId: claimant.id,
      status: submission.status,
      locale: submission.locale,
      firstName: claimant.first_name,
      lastName: claimant.last_name,
      email: claimant.email,
    },
  };
}

/**
 * Resolves the claimant owned by the authenticated request. Dashboard loading
 * starts from the session itself, not from a submission id, so this helper
 * answers only "who is this patient?" and leaves case selection to the caller.
 */
export async function resolveClaimantForRequest(request: Request): Promise<RequestClaimantResult> {
  const authUserId = request.user?.id;
  if (!authUserId) {
    return { claimant: null };
  }

  const { data: claimant, error } = await supabase
    .from("claimants")
    .select("id, first_name, last_name, mobile, email")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("claimant lookup failed", { code: error.code });
    return { error: "identity_lookup_failed" };
  }

  if (!claimant) return { claimant: null };

  return {
    claimant: {
      claimantId: claimant.id,
      firstName: claimant.first_name,
      lastName: claimant.last_name,
      mobile: claimant.mobile,
      email: claimant.email,
    },
  };
}

/**
 * The signer behind a submission the authenticated caller owns and that has
 * actually been submitted. Agreement work uses this: an abandoned or
 * half-finished intake must not reach a signature.
 *
 * Any submitted-case status passes, because reading the agreement's status
 * stays open to its owner at every stage after intake. Whether a signing
 * session may be opened is a further rule the agreement route applies to
 * `status` (lib/case-status.ts).
 */
export async function resolveVerifiedPatient(request: Request, submissionId: string): Promise<PatientIdentityResult> {
  const owned = await resolveOwnedSubmission(request, submissionId);
  if (owned.error) return { error: owned.error };

  if (!isSubmittedCase(owned.submission.status)) {
    return { error: "submission_not_submitted" };
  }

  return {
    patient: {
      claimantId: owned.submission.claimantId,
      submissionId: owned.submission.submissionId,
      firstName: owned.submission.firstName,
      lastName: owned.submission.lastName,
      email: owned.submission.email,
      locale: owned.submission.locale,
      status: owned.submission.status,
    },
  };
}
