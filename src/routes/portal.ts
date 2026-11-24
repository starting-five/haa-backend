import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { supabase } from "../lib/supabase";
import { AGREEMENTS_BUCKET, signedDocumentPath } from "../lib/agreement-document";
import {
  belongsToCase,
  buildLawyerReviewCase,
  contentDisposition,
  documentKindFor,
  isUuid,
  resolveReviewAccess,
  reviewFileName,
  servedContentType,
  signedRetainerPath,
  type ReviewAssignmentRow,
  type StoredFile,
} from "../lib/lawyer-review";
import { notifyCaseEvent } from "../lib/case-notifications";
import { passCaseToLawyer, type HandoffError } from "../lib/lawyer-handoff";
import { requireAuth } from "../middleware/auth";
import { denyPatientSession, requireAdminUser } from "../middleware/portal";
import { DOCUMENTS_BUCKET, normalizeStoragePath } from "./intake";

export const portalRouter = Router();

// Routes for the Admin Dashboard only; see requireAdminUser.
const adminOnly = [requireAuth, denyPatientSession, requireAdminUser];

type ReviewDecisionAction = "pass_to_lawyer" | "approve_for_retainer" | "reject_case" | "accept_case";
type ReviewActorRole = "admin" | "lawyer";
const LINK_LAWYER_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function statusForDecision(action: ReviewDecisionAction): string {
  if (action === "pass_to_lawyer") return "attorney";
  if (action === "approve_for_retainer") return "retainer_pending_signature";
  if (action === "accept_case") return "qualified";
  return "not_qualified";
}

function canApplyDecision(action: ReviewDecisionAction, currentStatus: string | null): boolean {
  const status = currentStatus ?? "";

  if (action === "approve_for_retainer") return status === "submitted";
  if (action === "pass_to_lawyer") return status === "signed";

  // Existing behavior for final outcomes remains unchanged.
  return true;
}

// How the Admin Dashboard's pass_to_lawyer reports a handoff that did not happen.
const HANDOFF_ERROR_STATUS: Record<HandoffError, number> = {
  submission_lookup_failed: 500,
  submission_not_found: 404,
  status_transition_not_allowed: 409,
  retainer_lookup_failed: 500,
  retainer_not_completed: 409,
  retainer_document_unavailable: 409,
  already_passed_to_lawyer: 409,
  assignment_create_failed: 500,
  decision_update_failed: 500,
};

function hashReviewToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type ReviewAssignment = {
  id: string;
  submission_id: string;
  status: string;
  expires_at: string | null;
  decision_expires_at: string | null;
  revoked_at: string | null;
  token_use_count: number | null;
  token_max_uses: number | null;
};

function isExpired(isoTime: string | null): boolean {
  if (!isoTime) return false;
  const value = Date.parse(isoTime);
  if (Number.isNaN(value)) return true;
  return value <= Date.now();
}

async function resolveClaimantSubmission(claimantUserId: string, submissionId: string) {
  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("id, first_name, last_name, mobile")
    .eq("user_id", claimantUserId)
    .maybeSingle();

  if (claimantError) {
    return { error: "claimant_lookup_failed" as const };
  }

  if (!claimant) {
    return { error: "claimant_not_found" as const };
  }

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id, claimant_id, status, locale")
    .eq("id", submissionId)
    .eq("claimant_id", claimant.id)
    .maybeSingle();

  if (submissionError) {
    return { error: "submission_lookup_failed" as const };
  }

  if (!submission) {
    return { error: "submission_not_found" as const };
  }

  return { claimant, submission };
}

async function getValidReviewAssignment(submissionId: string, token: string) {
  const tokenHash = hashReviewToken(token);
  const { data: assignment, error } = await supabase
    .from("review_assignments")
    .select("id, submission_id, status, expires_at, decision_expires_at, revoked_at, token_use_count, token_max_uses")
    .eq("submission_id", submissionId)
    .eq("review_link_token_hash", tokenHash)
    .maybeSingle<ReviewAssignment>();

  if (error) {
    return { error: "assignment_lookup_failed" as const };
  }

  if (!assignment) {
    return { error: "invalid_token" as const };
  }

  if (assignment.revoked_at) {
    return { error: "token_revoked" as const };
  }

  if (isExpired(assignment.expires_at)) {
    return { error: "token_expired" as const };
  }

  const useCount = assignment.token_use_count ?? 0;
  const maxUses = assignment.token_max_uses ?? 20;
  if (useCount >= maxUses) {
    return { error: "token_usage_exceeded" as const };
  }

  return { assignment };
}

portalRouter.post("/review-access/verify", async (req: Request, res: Response) => {
  const claimantUserId = asString((req.body as { claimantUserId?: unknown } | undefined)?.claimantUserId);
  const submissionId = asString((req.body as { submissionId?: unknown } | undefined)?.submissionId);
  const token = asString((req.body as { token?: unknown } | undefined)?.token);

  if (!claimantUserId || !submissionId || !token) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const resolved = await resolveClaimantSubmission(claimantUserId, submissionId);
  if ("error" in resolved) {
    const status = resolved.error === "claimant_not_found" || resolved.error === "submission_not_found" ? 404 : 500;
    res.status(status).json({ error: resolved.error });
    return;
  }

  const assignmentResult = await getValidReviewAssignment(submissionId, token);
  if ("error" in assignmentResult) {
    const status = assignmentResult.error === "assignment_lookup_failed" ? 500 : 401;
    res.status(status).json({ error: assignmentResult.error });
    return;
  }

  const assignment = assignmentResult.assignment;
  const { error: usageError } = await supabase
    .from("review_assignments")
    .update({
      token_use_count: (assignment.token_use_count ?? 0) + 1,
      last_token_used_at: new Date().toISOString(),
    })
    .eq("id", assignment.id);

  if (usageError) {
    console.error("review token usage update failed", { code: usageError.code });
    res.status(500).json({ error: "token_usage_update_failed" });
    return;
  }

  res.status(200).json({
    ok: true,
    assignmentId: assignment.id,
    submissionId,
    claimantUserId,
    status: assignment.status,
    canDecide: assignment.status === "pending" && !isExpired(assignment.decision_expires_at),
    expiresAt: assignment.expires_at,
    decisionExpiresAt: assignment.decision_expires_at,
    remainingUses: Math.max((assignment.token_max_uses ?? 20) - ((assignment.token_use_count ?? 0) + 1), 0),
  });
});

// The case as the lawyer's review link may see it — called by the review page
// on every render, never from the browser. The link's token is the credential:
// it has to match an assignment for this submission, and that assignment row,
// not anything in the request, decides what is returned. Until the lawyer has
// accepted, the patient's identity and contact details, the names and contact
// details of the people who were with them and the files' own names are not
// loaded at all; see lib/lawyer-review.ts. The files themselves are listed by
// id while the link may open them and fetched one at a time from
// POST /review-document. Opening the case does not count as a use of the link —
// POST /review-access/verify counts opens.
portalRouter.post("/review-case", async (req: Request, res: Response) => {
  const claimantUserId = asString((req.body as { claimantUserId?: unknown } | undefined)?.claimantUserId);
  const submissionId = asString((req.body as { submissionId?: unknown } | undefined)?.submissionId);
  const token = asString((req.body as { token?: unknown } | undefined)?.token);

  if (!claimantUserId || !submissionId || !token || !isUuid(claimantUserId) || !isUuid(submissionId)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("review_assignments")
    .select("id, submission_id, status, expires_at, decision_expires_at, revoked_at, accepted_at")
    .eq("submission_id", submissionId)
    .eq("review_link_token_hash", hashReviewToken(token))
    .maybeSingle<ReviewAssignmentRow>();

  if (assignmentError) {
    console.error("review case assignment lookup failed", { code: assignmentError.code });
    res.status(500).json({ error: "assignment_lookup_failed" });
    return;
  }

  if (!assignment) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  // The link names the patient too; a link for this submission and someone
  // else's user id is not a link to anything. Answered like a bad token, so
  // the response says nothing about which half was wrong.
  const resolved = await resolveClaimantSubmission(claimantUserId, submissionId);
  if ("error" in resolved) {
    const notFound = resolved.error === "claimant_not_found" || resolved.error === "submission_not_found";
    res.status(notFound ? 401 : 500).json({ error: notFound ? "invalid_token" : resolved.error });
    return;
  }

  const access = resolveReviewAccess(assignment);
  if (access.state === "revoked") {
    res.status(401).json({ error: "token_revoked" });
    return;
  }

  const unlocked = access.unlocked;
  const documentColumns = unlocked
    ? "id, category, file_name, mime_type, file_size, storage_path"
    : access.documents
      ? "id, category, mime_type, file_size, storage_path"
      : "category";
  const [submissionResult, accidentResult, companionsResult, documentsResult, claimantResult] = await Promise.all([
    supabase
      .from("intake_submissions")
      .select(unlocked ? "locale, treatment_area" : "locale")
      .eq("id", submissionId)
      .maybeSingle(),
    supabase
      .from("accidents")
      .select("incident_type, role, description, injuries, incident_date, incident_location")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("submission_companions")
      .select(unlocked ? "first_name, last_name, relation, cell_number, email" : "relation")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: true }),
    supabase
      .from("documents")
      .select(documentColumns)
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: true }),
    unlocked
      ? supabase
          .from("claimants")
          .select("first_name, last_name, mobile, email, residence")
          .eq("id", resolved.claimant.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const loadError =
    submissionResult.error ??
    accidentResult.error ??
    companionsResult.error ??
    documentsResult.error ??
    claimantResult.error;
  if (loadError) {
    console.error("review case load failed", { code: loadError.code });
    res.status(500).json({ error: "case_load_failed" });
    return;
  }

  // That a retainer is signed, before acceptance; where it is kept, after.
  const { data: agreementRow, error: agreementError } = await supabase
    .from("agreements")
    .select(unlocked ? "id, status, signed_document_path" : "status")
    .eq("submission_id", submissionId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (agreementError) {
    console.error("review case agreement lookup failed", { code: agreementError.code });
    res.status(500).json({ error: "case_load_failed" });
    return;
  }

  // Offered only when Storage holds the signed document at this case's own path.
  const agreement = agreementRow as Record<string, unknown> | null;
  let retainerStored = false;
  const retainerPath = unlocked ? signedRetainerPath(agreement, (id) => signedDocumentPath(submissionId, id)) : null;
  if (retainerPath) {
    const { data: objects, error: listError } = await supabase.storage
      .from(AGREEMENTS_BUCKET)
      .list(submissionId, { limit: 100 });
    if (listError) console.error("review case retainer listing failed", { message: listError.message });
    retainerStored = (objects ?? []).some((object) => `${submissionId}/${object.name}` === retainerPath);
  }

  const documents = (documentsResult.data ?? []) as unknown as Record<string, unknown>[];
  const storedFiles = new Map<string, StoredFile>();
  if (access.documents) {
    // Only this case's own files: a row whose path leaves the submission's
    // folder is never listed as openable, whatever it says.
    const ownFiles = documents
      .map((document) => (typeof document.storage_path === "string" ? document.storage_path : ""))
      .filter((storagePath) => storagePath.length > 0)
      .map((storagePath) => ({ storagePath, objectPath: normalizeStoragePath(storagePath) }))
      .filter(({ objectPath }) => belongsToCase(objectPath, submissionId));

    // The type Storage will serve each object as — not the type the upload
    // claimed in the documents row — decides whether it may be opened in the
    // browser or only downloaded. An object Storage does not hold cannot be opened.
    const storedTypes = new Map<string, string | null>();
    const folders = [...new Set(ownFiles.map(({ objectPath }) => objectPath.slice(0, objectPath.lastIndexOf("/"))))];
    for (const folder of folders) {
      const { data: objects, error: listError } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .list(folder, { limit: 1000 });
      if (listError) {
        console.error("review case document listing failed", { message: listError.message });
        continue;
      }
      for (const object of objects ?? []) {
        const mimetype = (object.metadata as { mimetype?: unknown } | null)?.mimetype;
        storedTypes.set(`${folder}/${object.name}`, typeof mimetype === "string" ? mimetype : null);
      }
    }

    for (const { storagePath, objectPath } of ownFiles) {
      if (!storedTypes.has(objectPath)) continue;
      const mimeType = storedTypes.get(objectPath) ?? null;
      storedFiles.set(storagePath, { kind: documentKindFor(mimeType), mimeType });
    }
  }

  res.status(200).json(
    buildLawyerReviewCase(
      access,
      {
        submission: submissionResult.data as Record<string, unknown> | null,
        accident: accidentResult.data as Record<string, unknown> | null,
        claimant: claimantResult.data as Record<string, unknown> | null,
        companions: (companionsResult.data ?? []) as unknown as Record<string, unknown>[],
        documents,
        storedFiles,
        agreement,
        retainerStored,
      },
      assignment.decision_expires_at
    )
  );
});

// One file of the case, streamed back for the review page's document route to
// pass on to the lawyer. The credential is the one /review-case takes: the
// link's token has to match an assignment for this submission and the user id
// has to be the submission's claimant. Only the document id comes from the
// caller, and it is looked up within this submission; the stored path must sit
// inside the submission's own folder. A document of another case, an unknown
// id and a file Storage does not hold are all answered 404 document_not_found,
// so the answer says nothing about other cases.
//
// Files can be opened while the link is open for a decision and after the
// lawyer has accepted — not after a rejection or once the link has expired
// (403), and never through a revoked link (401). This is checked on every
// request, so a decision or a revocation takes effect for a page already open.
// Before acceptance a file is offered under a neutral name; see
// reviewFileName. Opening a file does not count as a use of the link.
portalRouter.post("/review-document", async (req: Request, res: Response) => {
  const body = req.body as { claimantUserId?: unknown; submissionId?: unknown; token?: unknown; documentId?: unknown };
  const claimantUserId = asString(body?.claimantUserId);
  const submissionId = asString(body?.submissionId);
  const token = asString(body?.token);
  const documentId = asString(body?.documentId);

  if (
    !claimantUserId ||
    !submissionId ||
    !token ||
    !documentId ||
    !isUuid(claimantUserId) ||
    !isUuid(submissionId) ||
    !isUuid(documentId)
  ) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("review_assignments")
    .select("id, submission_id, status, expires_at, decision_expires_at, revoked_at, accepted_at")
    .eq("submission_id", submissionId)
    .eq("review_link_token_hash", hashReviewToken(token))
    .maybeSingle<ReviewAssignmentRow>();

  if (assignmentError) {
    console.error("review document assignment lookup failed", { code: assignmentError.code });
    res.status(500).json({ error: "assignment_lookup_failed" });
    return;
  }

  if (!assignment) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const resolved = await resolveClaimantSubmission(claimantUserId, submissionId);
  if ("error" in resolved) {
    const notFound = resolved.error === "claimant_not_found" || resolved.error === "submission_not_found";
    res.status(notFound ? 401 : 500).json({ error: notFound ? "invalid_token" : resolved.error });
    return;
  }

  const access = resolveReviewAccess(assignment);
  if (access.state === "revoked") {
    res.status(401).json({ error: "token_revoked" });
    return;
  }

  if (!access.documents) {
    res.status(403).json({ error: "documents_unavailable" });
    return;
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select(access.unlocked ? "id, category, file_name, storage_path" : "id, category, storage_path")
    .eq("id", documentId)
    .eq("submission_id", submissionId)
    .maybeSingle<Record<string, unknown>>();

  if (documentError) {
    console.error("review document lookup failed", { code: documentError.code });
    res.status(500).json({ error: "document_lookup_failed" });
    return;
  }

  const storagePath = typeof document?.storage_path === "string" ? document.storage_path : "";
  const objectPath = storagePath ? normalizeStoragePath(storagePath) : "";
  if (!document || !objectPath || !belongsToCase(objectPath, submissionId)) {
    res.status(404).json({ error: "document_not_found" });
    return;
  }

  const { data: file, error: downloadError } = await supabase.storage.from(DOCUMENTS_BUCKET).download(objectPath);
  if (downloadError || !file) {
    console.error("review document download failed", { message: downloadError?.message });
    res.status(404).json({ error: "document_not_found" });
    return;
  }

  // The type Storage serves the object as, not the one the upload claimed.
  const storedType = file.type || null;
  const kind = documentKindFor(storedType);
  const fileName = reviewFileName(
    {
      id: documentId,
      category: typeof document.category === "string" ? document.category : "",
      fileName: access.unlocked && typeof document.file_name === "string" ? document.file_name : null,
      objectPath,
    },
    kind,
    storedType,
    access.unlocked
  );
  const bytes = Buffer.from(await file.arrayBuffer());

  res
    .status(200)
    .set({
      "Content-Type": servedContentType(kind, storedType),
      "Content-Disposition": contentDisposition(kind, fileName),
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    })
    .send(bytes);
});

// The patient's signed retainer, for a lawyer who has accepted the case. The
// credential is the one /review-case takes, and nothing else: there is no
// document id to send, because the retainer is resolved from this submission's
// own completed agreement and served only from the path it was stored under
// (agreements/<submissionId>/<agreementId>.pdf). Before acceptance, after a
// rejection and once the link has expired it is refused (403); through a
// revoked link, or a link for another case or patient, it is refused as a bad
// token (401). Checked on every request. Served as it was stored: DocuSign is
// not asked again and nothing is written.
portalRouter.post("/review-retainer", async (req: Request, res: Response) => {
  const body = req.body as { claimantUserId?: unknown; submissionId?: unknown; token?: unknown };
  const claimantUserId = asString(body?.claimantUserId);
  const submissionId = asString(body?.submissionId);
  const token = asString(body?.token);

  if (!claimantUserId || !submissionId || !token || !isUuid(claimantUserId) || !isUuid(submissionId)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("review_assignments")
    .select("id, submission_id, status, expires_at, decision_expires_at, revoked_at, accepted_at")
    .eq("submission_id", submissionId)
    .eq("review_link_token_hash", hashReviewToken(token))
    .maybeSingle<ReviewAssignmentRow>();

  if (assignmentError) {
    console.error("review retainer assignment lookup failed", { code: assignmentError.code });
    res.status(500).json({ error: "assignment_lookup_failed" });
    return;
  }

  if (!assignment) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const resolved = await resolveClaimantSubmission(claimantUserId, submissionId);
  if ("error" in resolved) {
    const notFound = resolved.error === "claimant_not_found" || resolved.error === "submission_not_found";
    res.status(notFound ? 401 : 500).json({ error: notFound ? "invalid_token" : resolved.error });
    return;
  }

  const access = resolveReviewAccess(assignment);
  if (access.state === "revoked") {
    res.status(401).json({ error: "token_revoked" });
    return;
  }

  // Only an accepted link, with its acceptance recorded and inside its deadline.
  if (!access.unlocked) {
    res.status(403).json({ error: "retainer_unavailable" });
    return;
  }

  const { data: agreement, error: agreementError } = await supabase
    .from("agreements")
    .select("id, status, signed_document_path")
    .eq("submission_id", submissionId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, unknown>>();

  if (agreementError) {
    console.error("review retainer agreement lookup failed", { code: agreementError.code });
    res.status(500).json({ error: "retainer_lookup_failed" });
    return;
  }

  const objectPath = signedRetainerPath(agreement, (id) => signedDocumentPath(submissionId, id));
  if (!objectPath) {
    res.status(404).json({ error: "retainer_not_found" });
    return;
  }

  const { data: file, error: downloadError } = await supabase.storage.from(AGREEMENTS_BUCKET).download(objectPath);
  if (downloadError || !file) {
    console.error("review retainer download failed", { message: downloadError?.message });
    res.status(404).json({ error: "retainer_not_found" });
    return;
  }

  // Served inline as a PDF only if it is one: the bytes, not the stored type, decide.
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    console.error("review retainer is not a PDF", { submissionId });
    res.status(404).json({ error: "retainer_not_found" });
    return;
  }

  res
    .status(200)
    .set({
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition("pdf", "Signed Retainer.pdf"),
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    })
    .send(bytes);
});

// The lawyer's accept or reject, from the review page. The assignment is the
// one the link's token belongs to — an assignment id in the body is ignored,
// because an id is not a credential and every lawyer who opened the link has
// seen its ids. The decision is recorded only while the assignment is still
// pending, unrevoked and inside its deadline, checked again in the update
// itself so a decision racing the deadline cannot land after it.
portalRouter.post("/review-decision-link", async (req: Request, res: Response) => {
  const claimantUserId = asString((req.body as { claimantUserId?: unknown } | undefined)?.claimantUserId);
  const submissionId = asString((req.body as { submissionId?: unknown } | undefined)?.submissionId);
  const token = asString((req.body as { token?: unknown } | undefined)?.token);
  const actionRaw = asString((req.body as { action?: unknown } | undefined)?.action);

  if (!claimantUserId || !submissionId || !token || !isUuid(claimantUserId) || !isUuid(submissionId)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  if (actionRaw !== "reject_case" && actionRaw !== "accept_case") {
    res.status(400).json({ error: "invalid_action" });
    return;
  }

  const action = actionRaw as Extract<ReviewDecisionAction, "reject_case" | "accept_case">;
  const resolved = await resolveClaimantSubmission(claimantUserId, submissionId);
  if ("error" in resolved) {
    const status = resolved.error === "claimant_not_found" || resolved.error === "submission_not_found" ? 404 : 500;
    res.status(status).json({ error: resolved.error });
    return;
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from("review_assignments")
    .select("id, submission_id, status, expires_at, decision_expires_at, revoked_at")
    .eq("submission_id", submissionId)
    .eq("review_link_token_hash", hashReviewToken(token))
    .maybeSingle();

  if (assignmentError) {
    console.error("review decision assignment lookup failed", { code: assignmentError.code });
    res.status(500).json({ error: "assignment_lookup_failed" });
    return;
  }

  if (!assignment) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const assignmentId: string = assignment.id;

  if (assignment.status !== "pending") {
    res.status(409).json({ error: "decision_already_submitted" });
    return;
  }

  if (assignment.revoked_at || isExpired(assignment.expires_at)) {
    res.status(401).json({ error: "assignment_not_active" });
    return;
  }

  if (isExpired(assignment.decision_expires_at)) {
    res.status(409).json({ error: "decision_window_expired" });
    return;
  }

  const previousStatus = typeof resolved.submission.status === "string" ? resolved.submission.status : null;
  const nextStatus = statusForDecision(action);
  const assignmentStatus = action === "accept_case" ? "accepted" : "rejected";
  const now = new Date().toISOString();

  const { data: finalizedAssignment, error: assignmentUpdateError } = await supabase
    .from("review_assignments")
    .update({
      status: assignmentStatus,
      accepted_at: action === "accept_case" ? now : null,
      rejected_at: action === "reject_case" ? now : null,
    })
    .eq("id", assignmentId)
    .eq("submission_id", submissionId)
    .eq("status", "pending")
    .is("revoked_at", null)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .or(`decision_expires_at.is.null,decision_expires_at.gt.${now}`)
    .select("id")
    .maybeSingle();

  if (assignmentUpdateError) {
    console.error("review assignment finalization failed", { code: assignmentUpdateError.code });
    res.status(500).json({ error: "assignment_update_failed" });
    return;
  }

  if (!finalizedAssignment) {
    // Nothing matched: another decision landed first, or the deadline passed
    // between the check above and the update.
    if (isExpired(assignment.expires_at)) {
      res.status(401).json({ error: "assignment_not_active" });
      return;
    }
    if (isExpired(assignment.decision_expires_at)) {
      res.status(409).json({ error: "decision_window_expired" });
      return;
    }
    res.status(409).json({ error: "decision_already_submitted" });
    return;
  }

  const { error: updateError } = await supabase
    .from("intake_submissions")
    .update({ status: nextStatus })
    .eq("id", submissionId);

  if (updateError) {
    console.error("review decision (link) update failed", { code: updateError.code });
    res.status(500).json({ error: "decision_update_failed" });
    return;
  }

  const { error: eventError } = await supabase.from("review_decision_events").insert({
    submission_id: submissionId,
    assignment_id: assignmentId,
    claimant_user_id: claimantUserId,
    actor_user_id: LINK_LAWYER_ACTOR_ID,
    actor_role: "lawyer",
    action,
    previous_status: previousStatus,
    next_status: nextStatus,
    metadata: { source: "review_link" },
  });

  if (eventError) {
    console.error("review decision link event insert failed", { code: eventError.code });
  }

  if (action === "accept_case") {
    void notifyCaseEvent({
      submissionId,
      eventType: "patient_case_accepted",
      claimantMobile: resolved.claimant.mobile,
      locale: asString(resolved.submission.locale) || "en",
    }).catch((error) => {
      console.error("patient case accepted notification failed", {
        submissionId,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });
  }

  res.status(200).json({
    ok: true,
    action,
    status: nextStatus,
    submissionId,
    assignmentId,
    canDecide: false,
  });
});

async function resolveActorRole(actorUserId: string): Promise<ReviewActorRole> {
  const { data: roles, error } = await supabase.from("user_roles").select("role").eq("user_id", actorUserId);

  if (error) {
    console.error("review decision role lookup failed", { code: error.code });
    return "admin";
  }

  const hasLawyerRole = (roles ?? []).some((row) => row && typeof row.role === "string" && row.role === "lawyer");
  return hasLawyerRole ? "lawyer" : "admin";
}

// Admin Dashboard decisions: pass a case to a lawyer (minting the review link), accept or reject it.
portalRouter.post("/review-decision", adminOnly, async (req: Request, res: Response) => {
  const actorUserId = asString(req.user?.id);
  if (!actorUserId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const claimantUserId = asString((req.body as { claimantUserId?: unknown } | undefined)?.claimantUserId);
  const submissionId = asString((req.body as { submissionId?: unknown } | undefined)?.submissionId);
  const actionRaw = asString((req.body as { action?: unknown } | undefined)?.action);

  if (!claimantUserId) {
    res.status(400).json({ error: "missing_claimant_user_id" });
    return;
  }

  if (!submissionId) {
    res.status(400).json({ error: "missing_submission_id" });
    return;
  }

  if (
    actionRaw !== "pass_to_lawyer" &&
    actionRaw !== "approve_for_retainer" &&
    actionRaw !== "reject_case" &&
    actionRaw !== "accept_case"
  ) {
    res.status(400).json({ error: "invalid_action" });
    return;
  }

  const action = actionRaw as ReviewDecisionAction;

  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("id, first_name, last_name, mobile")
    .eq("user_id", claimantUserId)
    .maybeSingle();

  if (claimantError) {
    console.error("review decision claimant lookup failed", { code: claimantError.code });
    res.status(500).json({ error: "claimant_lookup_failed" });
    return;
  }

  if (!claimant) {
    res.status(404).json({ error: "claimant_not_found" });
    return;
  }

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id, claimant_id, status, locale")
    .eq("id", submissionId)
    .eq("claimant_id", claimant.id)
    .maybeSingle();

  if (submissionError) {
    console.error("review decision submission lookup failed", { code: submissionError.code });
    res.status(500).json({ error: "submission_lookup_failed" });
    return;
  }

  if (!submission) {
    res.status(404).json({ error: "submission_not_found" });
    return;
  }

  const previousStatus = typeof submission.status === "string" ? submission.status : null;

  if (!canApplyDecision(action, previousStatus)) {
    res.status(409).json({
      error: "status_transition_not_allowed",
      action,
      fromStatus: previousStatus,
    });
    return;
  }

  const actorRole = await resolveActorRole(actorUserId);

  // The same handoff signing completion runs (lib/lawyer-handoff.ts), for a case
  // that is 'signed' but not with a lawyer: signed before the handoff was
  // automatic, or one whose automatic handoff could not finish.
  if (action === "pass_to_lawyer") {
    const handoff = await passCaseToLawyer({
      submissionId: submission.id,
      claimantUserId,
      actor: { kind: "admin", userId: actorUserId, role: actorRole },
    });

    if (!handoff.ok) {
      res
        .status(HANDOFF_ERROR_STATUS[handoff.error])
        .json(
          handoff.error === "status_transition_not_allowed"
            ? { error: handoff.error, action, fromStatus: handoff.fromStatus ?? null }
            : { error: handoff.error }
        );
      return;
    }

    res.status(200).json({
      ok: true,
      action,
      status: "attorney",
      submissionId: submission.id,
      assignmentId: handoff.assignmentId,
      decisionLogged: handoff.decisionLogged,
      reviewLink: handoff.reviewLink,
    });
    return;
  }

  const nextStatus = statusForDecision(action);

  const updateError =
    nextStatus === previousStatus
      ? null
      : (await supabase.from("intake_submissions").update({ status: nextStatus }).eq("id", submission.id)).error;

  if (updateError) {
    console.error("review decision update failed", { code: updateError.code });
    res.status(500).json({ error: "decision_update_failed" });
    return;
  }

  const { error: eventError } = await supabase.from("review_decision_events").insert({
    submission_id: submission.id,
    assignment_id: null,
    claimant_user_id: claimantUserId,
    actor_user_id: actorUserId,
    actor_role: actorRole,
    action,
    previous_status: previousStatus,
    next_status: nextStatus,
    metadata: {},
  });

  const decisionLogged = !eventError;
  if (eventError) {
    console.error("review decision event insert failed", { code: eventError.code });
  }

  if (action === "approve_for_retainer") {
    const claimantWithPhone = claimant as {
      id: string;
      first_name?: string | null;
      last_name?: string | null;
      mobile?: string | null;
    };
    void notifyCaseEvent({
      submissionId: submission.id,
      eventType: "patient_retainer_ready",
      claimantFirstName: claimantWithPhone.first_name ?? "",
      claimantLastName: claimantWithPhone.last_name ?? "",
      ...(claimantWithPhone.mobile ? { claimantMobile: claimantWithPhone.mobile } : {}),
      locale: submission.locale === "es" ? "es" : "en",
      claimantId: claimant.id,
    }).catch((error) => {
      console.error("patient retainer ready notification failed", {
        submissionId: submission.id,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    });
  }

  res.status(200).json({
    ok: true,
    action,
    status: nextStatus,
    submissionId: submission.id,
    assignmentId: null,
    decisionLogged,
  });
});

// Every submission with the claimant's name and contact details and the accident — admins only.
portalRouter.get("/submissions", adminOnly, async (req: Request, res: Response) => {
  const { data: submissions, error } = await supabase
    .from("intake_submissions")
    .select("id, status, submitted_at, locale, claimant_id")
    .order("submitted_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: "Failed to load submissions" });
    return;
  }

  const enriched = await Promise.all(
    submissions.map(async (s) => {
      const [{ data: claimant }, { data: accident }] = await Promise.all([
        supabase
          .from("claimants")
          .select("first_name, last_name, mobile, email, residence")
          .eq("id", s.claimant_id)
          .single(),
        supabase
          .from("accidents")
          .select("incident_type, incident_location, description, role")
          .eq("submission_id", s.id)
          .single(),
      ]);
      return { ...s, claimant, accident };
    })
  );

  res.json(enriched);
});

// Step 1: check email and save info — does NOT create auth account
portalRouter.post("/lawyer/profile", requireAuth, denyPatientSession, async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { firstName, lastName, email, practice, role } = req.body;

  const { error } = await supabase.from("lawyers").upsert(
    {
      user_id: user.id,
      phone: user.phone ?? "",
      email: email ?? null,
      first_name: firstName ?? null,
      last_name: lastName ?? null,
      practice: practice ?? null,
      role: role ?? null,
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("lawyers upsert failed:", { code: error.code });
    res.status(500).json({ error: "Failed to save profile" });
    return;
  }

  res.status(200).json({ status: "ok" });
});
