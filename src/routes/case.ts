import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { resolveOwnedSubmission, type OwnedSubmission } from "../lib/patient-identity";
import { canEditCaseSummary, SUBMITTED_CASE_STATUSES } from "../lib/case-status";
import { parseCaseSummaryUpdate } from "../lib/case-summary";
import { locationColumnNames, locationColumns, locationDetailsFromRow } from "../lib/location-columns";
import { DOCUMENTS_BUCKET, normalizeStoragePath } from "./intake";
import { belongsToCase, contentDisposition, documentKindFor, servedContentType } from "../lib/lawyer-review";
import type { CaseCompanionInput, CaseDocumentInput, CaseSummary } from "../types/case";

export const caseRouter = Router();

type CaseSummaryLoad = { summary: CaseSummary } | { error: string };

/**
 * Everything Case Summary shows, for a submission the caller has already been
 * shown to own. Companions come with the cell number and email the patient gave
 * for them, because the patient may correct those; they reach no one else here.
 */
async function loadCaseSummary(owned: OwnedSubmission): Promise<CaseSummaryLoad> {
  const submissionId = owned.submissionId;

  const { data: submission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select(["id", "status", "submitted_at", "treatment_area", ...locationColumnNames("treatment_area")].join(", "))
    .eq("id", submissionId)
    .single();

  if (submissionError || !submission) {
    console.error("intake_submissions select failed:", { code: submissionError?.code });
    return { error: "Failed to load case details" };
  }

  // A case exists from the moment the number is verified, and the accident is
  // written later from the screens that ask about the crash. Between those two
  // points the row is legitimately absent, so this reads it as optional: the
  // old .single() turned "not asked yet" into a 500 and took the patient's own
  // case summary down with it.
  const { data: accident, error: accidentError } = await supabase
    .from("accidents")
    .select(
      [
        "incident_type",
        "incident_location",
        "incident_date",
        "role",
        "injuries",
        ...locationColumnNames("incident"),
      ].join(", ")
    )
    .eq("submission_id", submissionId)
    .maybeSingle();

  if (accidentError) {
    console.error("accidents select failed:", { code: accidentError.code });
    return { error: "Failed to load case details" };
  }

  const { data: claimant, error: claimantError } = await supabase
    .from("claimants")
    .select("mobile")
    .eq("id", owned.claimantId)
    .single();

  if (claimantError || !claimant) {
    console.error("claimants select failed:", { code: claimantError?.code });
    return { error: "Failed to load case details" };
  }

  const { data: companions, error: companionsError } = await supabase
    .from("submission_companions")
    .select("id, first_name, last_name, relation, cell_number, email")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });

  if (companionsError) {
    console.error("submission_companions select failed:", { code: companionsError.code });
    return { error: "Failed to load case details" };
  }

  const { data: documents, error: documentsError } = await supabase
    .from("documents")
    .select("id, file_name, mime_type, category")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });

  if (documentsError) {
    console.error("documents select failed:", { code: documentsError.code });
    return { error: "Failed to load case details" };
  }

  // The selects are built from column lists, so the client cannot type the rows.
  const submissionRow = submission as unknown as Record<string, unknown>;
  const accidentRow = (accident ?? null) as Record<string, unknown> | null;
  const status = String(submissionRow.status);
  const incidentLocation = (accidentRow?.incident_location as string | null) ?? "";
  const treatmentArea = (submissionRow.treatment_area as string | null) ?? null;

  return {
    summary: {
      submissionId,
      status,
      submittedAt: (submissionRow.submitted_at as string | null) ?? null,
      // Already resolved from the caller's own claimant, so it is not read again.
      firstName: owned.firstName,
      lastName: owned.lastName ?? "",
      phone: claimant.mobile ?? "",
      email: owned.email ?? null,
      // Empty rather than null while the accident screens are unanswered: the
      // callers' contract has always had these as strings.
      incidentType: (accidentRow?.incident_type as string | null) ?? "",
      incidentDate: (accidentRow?.incident_date as string | null) ?? null,
      incidentLocation,
      incidentLocationDetails: accidentRow ? locationDetailsFromRow(accidentRow, "incident", incidentLocation) : null,
      role: (accidentRow?.role as string | null) ?? null,
      injuries: (accidentRow?.injuries as string | null) ?? null,
      treatmentArea,
      treatmentAreaLocationDetails: locationDetailsFromRow(submissionRow, "treatment_area", treatmentArea),
      companions: (companions ?? []).map((person) => ({
        id: person.id,
        firstName: person.first_name ?? "",
        lastName: person.last_name ?? "",
        relation: person.relation ?? "",
        cellNumber: person.cell_number ?? "",
        email: person.email ?? null,
      })),
      documents: (documents ?? []).map((doc) => ({
        id: doc.id,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        category: doc.category ?? null,
      })),
      editable: canEditCaseSummary(status),
    },
  };
}

type ChangeResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Makes the case's companions the list Save sent. Kept ids are updated, entries
 * without one are added, and stored ids the list leaves out are removed — in
 * that order, each write scoped to this submission, so a failure part-way never
 * loses a companion the patient kept. An id that is not one of this case's is
 * refused before anything is written.
 */
async function replaceCompanions(submissionId: string, companions: CaseCompanionInput[]): Promise<ChangeResult> {
  const { data: stored, error: storedError } = await supabase
    .from("submission_companions")
    .select("id")
    .eq("submission_id", submissionId);

  if (storedError) {
    console.error("submission_companions select failed:", { code: storedError.code });
    return { ok: false, status: 500, error: "Failed to save companions" };
  }

  const storedIds = new Set((stored ?? []).map((row) => row.id as string));
  if (companions.some((person) => person.id && !storedIds.has(person.id))) {
    return { ok: false, status: 400, error: "invalid_companions" };
  }

  const columns = (person: CaseCompanionInput) => ({
    first_name: person.firstName,
    last_name: person.lastName,
    relation: person.relation,
    cell_number: person.cellNumber,
    email: person.email,
  });

  const added = companions.filter((person) => !person.id);
  if (added.length > 0) {
    const { error: insertError } = await supabase
      .from("submission_companions")
      .insert(added.map((person) => ({ submission_id: submissionId, ...columns(person) })));

    if (insertError) {
      console.error("submission_companions insert failed:", { code: insertError.code });
      return { ok: false, status: 500, error: "Failed to save companions" };
    }
  }

  for (const person of companions.filter((entry) => entry.id)) {
    const { error: updateError } = await supabase
      .from("submission_companions")
      .update(columns(person))
      .eq("id", person.id as string)
      .eq("submission_id", submissionId);

    if (updateError) {
      console.error("submission_companions update failed:", { code: updateError.code });
      return { ok: false, status: 500, error: "Failed to save companions" };
    }
  }

  const kept = new Set(companions.map((person) => person.id).filter(Boolean));
  const removed = [...storedIds].filter((id) => !kept.has(id));
  if (removed.length > 0) {
    const { error: deleteError } = await supabase
      .from("submission_companions")
      .delete()
      .eq("submission_id", submissionId)
      .in("id", removed);

    if (deleteError) {
      console.error("submission_companions delete failed:", { code: deleteError.code });
      return { ok: false, status: 500, error: "Failed to save companions" };
    }
  }

  return { ok: true };
}

/**
 * Records files the patient uploaded from Case Summary and removes the ones
 * they took out. A new file must already be in Storage, in this case's own
 * folder, under a key the upload-url route minted — the key is checked, never
 * trusted. A removal deletes the documents row first, so the case stops
 * listing the file even if Storage then fails to delete the object.
 */
async function changeDocuments(
  submissionId: string,
  documents: { add: CaseDocumentInput[]; remove: string[] }
): Promise<ChangeResult> {
  if (documents.remove.length > 0) {
    const { data: rows, error: lookupError } = await supabase
      .from("documents")
      .select("id, storage_path")
      .eq("submission_id", submissionId)
      .in("id", documents.remove);

    if (lookupError) {
      console.error("documents select failed:", { code: lookupError.code });
      return { ok: false, status: 500, error: "Failed to save documents" };
    }
    if ((rows ?? []).length !== documents.remove.length) {
      return { ok: false, status: 400, error: "invalid_documents" };
    }

    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("submission_id", submissionId)
      .in("id", documents.remove);

    if (deleteError) {
      console.error("documents delete failed:", { code: deleteError.code });
      return { ok: false, status: 500, error: "Failed to save documents" };
    }

    const objectPaths = (rows ?? [])
      .map((row) => normalizeStoragePath(String(row.storage_path ?? "")))
      .filter((objectPath) => belongsToCase(objectPath, submissionId));
    if (objectPaths.length > 0) {
      const { error: removeError } = await supabase.storage.from(DOCUMENTS_BUCKET).remove(objectPaths);
      // the case no longer lists the file; an object left behind is only storage
      if (removeError) console.error("documents storage remove failed:", { name: removeError.name });
    }
  }

  if (documents.add.length > 0) {
    const added = documents.add.map((doc) => ({ ...doc, objectPath: normalizeStoragePath(doc.storagePath) }));
    if (added.some((doc) => !belongsToCase(doc.objectPath, submissionId) || doc.objectPath.split("/").length !== 3)) {
      return { ok: false, status: 400, error: "invalid_documents" };
    }

    const { data: existing, error: existingError } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("submission_id", submissionId);

    if (existingError) {
      console.error("documents select failed:", { code: existingError.code });
      return { ok: false, status: 500, error: "Failed to save documents" };
    }
    const recorded = new Set((existing ?? []).map((row) => normalizeStoragePath(String(row.storage_path ?? ""))));
    if (added.some((doc) => recorded.has(doc.objectPath))) {
      return { ok: false, status: 400, error: "invalid_documents" };
    }

    // Every new file has to be in Storage already: a row for a key nothing was
    // uploaded to would list a document that cannot be opened.
    for (const doc of added) {
      const slash = doc.objectPath.lastIndexOf("/");
      const folder = doc.objectPath.slice(0, slash);
      const name = doc.objectPath.slice(slash + 1);
      const { data: found, error: listError } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .list(folder, { search: name, limit: 100 });

      if (listError) {
        console.error("documents storage list failed:", { name: listError.name });
        return { ok: false, status: 500, error: "Failed to save documents" };
      }
      if (!(found ?? []).some((object) => object.name === name)) {
        return { ok: false, status: 400, error: "invalid_documents" };
      }
    }

    const { error: insertError } = await supabase.from("documents").insert(
      added.map((doc) => ({
        submission_id: submissionId,
        storage_path: doc.objectPath,
        file_name: doc.fileName,
        mime_type: doc.mimeType,
        file_size: doc.fileSize,
        category: doc.category,
      }))
    );

    if (insertError) {
      console.error("documents insert failed:", { code: insertError.code });
      return { ok: false, status: 500, error: "Failed to save documents" };
    }
  }

  return { ok: true };
}

// The patient's own case summary. It carries their name, contact details and
// where and how they were hurt, so it is patient-owned rather than a public
// status page: a submission id in the URL identifies a case and authorizes
// nothing.
caseRouter.get("/:submissionId", requireAuth, async (req: Request, res: Response) => {
  const submissionId = typeof req.params.submissionId === "string" ? req.params.submissionId : "";

  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to load case details" });
    return;
  }
  // A case belonging to someone else answers exactly like one that does not
  // exist, so the response cannot be used to discover another patient's case.
  if (owned.error) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const loaded = await loadCaseSummary(owned.submission);
  if ("error" in loaded) {
    res.status(500).json({ error: loaded.error });
    return;
  }

  res.json(loaded.summary);
});

// Case Summary's Save. The patient corrects their name, the accident, their
// injuries, where they want treatment, who was with them and the documents on
// the case, at any stage of a submitted case —
// see canEditCaseSummary. Email and phone are refused outright by
// parseCaseSummaryUpdate, whatever the screen sends.
//
// Ownership is decided first, so another patient's case answers 404 exactly
// like a missing one, before the body or the status is looked at.
caseRouter.post("/:submissionId", requireAuth, async (req: Request, res: Response) => {
  const submissionId = typeof req.params.submissionId === "string" ? req.params.submissionId : "";

  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to save case details" });
    return;
  }
  if (owned.error) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const parsed = parseCaseSummaryUpdate(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { claimant, accident, injuries, treatmentArea, treatmentAreaLocationDetails, companions, documents } =
    parsed.update;

  if (!canEditCaseSummary(owned.submission.status)) {
    res.status(409).json({ error: "case_locked" });
    return;
  }

  // Only the treatment area lives on the submission. Its update is limited to
  // a submitted case, so a case that is somehow back in intake is not written
  // here; the status itself is never written by this route.
  if (treatmentArea !== undefined) {
    const { data: updated, error: submissionError } = await supabase
      .from("intake_submissions")
      .update({
        treatment_area: treatmentArea,
        ...(treatmentAreaLocationDetails !== undefined &&
          locationColumns(treatmentAreaLocationDetails, "treatment_area")),
      })
      .eq("id", owned.submission.submissionId)
      .in("status", [...SUBMITTED_CASE_STATUSES])
      .select("id");

    if (submissionError) {
      console.error("intake_submissions update failed:", { code: submissionError.code });
      res.status(500).json({ error: "Failed to save case details" });
      return;
    }

    if (!updated || updated.length === 0) {
      res.status(409).json({ error: "case_locked" });
      return;
    }
  }

  if (accident || injuries !== undefined) {
    const { error: accidentError } = await supabase
      .from("accidents")
      .update({
        ...(accident && {
          incident_type: accident.incidentType,
          incident_date: accident.incidentDate,
          incident_location: accident.incidentLocation,
          role: accident.role,
          ...(accident.incidentLocationDetails !== undefined &&
            locationColumns(accident.incidentLocationDetails, "incident")),
        }),
        ...(injuries !== undefined && { injuries }),
      })
      .eq("submission_id", owned.submission.submissionId);

    if (accidentError) {
      console.error("accidents update failed:", { code: accidentError.code });
      res.status(500).json({ error: "Failed to save accident details" });
      return;
    }
  }

  if (companions) {
    const changed = await replaceCompanions(owned.submission.submissionId, companions);
    if (!changed.ok) {
      res.status(changed.status).json({ error: changed.error });
      return;
    }
  }

  if (documents) {
    const changed = await changeDocuments(owned.submission.submissionId, documents);
    if (!changed.ok) {
      res.status(changed.status).json({ error: changed.error });
      return;
    }
  }

  if (claimant) {
    const { error: claimantError } = await supabase
      .from("claimants")
      .update({ first_name: claimant.firstName, last_name: claimant.lastName })
      .eq("id", owned.submission.claimantId);

    if (claimantError) {
      console.error("claimants update failed:", { code: claimantError.code });
      res.status(500).json({ error: "Failed to save your name" });
      return;
    }
  }

  const loaded = await loadCaseSummary({
    ...owned.submission,
    ...(claimant && { firstName: claimant.firstName, lastName: claimant.lastName }),
  });
  if ("error" in loaded) {
    res.status(500).json({ error: loaded.error });
    return;
  }

  res.json(loaded.summary);
});

const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One file of the patient's own case, for Case Summary's thumbnails. The bucket
// has no read policy, so the patient's session cannot read its own uploads; this
// reads with the service role after the same ownership check as the summary,
// and only an object inside the case's own folder. Served the way the lawyer's
// review-document is: a type this code chose, inline only for images and PDFs.
caseRouter.get("/:submissionId/documents/:documentId", requireAuth, async (req: Request, res: Response) => {
  const submissionId = typeof req.params.submissionId === "string" ? req.params.submissionId : "";
  const documentId = typeof req.params.documentId === "string" ? req.params.documentId : "";

  const owned = await resolveOwnedSubmission(req, submissionId);
  if (owned.error === "identity_lookup_failed") {
    res.status(500).json({ error: "Failed to load document" });
    return;
  }
  if (owned.error || !DOCUMENT_ID_PATTERN.test(documentId)) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, file_name, storage_path")
    .eq("id", documentId)
    .eq("submission_id", owned.submission.submissionId)
    .maybeSingle();

  if (documentError) {
    console.error("documents select failed:", { code: documentError.code });
    res.status(500).json({ error: "Failed to load document" });
    return;
  }

  const objectPath = normalizeStoragePath(String(document?.storage_path ?? ""));
  if (!document || !objectPath || !belongsToCase(objectPath, owned.submission.submissionId)) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const { data: file, error: downloadError } = await supabase.storage.from(DOCUMENTS_BUCKET).download(objectPath);
  if (downloadError || !file) {
    console.error("documents storage download failed:", { name: downloadError?.name });
    res.status(404).json({ error: "Document not found" });
    return;
  }

  // The type Storage holds the object as, not the one the upload claimed.
  const storedType = file.type || null;
  const kind = documentKindFor(storedType);
  const fileName =
    String(document.file_name ?? "")
      .split(/[\\/]/)
      .pop()
      ?.trim()
      .slice(0, 180) || "document";
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
