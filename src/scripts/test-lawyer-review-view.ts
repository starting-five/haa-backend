import { strict as assert } from "assert";
import {
  belongsToCase,
  buildLawyerReviewCase,
  contentDisposition,
  documentKindFor,
  hideContactDetails,
  HIDDEN_TEXT,
  isUuid,
  resolveReviewAccess,
  signedRetainerPath,
  reviewFileName,
  servedContentType,
  type ReviewAccess,
  type ReviewAssignmentRow,
  type ReviewCaseRows,
} from "../lib/lawyer-review";

// Proves what a lawyer's review link is shown in each assignment state, with
// no database: the state is decided from an assignment row, and the response
// is built from rows that deliberately carry every protected value, so the
// masking is shown to hold even when a query loads more than it should.
//
// Before acceptance the case is there to be judged — what happened, when and
// where, and the files, which can be opened while the link is open — and who
// the patient is and how to reach them is not.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const FUTURE = "2026-10-13T12:00:00.000Z";
const PAST = "2026-09-29T11:59:59.000Z";
const SUB_ID = "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55";

const assignment = (overrides: Partial<ReviewAssignmentRow>): ReviewAssignmentRow => ({
  id: "3f1c2b8e-8f5d-4c0a-9d3e-0b6a1e2f4c11",
  submission_id: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55",
  status: "pending",
  expires_at: FUTURE,
  decision_expires_at: FUTURE,
  revoked_at: null,
  accepted_at: null,
  ...overrides,
});

// Every value the lawyer must not see before accepting: who the patient is, how
// to reach them or the people who were with them, and the files' own names and
// storage paths, which are built from what the patient called the file. It
// includes columns the route never selects (GPS, place ids) — the builder has to
// ignore them too.
const PROTECTED = {
  firstName: "Marisol",
  lastName: "Quintanilla",
  mobile: "+15125550147",
  email: "marisol.q@example.com",
  residence: "4417 Avenue F, Austin, TX 78751",
  treatmentArea: "Round Rock, TX 78664",
  incidentLat: 30.3072,
  incidentLng: -97.7431,
  placeId: "ChIJ-protected-place-id",
  companionFirst: "Teodoro",
  companionLast: "Balderrama",
  companionCell: "+15125550198",
  companionEmail: "teo.b@example.com",
  fileName: "marisol-drivers-license.jpg",
  storagePath: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/driversLicense/marisol-drivers-license.jpg",
  heicName: "IMG_2231.HEIC",
  insuranceFile: "marisol-insurance-card.pdf",
  storageUrl: "/storage/v1/",
  // The signed retainer: its agreement id and where it is kept locate it, so
  // neither may reach a link, not even an accepted one.
  agreementId: "c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
  retainerPath: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f.pdf",
};
const RETAINER_PATH_FOR = (id: string) => `${SUB_ID}/${id}.pdf`;

// The case itself, which a pending lawyer is shown so they can judge it.
const CASE = {
  incidentDate: "2026-09-14",
  incidentLocation: "Lamar Blvd & W 38th St, Austin, TX",
};

const STORY =
  "A pickup ran the red light and hit my driver side. Call me at (512) 555-0147 or write to marisol.q@example.com.";

const fullRows = (): ReviewCaseRows => ({
  submission: {
    id: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55",
    locale: "es",
    treatment_area: PROTECTED.treatmentArea,
    treatment_area_lat: 30.5083,
    submitted_at: "2026-09-14T22:10:00Z",
  },
  accident: {
    incident_type: "car",
    role: "driver",
    description: STORY,
    injuries: "headNeck,back",
    incident_date: CASE.incidentDate,
    incident_location: CASE.incidentLocation,
    incident_lat: PROTECTED.incidentLat,
    incident_lng: PROTECTED.incidentLng,
    incident_place_id: PROTECTED.placeId,
  },
  claimant: {
    first_name: PROTECTED.firstName,
    last_name: PROTECTED.lastName,
    mobile: PROTECTED.mobile,
    email: PROTECTED.email,
    residence: PROTECTED.residence,
  },
  companions: [
    {
      first_name: PROTECTED.companionFirst,
      last_name: PROTECTED.companionLast,
      relation: "passenger",
      cell_number: PROTECTED.companionCell,
      email: PROTECTED.companionEmail,
    },
  ],
  documents: [
    {
      id: "0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f",
      category: "driversLicense",
      file_name: PROTECTED.fileName,
      mime_type: "image/jpeg",
      file_size: 204800,
      storage_path: PROTECTED.storagePath,
    },
    {
      id: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
      category: "incidentPhotos",
      file_name: PROTECTED.heicName,
      mime_type: null,
      file_size: 1048576,
      storage_path: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/incidentPhotos/IMG_2231.HEIC",
    },
    {
      id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
      category: "incidentPhotos",
      file_name: "scene-2.png",
      mime_type: "image/png",
      file_size: 99000,
      storage_path: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/incidentPhotos/scene-2.png",
    },
    {
      id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
      category: "insuranceCard",
      file_name: PROTECTED.insuranceFile,
      mime_type: "application/pdf",
      file_size: 51200,
      storage_path: "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/insuranceCard/marisol-insurance-card.pdf",
    },
  ],
  // What the route finds in Storage for this case: the license (image), the
  // HEIC (served only as a download) and the PDF. scene-2.png is missing, as
  // when Storage does not hold the object.
  storedFiles: new Map([
    [PROTECTED.storagePath, { kind: "image", mimeType: "image/jpeg" }],
    ["9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/incidentPhotos/IMG_2231.HEIC", { kind: "file", mimeType: "image/heic" }],
    [
      "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55/insuranceCard/marisol-insurance-card.pdf",
      { kind: "pdf", mimeType: "application/pdf" },
    ],
  ]),
  agreement: { id: PROTECTED.agreementId, status: "completed", signed_document_path: PROTECTED.retainerPath },
  retainerStored: true,
});

const leakedValues = (serialized: string) =>
  Object.entries(PROTECTED).filter(([, value]) => serialized.includes(String(value)));

// ── state, from the assignment row alone ─────────────────────────────────────
const pending = resolveReviewAccess(assignment({}), NOW);
record(
  "a pending link can decide and open the files, and unlocks nothing",
  pending.state === "pending" && pending.canDecide && pending.documents && !pending.unlocked
);

const pendingLate = resolveReviewAccess(assignment({ decision_expires_at: PAST }), NOW);
record(
  "a pending link past its decision deadline stays open, but cannot decide",
  pendingLate.state === "pending" && !pendingLate.canDecide && pendingLate.documents && !pendingLate.unlocked
);

const accepted = resolveReviewAccess(assignment({ status: "accepted", accepted_at: "2026-09-29T11:00:00Z" }), NOW);
record(
  "an accepted link with its acceptance recorded unlocks the case and keeps the files",
  accepted.state === "accepted" && accepted.unlocked && accepted.documents && !accepted.canDecide
);

const acceptedUnrecorded = resolveReviewAccess(assignment({ status: "accepted", accepted_at: null }), NOW);
record(
  "an accepted status without an acceptance time unlocks nothing and opens no file",
  !acceptedUnrecorded.unlocked && !acceptedUnrecorded.documents
);

const acceptedExpired = resolveReviewAccess(
  assignment({ status: "accepted", accepted_at: "2026-09-20T11:00:00Z", expires_at: PAST }),
  NOW
);
record(
  "an expired link unlocks nothing and opens no file, even after an acceptance",
  acceptedExpired.state === "expired" && !acceptedExpired.unlocked && !acceptedExpired.documents
);

const rejected = resolveReviewAccess(assignment({ status: "rejected" }), NOW);
record(
  "a rejected link unlocks nothing, opens no file and cannot decide",
  rejected.state === "rejected" && !rejected.unlocked && !rejected.documents && !rejected.canDecide
);

const revokedAccepted = resolveReviewAccess(
  assignment({ status: "accepted", accepted_at: "2026-09-29T11:00:00Z", revoked_at: "2026-09-29T11:30:00Z" }),
  NOW
);
record(
  "a revoked link is refused, whatever it had decided",
  revokedAccepted.state === "revoked" && !revokedAccepted.unlocked && !revokedAccepted.documents
);
const revokedPending = resolveReviewAccess(assignment({ revoked_at: "2026-09-29T11:30:00Z" }), NOW);
record("a revoked pending link opens no file", revokedPending.state === "revoked" && !revokedPending.documents);
record("a revoked status is refused", resolveReviewAccess(assignment({ status: "revoked" }), NOW).state === "revoked");
record("an expired status is expired", resolveReviewAccess(assignment({ status: "expired" }), NOW).state === "expired");

const unknown = resolveReviewAccess(assignment({ status: "approved", accepted_at: "2026-09-29T11:00:00Z" }), NOW);
record(
  "a status the code does not know is refused, not unlocked, and opens no file",
  unknown.state === "revoked" && !unknown.unlocked && !unknown.documents
);

record(
  "an unparseable deadline counts as passed",
  resolveReviewAccess(assignment({ expires_at: "soon" }), NOW).state === "expired"
);
const badDecisionDeadline = resolveReviewAccess(assignment({ decision_expires_at: "soon" }), NOW);
record(
  "an unparseable decision deadline only closes decisions",
  badDecisionDeadline.state === "pending" && !badDecisionDeadline.canDecide && badDecisionDeadline.documents
);
record(
  "no deadline at all never passes",
  resolveReviewAccess(assignment({ expires_at: null }), NOW).state === "pending"
);
record(
  "the deadline instant itself is already late",
  resolveReviewAccess(assignment({ expires_at: new Date(NOW).toISOString() }), NOW).state === "expired"
);

// ── every state before acceptance, from rows holding everything ─────────────
const lockedStates: [string, ReviewAccess][] = [
  ["pending", pending],
  ["decision window closed", pendingLate],
  ["rejected", rejected],
  ["accepted without an acceptance time", acceptedUnrecorded],
  ["accepted but expired", acceptedExpired],
];

for (const [label, access] of lockedStates) {
  const view = buildLawyerReviewCase(access, fullRows(), FUTURE);
  const serialized = JSON.stringify(view);
  const leaks = leakedValues(serialized);
  record(
    `${label}: no protected value is in the response (${leaks.map(([key]) => key).join(", ") || "none"})`,
    leaks.length === 0
  );
  record(
    `${label}: masked — patient and companions are null`,
    view.access === "masked" && view.patient === null && view.companions === null
  );
  record(
    `${label}: the accident's date and place are shown`,
    // Read without assuming the block is there, so a missing one fails here rather than crashing.
    (view.incident as { date?: unknown } | null)?.date === CASE.incidentDate &&
      (view.incident as { location?: unknown } | null)?.location === CASE.incidentLocation
  );
  record(
    `${label}: the signed retainer is known to exist and cannot be opened`,
    view.signedRetainer.signed === true && view.signedRetainer.available === false
  );
  record(
    `${label}: files are ${access.documents ? "listed" : "not listed"}`,
    access.documents ? Array.isArray(view.documents) && view.documents.length === 4 : view.documents === null
  );
}

// ── the signed retainer ──────────────────────────────────────────────────────
const acceptedView = buildLawyerReviewCase(accepted, fullRows(), FUTURE);
record(
  "accepted: the signed retainer can be opened",
  acceptedView.signedRetainer.signed === true && acceptedView.signedRetainer.available === true
);
record(
  "accepted: still no agreement id or retainer path in the response",
  !JSON.stringify(acceptedView).includes(PROTECTED.agreementId) &&
    !JSON.stringify(acceptedView).includes(PROTECTED.retainerPath)
);
record(
  "accepted, retainer not in Storage: signed but not offered",
  (() => {
    const view = buildLawyerReviewCase(accepted, { ...fullRows(), retainerStored: false }, FUTURE);
    return view.signedRetainer.signed === true && view.signedRetainer.available === false;
  })()
);
record(
  "no agreement: nothing is signed",
  (() => {
    const view = buildLawyerReviewCase(accepted, { ...fullRows(), agreement: null, retainerStored: false }, FUTURE);
    return view.signedRetainer.signed === false && view.signedRetainer.available === false;
  })()
);
record(
  "an agreement still out for signing is not signed",
  (() => {
    const view = buildLawyerReviewCase(accepted, { ...fullRows(), agreement: { status: "sent" } }, FUTURE);
    return view.signedRetainer.signed === false && view.signedRetainer.available === false;
  })()
);
record(
  "the retainer path is served only when it is this case's own derived path",
  signedRetainerPath(fullRows().agreement, RETAINER_PATH_FOR) === PROTECTED.retainerPath &&
    signedRetainerPath(
      {
        ...fullRows().agreement,
        signed_document_path: `0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f/${PROTECTED.agreementId}.pdf`,
      },
      RETAINER_PATH_FOR
    ) === null &&
    signedRetainerPath(
      { ...fullRows().agreement, signed_document_path: `${SUB_ID}/../other/${PROTECTED.agreementId}.pdf` },
      RETAINER_PATH_FOR
    ) === null &&
    signedRetainerPath({ ...fullRows().agreement, status: "sent" }, RETAINER_PATH_FOR) === null &&
    signedRetainerPath({ ...fullRows().agreement, signed_document_path: null }, RETAINER_PATH_FOR) === null &&
    signedRetainerPath(null, RETAINER_PATH_FOR) === null
);

const masked = buildLawyerReviewCase(pending, fullRows(), FUTURE);
record(
  "the masked case keeps the case facts",
  masked.caseFacts.incidentType === "car" &&
    masked.caseFacts.role === "driver" &&
    masked.caseFacts.injuries === "headNeck,back" &&
    masked.caseFacts.language === "es"
);
record(
  "the masked story keeps the account and hides the phone and email",
  masked.caseFacts.story ===
    `A pickup ran the red light and hit my driver side. Call me at ${HIDDEN_TEXT} or write to ${HIDDEN_TEXT}.`
);
record(
  "the masked case lists who was there by relation only",
  JSON.stringify(masked.caseFacts.companionRelations) === '["passenger"]'
);
record(
  "the masked case counts documents by category",
  JSON.stringify(masked.caseFacts.documentCounts) ===
    JSON.stringify([
      { category: "driversLicense", count: 1 },
      { category: "incidentPhotos", count: 2 },
      { category: "insuranceCard", count: 1 },
    ])
);
record(
  "the masked case carries the server's deadline and state",
  masked.review.responseDeadline === FUTURE && masked.review.status === "pending" && masked.review.canDecide
);

// The files of a pending case: every one listed by id and kind, none by its own
// name, and the one Storage does not hold marked as not openable.
const pendingDocuments = masked.documents ?? [];
record(
  "pending: every file is listed by id, category, kind and size",
  JSON.stringify(pendingDocuments.map((document) => [document.id, document.category, document.kind])) ===
    JSON.stringify([
      ["0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f", "driversLicense", "image"],
      ["7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918", "incidentPhotos", "file"],
      ["5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", "incidentPhotos", "file"],
      ["2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", "insuranceCard", "pdf"],
    ]) && pendingDocuments[0]?.fileSize === 204800
);
record(
  "pending: no file carries its own name",
  pendingDocuments.every((document) => document.fileName === null)
);
record(
  "pending: files Storage holds in the case's folder can be opened, a missing one cannot",
  JSON.stringify(pendingDocuments.map((document) => document.available)) === "[true,true,false,true]"
);
record(
  "pending: the type shown is the one Storage serves",
  pendingDocuments[1]?.mimeType === "image/heic" && pendingDocuments[3]?.mimeType === "application/pdf"
);
record(
  "pending: a file entry has exactly the documented keys — no URL, no path",
  pendingDocuments.every(
    (document) =>
      JSON.stringify(Object.keys(document)) ===
      JSON.stringify(["id", "category", "fileName", "mimeType", "fileSize", "kind", "available"])
  )
);

// A field added to the response has to be added here too, on purpose.
record(
  "the response has exactly the documented keys",
  JSON.stringify(Object.keys(masked)) ===
    JSON.stringify([
      "ok",
      "access",
      "review",
      "caseFacts",
      "patient",
      "signedRetainer",
      "incident",
      "companions",
      "documents",
    ]) &&
    // Whether it is signed and whether it can be opened: no id, URL or path.
    JSON.stringify(Object.keys(masked.signedRetainer)) === JSON.stringify(["signed", "available"]) &&
    JSON.stringify(Object.keys(masked.caseFacts)) ===
      JSON.stringify([
        "incidentType",
        "role",
        "injuries",
        "story",
        "language",
        "companionRelations",
        "documentCounts",
      ]) &&
    JSON.stringify(Object.keys(masked.incident ?? {})) === JSON.stringify(["date", "location"])
);

// ── the accepted case ────────────────────────────────────────────────────────
const full = buildLawyerReviewCase(accepted, fullRows(), FUTURE);
record(
  "after acceptance the patient's name, phone, email and address are returned",
  full.access === "full" &&
    full.patient?.firstName === PROTECTED.firstName &&
    full.patient?.lastName === PROTECTED.lastName &&
    full.patient?.mobile === PROTECTED.mobile &&
    full.patient?.email === PROTECTED.email &&
    full.patient?.residence === PROTECTED.residence &&
    full.patient?.treatmentArea === PROTECTED.treatmentArea
);
record(
  "after acceptance the accident's date and place are still returned",
  full.incident.date === CASE.incidentDate && full.incident.location === CASE.incidentLocation
);
record("after acceptance the story is returned as written", full.caseFacts.story === STORY);
record(
  "after acceptance the people with the patient are returned in full",
  full.companions?.[0]?.firstName === PROTECTED.companionFirst &&
    full.companions?.[0]?.cellNumber === PROTECTED.companionCell
);
record(
  "after acceptance every file carries its own name, kind and availability — and still no URL",
  full.documents?.length === 4 &&
    full.documents?.[0]?.fileName === PROTECTED.fileName &&
    full.documents?.[0]?.kind === "image" &&
    full.documents?.[1]?.fileName === PROTECTED.heicName &&
    full.documents?.[1]?.kind === "file" &&
    full.documents?.[3]?.kind === "pdf" &&
    full.documents?.[2]?.available === false &&
    full.documents.every((document) => !("url" in document))
);
const fullSerialized = JSON.stringify(full);
record(
  "even after acceptance, storage paths, Storage URLs and GPS are never returned",
  !fullSerialized.includes(PROTECTED.storagePath) &&
    !fullSerialized.includes(PROTECTED.storageUrl) &&
    !fullSerialized.includes(String(PROTECTED.incidentLat)) &&
    !fullSerialized.includes(PROTECTED.placeId)
);

let revokedThrows = false;
try {
  buildLawyerReviewCase({ state: "revoked", canDecide: false, unlocked: false, documents: false }, fullRows(), FUTURE);
} catch {
  revokedThrows = true;
}
record("a revoked link has no case to build", revokedThrows);

// ── how a file is served ─────────────────────────────────────────────────────
record(
  "an image is served as its own browser-drawable type, a PDF as a PDF",
  servedContentType("image", "image/webp") === "image/webp" &&
    servedContentType("image", "IMAGE/PNG; charset=binary") === "image/png" &&
    servedContentType("pdf", "application/pdf") === "application/pdf"
);
record(
  "everything else is an opaque download, whatever type Storage holds",
  ["text/html", "image/svg+xml", "image/heic", "application/javascript", null].every(
    (type) => servedContentType("file", type) === "application/octet-stream"
  ) && servedContentType("image", "image/svg+xml") === "application/octet-stream"
);

const neutral = (category: string, kind: "image" | "pdf" | "file", type: string | null, objectPath: string) =>
  reviewFileName(
    { id: "0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f", category, fileName: PROTECTED.fileName, objectPath },
    kind,
    type,
    false
  );
record(
  "before acceptance a file is offered under a neutral name, never the patient's",
  neutral("driversLicense", "image", "image/jpeg", PROTECTED.storagePath) === "drivers-license-0d9f6a2e.jpg" &&
    neutral("insuranceCard", "pdf", "application/pdf", `${SUB_ID}/insuranceCard/x.pdf`) ===
      "insurance-card-0d9f6a2e.pdf" &&
    neutral("incidentPhotos", "image", "image/webp", `${SUB_ID}/incidentPhotos/marisol.jpg`) ===
      "incident-photo-0d9f6a2e.webp"
);
record(
  "a neutral download keeps the stored object's extension, or none at all",
  neutral("incidentPhotos", "file", "image/heic", `${SUB_ID}/incidentPhotos/IMG_2231-1a2b3c4d.HEIC`) ===
    "incident-photo-0d9f6a2e.heic" &&
    neutral("accidentReport", "file", "text/html", `${SUB_ID}/accidentReport/statement`) ===
      "accident-report-0d9f6a2e.bin" &&
    neutral("somethingNew", "file", null, `${SUB_ID}/uncategorized/a.docx`) === "document-0d9f6a2e.docx"
);
record(
  "after acceptance the file keeps the patient's own name, without any folder",
  reviewFileName(
    {
      id: "0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f",
      category: "driversLicense",
      fileName: "..\\..\\x/Marisol license.jpg",
      objectPath: PROTECTED.storagePath,
    },
    "image",
    "image/jpeg",
    true
  ) === "Marisol license.jpg"
);
record(
  "images and PDFs open inline, everything else downloads",
  contentDisposition("image", "a.jpg").startsWith("inline;") &&
    contentDisposition("pdf", "a.pdf").startsWith("inline;") &&
    contentDisposition("file", "a.heic").startsWith("attachment;")
);
const hostile = contentDisposition("file", 'x"; filename=evil.html\r\nSet-Cookie: a=b; Marísol.pdf');
record(
  "no character in a name can end the header or add another",
  !/[\r\n]/.test(hostile) &&
    (hostile.match(/"/g) ?? []).length === 2 &&
    hostile.includes("filename*=UTF-8''x%22%3B%20filename%3Devil.html%0D%0ASet-Cookie%3A%20a%3Db%3B%20Mar%C3%ADsol.pdf")
);

// ── free text ────────────────────────────────────────────────────────────────
const hidden = (text: string) => hideContactDetails(text);
record(
  "phone numbers are hidden in every usual format",
  [
    "5125550147",
    "512-555-0147",
    "512.555.0147",
    "(512) 555-0147",
    "+1 512 555 0147",
    "1-512-555-0147",
    "555-0147",
  ].every((phone) => hidden(`call ${phone} today`) === `call ${HIDDEN_TEXT} today`)
);
record("email addresses are hidden", hidden("mail Jo.Doe+case@mail.example.org now") === `mail ${HIDDEN_TEXT} now`);
record("a numeric date is hidden", hidden("on 09/14/2026 at noon") === `on ${HIDDEN_TEXT} at noon`);
record(
  "ordinary numbers in the story are kept",
  hidden("I-35 at 45 mph, 2 cars, $25,000 in damage, 3 stitches") ===
    "I-35 at 45 mph, 2 cars, $25,000 in damage, 3 stitches"
);

// ── document kinds, from what Storage will serve ─────────────────────────────
record(
  "browser-drawable images are shown inline",
  ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "IMAGE/PNG"].every(
    (type) => documentKindFor(type) === "image"
  )
);
record(
  "PDFs open in the browser's viewer",
  documentKindFor("application/pdf") === "pdf" && documentKindFor("application/pdf; charset=binary") === "pdf"
);
record(
  "everything else is download-only: HEIC, SVG, HTML, unknown or missing",
  ["image/heic", "image/heif", "image/svg+xml", "text/html", "application/octet-stream", "", null, undefined].every(
    (type) => documentKindFor(type) === "file"
  )
);

// ── a document must live in its own case's folder ───────────────────────────
const SUB = "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55";
record("a file in the case's own folder belongs to it", belongsToCase(`${SUB}/insuranceCard/card.pdf`, SUB));
record(
  "another case's file, a look-alike folder, a parent-directory path or an un-normalised key do not",
  !belongsToCase("0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f/insuranceCard/card.pdf", SUB) &&
    !belongsToCase(`${SUB}x/insuranceCard/card.pdf`, SUB) &&
    !belongsToCase(`${SUB}/../0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f/card.pdf`, SUB) &&
    !belongsToCase(`${SUB}/./card.pdf`, SUB) &&
    !belongsToCase(`submissions/${SUB}/insuranceCard/card.pdf`, SUB)
);

// ── ids ──────────────────────────────────────────────────────────────────────
record("a UUID is accepted", isUuid("9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55"));
record(
  "anything else is not",
  !isUuid("9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55' or 1=1") && !isUuid("") && !isUuid("not-a-uuid")
);

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
assert(failed.length === 0, `${failed.length} lawyer review check(s) failed`);
