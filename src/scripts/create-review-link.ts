import "dotenv/config";
import { createHash, randomBytes } from "crypto";
import { calculateReviewDecisionExpiry, calculateReviewLinkExpiry } from "../lib/review-expiry";
import { supabase } from "../lib/supabase";

const FALLBACK_ISSUER_ID = "00000000-0000-0000-0000-000000000000";

type ScriptArgs = {
  claimantUserId: string;
  submissionId: string;
  frontendUrl: string;
};

function usage(): never {
  console.error(
    "Usage: tsx src/scripts/create-review-link.ts <claimantUserId> <submissionId> [frontendUrl]"
  );
  process.exit(1);
}

function asNonEmpty(value: string | undefined): string {
  return (value ?? "").trim();
}

function readArgs(): ScriptArgs {
  const [, , claimantUserIdRaw, submissionIdRaw, frontendUrlRaw] = process.argv;
  const claimantUserId = asNonEmpty(claimantUserIdRaw);
  const submissionId = asNonEmpty(submissionIdRaw);

  if (!claimantUserId || !submissionId) usage();

  const frontendUrl =
    asNonEmpty(frontendUrlRaw) || asNonEmpty(process.env.FRONTEND_URL) || "http://localhost:3000";

  return {
    claimantUserId,
    submissionId,
    frontendUrl,
  };
}

function createTokenPair() {
  const token = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

async function main() {
  const args = readArgs();

  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("id")
    .eq("user_id", args.claimantUserId)
    .maybeSingle();

  if (claimantError) {
    console.error("Failed claimant lookup", { code: claimantError.code, message: claimantError.message });
    process.exit(1);
  }

  if (!claimant?.id) {
    console.error("No claimant found for user id", args.claimantUserId);
    process.exit(1);
  }

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id, claimant_id")
    .eq("id", args.submissionId)
    .eq("claimant_id", claimant.id)
    .maybeSingle();

  if (submissionError) {
    console.error("Failed submission lookup", { code: submissionError.code, message: submissionError.message });
    process.exit(1);
  }

  if (!submission?.id) {
    console.error("Submission not found for claimant", {
      claimantUserId: args.claimantUserId,
      submissionId: args.submissionId,
    });
    process.exit(1);
  }

  const now = new Date().toISOString();
  const { error: revokeError } = await supabase
    .from("review_assignments")
    .update({ status: "revoked", revoked_at: now })
    .eq("submission_id", submission.id)
    .eq("status", "pending");

  if (revokeError) {
    console.error("Failed to revoke existing pending assignments", {
      code: revokeError.code,
      message: revokeError.message,
    });
    process.exit(1);
  }

  const { token, tokenHash } = createTokenPair();
  const issuedAt = new Date();
  const expiresAt = calculateReviewLinkExpiry(issuedAt).toISOString();
  const decisionExpiresAt = calculateReviewDecisionExpiry(issuedAt).toISOString();
  const assignedBy = asNonEmpty(process.env.REVIEW_LINK_ISSUER_USER_ID) || FALLBACK_ISSUER_ID;

  const { data: assignment, error: insertError } = await supabase
    .from("review_assignments")
    .insert({
      submission_id: submission.id,
      assigned_by_user_id: assignedBy,
      assignment_mode: "invite_link",
      status: "pending",
      review_link_token_hash: tokenHash,
      expires_at: expiresAt,
      decision_expires_at: decisionExpiresAt,
    })
    .select("id")
    .single();

  if (insertError || !assignment?.id) {
    console.error("Failed to create review assignment", {
      code: insertError?.code,
      message: insertError?.message,
    });
    process.exit(1);
  }

  const base = args.frontendUrl.replace(/\/+$/, "");
  const link = `${base}/en/review/${encodeURIComponent(args.claimantUserId)}?submissionId=${encodeURIComponent(
    submission.id
  )}&t=${encodeURIComponent(token)}`;

  console.log("Review link created");
  console.log(link);
  console.log(
    JSON.stringify(
      {
        assignmentId: assignment.id,
        claimantUserId: args.claimantUserId,
        submissionId: submission.id,
        expiresAt,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Unexpected error", error);
  process.exit(1);
});
