// What a lawyer's review link may see of a case.
//
// A case is passed to a lawyer before they have agreed to take it. Until they
// accept, the page has to be enough to judge the case and not enough to reach
// the patient without HelpAfterAccident. The case itself is there to be judged:
// what happened, when and where, and the files the patient uploaded, which can
// be opened while the link is open for a decision. Who the patient is and how
// to reach them is not sent at all — name, phone, email, address and the
// treatment area they chose, the names and contact details of the people who
// were with them, and the files' own names, which patients often make their
// own ("Maria_Lopez_license.png"). POST /portal/review-case does not load those
// columns for a link that has not accepted, and the response below is built
// from named fields only, so a column added to a table later reaches the
// browser only when someone adds it here.
//
// The patient's signed retainer is the executed agreement, not evidence. Before
// acceptance the link learns only that one exists; the document itself — and
// anything that would locate it — is served from POST /portal/review-retainer
// to an accepted link alone.
//
// There are no lawyer accounts in this flow. The review link is the lawyer's
// credential: the assignment is found by the hash of the link's token, and the
// state that unlocks the case is read from that assignment row and nothing the
// caller sends.

export type ReviewAssignmentRow = {
  id: string;
  submission_id: string;
  status: string;
  expires_at: string | null;
  decision_expires_at: string | null;
  revoked_at: string | null;
  accepted_at: string | null;
};

export type ReviewState = "pending" | "accepted" | "rejected" | "expired";

export type ReviewAccess = {
  state: ReviewState | "revoked";
  canDecide: boolean;
  /** Whether the patient's identity and contact details, and the files' own names, may be returned. */
  unlocked: boolean;
  /**
   * Whether the case's files may be listed and opened: while the link is open
   * for a decision, and once the lawyer has accepted. Not after a rejection, not
   * once the link has expired, and never for a revoked link.
   */
  documents: boolean;
};

type Row = Record<string, unknown>;

export type ReviewCaseRows = {
  submission: Row | null;
  accident: Row | null;
  claimant: Row | null;
  companions: Row[];
  documents: Row[];
  /**
   * The case's own files that Storage holds, keyed by the documents row's
   * storage path, with the type Storage serves each one as. Only ever filled
   * when the link may open files.
   */
  storedFiles: Map<string, StoredFile>;
  /** The case's completed agreement, if any: its status only, until the lawyer has accepted. */
  agreement: Row | null;
  /** Whether Storage holds the signed retainer at this case's own path. Only ever true once unlocked. */
  retainerStored: boolean;
};

/**
 * How a file may be opened. `image` and `pdf` are served inline — an image in
 * the page, a PDF in the browser's own viewer. Everything else is `file` and is
 * only ever offered as a download, because Storage would otherwise serve it with
 * whatever type the upload declared.
 */
export type DocumentKind = "image" | "pdf" | "file";

export type StoredFile = {
  kind: DocumentKind;
  /** The type Storage serves the object as, which is what the kind was decided from. */
  mimeType: string | null;
};

export type LawyerReviewCase = {
  ok: true;
  access: "masked" | "full";
  review: {
    status: ReviewState;
    canDecide: boolean;
    responseDeadline: string | null;
  };
  caseFacts: {
    incidentType: string | null;
    role: string | null;
    injuries: string | null;
    story: string | null;
    language: string | null;
    companionRelations: string[];
    documentCounts: { category: string; count: number }[];
  };
  patient: {
    firstName: string | null;
    lastName: string | null;
    mobile: string | null;
    email: string | null;
    residence: string | null;
    treatmentArea: string | null;
  } | null;
  incident: {
    date: string | null;
    location: string | null;
  };
  companions:
    | {
        firstName: string | null;
        lastName: string | null;
        relation: string | null;
        cellNumber: string | null;
        email: string | null;
      }[]
    | null;
  // Whether the patient has signed the retainer, and whether this link may open
  // it now. No id, URL or path: the document is fetched from
  // POST /portal/review-retainer with the link's own credentials alone.
  signedRetainer: {
    signed: boolean;
    available: boolean;
  };
  // No URL: a file is fetched from POST /portal/review-document by its id, with
  // the same token, so no Storage URL or object path — which is built from the
  // patient's file name — ever leaves the backend.
  documents:
    | {
        id: string;
        category: string;
        /** Null until the lawyer has accepted. */
        fileName: string | null;
        mimeType: string | null;
        fileSize: number | null;
        kind: DocumentKind;
        /** Whether Storage holds the file inside this case's folder, so that it can be opened. */
        available: boolean;
      }[]
    | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids arrive from an unauthenticated caller; anything that is not a UUID never reaches a query. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** An unparseable expiry is treated as passed; no expiry at all never passes. */
export function isPastDeadline(isoTime: string | null, now: number): boolean {
  if (!isoTime) return false;
  const value = Date.parse(isoTime);
  if (Number.isNaN(value)) return true;
  return value <= now;
}

/**
 * The state of one review link, from its assignment row alone.
 *
 * A revoked link is refused outright. An expired link unlocks nothing and opens
 * no file, even one whose lawyer accepted before it expired. A pending link can
 * open the case's files while the link itself is alive; decision_expires_at
 * only controls whether Accept / Reject is still available. Only an accepted
 * assignment with its acceptance time recorded unlocks the patient's identity.
 * A rejected link keeps nothing but the case facts, and a status this code does
 * not know is refused rather than guessed at.
 */
export function resolveReviewAccess(assignment: ReviewAssignmentRow, now: number = Date.now()): ReviewAccess {
  if (assignment.revoked_at || assignment.status === "revoked") {
    return { state: "revoked", canDecide: false, unlocked: false, documents: false };
  }

  if (assignment.status === "expired" || isPastDeadline(assignment.expires_at, now)) {
    return { state: "expired", canDecide: false, unlocked: false, documents: false };
  }

  if (assignment.status === "pending") {
    return {
      state: "pending",
      canDecide: !isPastDeadline(assignment.decision_expires_at, now),
      unlocked: false,
      documents: true,
    };
  }

  if (assignment.status === "accepted") {
    const unlocked = Boolean(assignment.accepted_at);
    return { state: "accepted", canDecide: false, unlocked, documents: unlocked };
  }

  if (assignment.status === "rejected") {
    return { state: "rejected", canDecide: false, unlocked: false, documents: false };
  }

  return { state: "revoked", canDecide: false, unlocked: false, documents: false };
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Seven or more digits, allowing the separators people type in phone numbers.
// Numeric dates such as 09/14/2026 match too. The accident's own date is shown
// in its own field, but a date a patient types into their story may be their
// date of birth, and the two cannot be told apart, so written dates stay hidden.
const LONG_NUMBER_PATTERN = /\+?\(?\d(?:[\s().\/-]{0,2}\d){6,}/g;
export const HIDDEN_TEXT = "•••";

/**
 * The patient's own words, before the lawyer has accepted.
 *
 * The story is the most useful part of the case and the likeliest to name a
 * person or a place. Email addresses and phone-length numbers are hidden here
 * because they are the direct way round HelpAfterAccident. Names, street names
 * and dates written in words cannot be found reliably without guessing, and are
 * not attempted — that residual risk is documented in the README.
 */
export function hideContactDetails(text: string): string {
  return text.replace(EMAIL_PATTERN, HIDDEN_TEXT).replace(LONG_NUMBER_PATTERN, HIDDEN_TEXT);
}

// Raster formats every browser draws in an <img>. HEIC is left out because only
// Safari can, and SVG because opened on its own it can run script.
const INLINE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];

/**
 * The kind of a stored file, from the content type Storage will serve it with.
 * The documents row carries the type the patient's browser claimed; the bucket
 * accepts any type, so only what Storage actually holds is trusted here.
 */
export function documentKindFor(storedMimeType: string | null | undefined): DocumentKind {
  const type = (storedMimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (INLINE_IMAGE_TYPES.includes(type)) return "image";
  if (type === "application/pdf") return "pdf";
  return "file";
}

/**
 * Whether a storage object belongs to this case: inside the submission's own
 * folder, with no parent-directory segment. A documents row pointing anywhere
 * else is never signed, whatever it says.
 */
export function belongsToCase(objectPath: string, submissionId: string): boolean {
  return (
    objectPath.startsWith(`${submissionId}/`) &&
    !objectPath.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/**
 * The content type a file is served with. Only the inline kinds keep a type of
 * their own, and only one this code chose; everything else is an opaque
 * download, whatever type the upload declared.
 */
export function servedContentType(kind: DocumentKind, storedMimeType: string | null): string {
  if (kind === "pdf") return "application/pdf";
  const type = (storedMimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (kind === "image" && INLINE_IMAGE_TYPES.includes(type)) return type;
  return "application/octet-stream";
}

const FILE_LABELS: Record<string, string> = {
  accidentReport: "accident-report",
  driversLicense: "drivers-license",
  incidentPhotos: "incident-photo",
  insuranceCard: "insurance-card",
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/**
 * The name a file is offered under. Before acceptance it is neutral — the
 * category and the start of the document id — because the name the patient gave
 * the file often is their own. The extension follows what is served: the
 * served type for an image or a PDF, the stored object's own extension for a
 * download. After acceptance it is the patient's file name.
 */
export function reviewFileName(
  document: { id: string; category: string; fileName: string | null; objectPath: string },
  kind: DocumentKind,
  storedMimeType: string | null,
  unlocked: boolean
): string {
  const own = (document.fileName ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  if (unlocked && own) return own.slice(0, 180);

  const type = (storedMimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const objectExtension = document.objectPath.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  const extension =
    kind === "pdf" ? "pdf" : kind === "image" ? (IMAGE_EXTENSIONS[type] ?? "img") : (objectExtension ?? "bin");
  return `${FILE_LABELS[document.category] ?? "document"}-${document.id.slice(0, 8)}.${extension}`;
}

/**
 * Content-Disposition for a served file: inline for an image or a PDF, a
 * download for everything else. The quoted name is ASCII-only, with the full
 * name in RFC 5987 form beside it, so no character a patient typed can end the
 * header or add another.
 */
export function contentDisposition(kind: DocumentKind, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind === "file" ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function readString(row: Row | null, key: string): string | null {
  const value = row?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(row: Row | null, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function documentCategory(document: Row): string {
  return readString(document, "category") ?? "uncategorized";
}

/**
 * The signed retainer's object path, if the agreement row names this case's
 * own: exactly the path the signed document was stored under, derived from the
 * submission and the agreement (`pathFor`, lib/agreement-document.ts). A row
 * pointing anywhere else — another case's folder, a traversal, a hand-edited
 * value — is not served, whatever it says.
 */
export function signedRetainerPath(agreement: Row | null, pathFor: (agreementId: string) => string): string | null {
  const id = readString(agreement, "id");
  const status = readString(agreement, "status");
  const stored = readString(agreement, "signed_document_path");
  if (!id || status !== "completed" || !stored) return null;
  const expected = pathFor(id);
  return stored === expected ? expected : null;
}

export function buildLawyerReviewCase(
  access: ReviewAccess,
  rows: ReviewCaseRows,
  responseDeadline: string | null
): LawyerReviewCase {
  if (access.state === "revoked") {
    throw new Error("A revoked review link has no case to build");
  }

  const unlocked = access.unlocked;
  const story = readString(rows.accident, "description");
  const injuries = readString(rows.accident, "injuries");

  const counts = new Map<string, number>();
  for (const document of rows.documents) {
    const category = documentCategory(document);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return {
    ok: true,
    access: unlocked ? "full" : "masked",
    review: {
      status: access.state,
      canDecide: access.canDecide,
      responseDeadline,
    },
    caseFacts: {
      incidentType: readString(rows.accident, "incident_type"),
      role: readString(rows.accident, "role"),
      injuries: injuries && !unlocked ? hideContactDetails(injuries) : injuries,
      story: story && !unlocked ? hideContactDetails(story) : story,
      language: readString(rows.submission, "locale"),
      companionRelations: rows.companions
        .map((companion) => readString(companion, "relation"))
        .filter((relation): relation is string => relation !== null),
      documentCounts: [...counts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    },
    patient: unlocked
      ? {
          firstName: readString(rows.claimant, "first_name"),
          lastName: readString(rows.claimant, "last_name"),
          mobile: readString(rows.claimant, "mobile"),
          email: readString(rows.claimant, "email"),
          residence: readString(rows.claimant, "residence"),
          treatmentArea: readString(rows.submission, "treatment_area"),
        }
      : null,
    signedRetainer: {
      signed: readString(rows.agreement, "status") === "completed",
      available: unlocked && readString(rows.agreement, "status") === "completed" && rows.retainerStored,
    },
    // When and where are part of judging the case, not of reaching the patient.
    incident: {
      date: readString(rows.accident, "incident_date"),
      location: readString(rows.accident, "incident_location"),
    },
    companions: unlocked
      ? rows.companions.map((companion) => ({
          firstName: readString(companion, "first_name"),
          lastName: readString(companion, "last_name"),
          relation: readString(companion, "relation"),
          cellNumber: readString(companion, "cell_number"),
          email: readString(companion, "email"),
        }))
      : null,
    documents: access.documents
      ? rows.documents.map((document, index) => {
          const id = readString(document, "id");
          const storagePath = readString(document, "storage_path");
          const stored = storagePath ? rows.storedFiles.get(storagePath) : undefined;
          return {
            id: id ?? `document-${index}`,
            category: documentCategory(document),
            fileName: unlocked ? readString(document, "file_name") : null,
            mimeType: stored?.mimeType ?? readString(document, "mime_type"),
            fileSize: readNumber(document, "file_size"),
            kind: stored?.kind ?? "file",
            available: stored !== undefined && id !== null,
          };
        })
      : null,
  };
}
