import { createHash, randomBytes } from "crypto";
import { storeSignedDocument } from "./agreement-document";
import { notifyCaseEvent } from "./case-notifications";
import { calculateReviewDecisionExpiry, calculateReviewLinkExpiry } from "./review-expiry";
import { supabase } from "./supabase";

// Handing a signed case to a lawyer — the one place a case becomes 'attorney'.
//
// It runs the moment the patient's retainer completes (routes/agreements.ts,
// straight after markSubmissionSigned moves the case to 'signed'), so nobody has
// to act. The Admin Dashboard's pass_to_lawyer runs the same thing for a case
// that is 'signed' but not with a lawyer: one signed before the handoff was
// automatic, or one whose automatic handoff could not finish.
//
// Either way the completed retainer's signed PDF must be stored first — the
// lawyer reviews that document — and at most one caller ever wins. The partial
// unique index on review_assignments (one pending assignment per case) refuses
// a second concurrent assignment, and the status moves only from 'signed'. Only
// the winner logs the decision and sends the lawyer notification, so a retried,
// repeated or concurrent completion, or an admin click racing it, cannot issue
// a second review link or a second message.

/** The case status a handoff starts from. */
export const HANDOFF_FROM_STATUS = "signed";

/**
 * Recorded as the actor of a handoff no person made. review_assignments and
 * review_decision_events need an actor id; like the link lawyer's all-zero id in
 * routes/portal.ts it is not a user. The decision event's metadata says
 * `automatic: true`.
 */
export const AUTOMATIC_HANDOFF_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

export type HandoffActor = { kind: "admin"; userId: string; role: "admin" | "lawyer" } | { kind: "automatic" };

export type HandoffError =
  | "submission_lookup_failed"
  | "submission_not_found"
  | "status_transition_not_allowed"
  | "retainer_lookup_failed"
  | "retainer_not_completed"
  | "retainer_document_unavailable"
  | "already_passed_to_lawyer"
  | "assignment_create_failed"
  | "decision_update_failed";

export type HandoffResult =
  | { ok: true; assignmentId: string; reviewLink: string; decisionLogged: boolean }
  | { ok: false; error: HandoffError; fromStatus?: string | null };

function createInviteToken() {
  const token = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

function reviewLinkFor(claimantUserId: string, submissionId: string, token: string): string {
  const appBase = (process.env.FRONTEND_URL ?? "").trim() || "http://localhost:3000";
  return `${appBase.replace(/\/+$/, "")}/en/review/${encodeURIComponent(claimantUserId)}?submissionId=${encodeURIComponent(submissionId)}&t=${encodeURIComponent(token)}`;
}

// The completed retainer, with its signed PDF in storage. Retrieval after
// completion can fail on its own (see storeSignedDocument), so a completed
// agreement without its PDF is retried here rather than handed on without it.
async function signedRetainerRecorded(
  submissionId: string
): Promise<"recorded" | "retainer_lookup_failed" | "retainer_not_completed" | "retainer_document_unavailable"> {
  const { data, error } = await supabase
    .from("agreements")
    .select("id, envelope_id, signed_document_path")
    .eq("submission_id", submissionId)
    .eq("status", "completed")
    .limit(1);

  if (error) {
    console.error("retainer completion lookup failed", { code: error.code, submissionId });
    return "retainer_lookup_failed";
  }

  const agreement = data?.[0];
  if (!agreement) return "retainer_not_completed";
  if (agreement.signed_document_path) return "recorded";
  if (!agreement.envelope_id) return "retainer_document_unavailable";

  const stored = await storeSignedDocument(agreement.id, submissionId, agreement.envelope_id);
  return stored === "failed" ? "retainer_document_unavailable" : "recorded";
}

export async function passCaseToLawyer(input: {
  submissionId: string;
  claimantUserId: string;
  actor: HandoffActor;
}): Promise<HandoffResult> {
  const { submissionId, claimantUserId, actor } = input;

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id, status")
    .eq("id", submissionId)
    .maybeSingle();

  if (submissionError) {
    console.error("handoff submission lookup failed", { code: submissionError.code, submissionId });
    return { ok: false, error: "submission_lookup_failed" };
  }
  if (!submission) return { ok: false, error: "submission_not_found" };

  const fromStatus = typeof submission.status === "string" ? submission.status : null;
  if (fromStatus !== HANDOFF_FROM_STATUS) {
    return { ok: false, error: "status_transition_not_allowed", fromStatus };
  }

  const retainer = await signedRetainerRecorded(submissionId);
  if (retainer !== "recorded") return { ok: false, error: retainer };

  const actorUserId = actor.kind === "admin" ? actor.userId : AUTOMATIC_HANDOFF_ACTOR_ID;
  const { token, tokenHash } = createInviteToken();
  const now = new Date();

  const { data: assignment, error: assignmentError } = await supabase
    .from("review_assignments")
    .insert({
      submission_id: submissionId,
      assigned_by_user_id: actorUserId,
      assignment_mode: "invite_link",
      status: "pending",
      review_link_token_hash: tokenHash,
      expires_at: calculateReviewLinkExpiry(now).toISOString(),
      decision_expires_at: calculateReviewDecisionExpiry(now).toISOString(),
    })
    .select("id")
    .single();

  // 23505: idx_review_assignments_pending_per_submission — another handoff of
  // this case got there first.
  if (assignmentError?.code === "23505") return { ok: false, error: "already_passed_to_lawyer" };
  if (assignmentError || !assignment?.id) {
    console.error("review assignment create failed", { code: assignmentError?.code, submissionId });
    return { ok: false, error: "assignment_create_failed" };
  }

  // Conditional on the status it moves away from: if the case left 'signed'
  // since it was read, this handoff withdraws its assignment and stops.
  const { data: moved, error: updateError } = await supabase
    .from("intake_submissions")
    .update({ status: "attorney" })
    .eq("id", submissionId)
    .eq("status", HANDOFF_FROM_STATUS)
    .select("id");

  if (updateError || !moved?.length) {
    await supabase.from("review_assignments").delete().eq("id", assignment.id);
    if (updateError) {
      console.error("handoff status update failed", { code: updateError.code, submissionId });
      return { ok: false, error: "decision_update_failed" };
    }
    return { ok: false, error: "already_passed_to_lawyer" };
  }

  const { error: eventError } = await supabase.from("review_decision_events").insert({
    submission_id: submissionId,
    assignment_id: assignment.id,
    claimant_user_id: claimantUserId,
    actor_user_id: actorUserId,
    actor_role: actor.kind === "admin" ? actor.role : "admin",
    action: "pass_to_lawyer",
    previous_status: HANDOFF_FROM_STATUS,
    next_status: "attorney",
    metadata:
      actor.kind === "automatic"
        ? { link_issued: true, automatic: true, trigger: "retainer_signed" }
        : { link_issued: true },
  });

  if (eventError) {
    console.error("review decision event insert failed", { code: eventError.code, submissionId });
  }

  const reviewLink = reviewLinkFor(claimantUserId, submissionId, token);

  // After the status is stored, and without holding anyone up: a failed send is
  // recorded in case_notifications and leaves the case with the lawyer.
  void notifyCaseEvent({
    submissionId,
    eventType: "attorney_review_ready",
    locale: "en",
    reviewLink,
  }).catch((error) => {
    console.error("attorney review ready notification failed", {
      submissionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  });

  return { ok: true, assignmentId: assignment.id, reviewLink, decisionLogged: !eventError };
}

/**
 * The automatic handoff, for a case markSubmissionSigned has just moved to
 * 'signed'. Never throws: the patient's signing has succeeded whatever happens
 * here, and a case it cannot hand on stays 'signed', where the Admin Dashboard
 * offers pass_to_lawyer.
 */
export async function passNewlySignedCaseToLawyer(submissionId: string, claimantId: string): Promise<void> {
  try {
    const { data: claimant, error } = await supabase
      .from("claimants")
      .select("user_id")
      .eq("id", claimantId)
      .maybeSingle();

    if (error || typeof claimant?.user_id !== "string") {
      console.error("automatic lawyer handoff claimant lookup failed", { code: error?.code, submissionId });
      return;
    }

    const result = await passCaseToLawyer({
      submissionId,
      claimantUserId: claimant.user_id,
      actor: { kind: "automatic" },
    });
    if (!result.ok && result.error !== "already_passed_to_lawyer") {
      console.error("automatic lawyer handoff did not complete", { submissionId, error: result.error });
    }
  } catch (error) {
    console.error("automatic lawyer handoff failed", {
      submissionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
}
