import type {
  CaseCompanionInput,
  CaseDocumentInput,
  CaseLocationDetailsInput,
  CaseSummaryUpdatePayload,
} from "../types/case";

// What POST /case/:submissionId accepts, decided before anything is written.
//
// Unlike the intake routes, this one checks shape and values at runtime: the
// case has already been submitted and reviewed by people, so a malformed or
// widened body must never reach the database. Keys are allowlisted at every
// level — a body naming anything else is refused rather than half-applied.
//
// Email and phone are refused by name, at the top level and inside claimant.
// They are how the patient signs in and how HAA reaches them; changing either
// needs its own verified flow, which Case Summary is not. Hiding the inputs on
// the screen is not the guarantee — this is. A companion's cell number and
// email are different: they are details the patient gave about someone else,
// and the patient may correct them like any other answer.

/** Values the intake screens offer (haa-frontend src/types/intake.ts). */
export const INCIDENT_TYPES = [
  "car",
  "motorcycle",
  "truck",
  "rideshare",
  "slip-and-fall",
  "pedestrian",
  "bicycle",
  "other",
] as const;
export const ROLES = ["driver", "passenger", "pedestrian", "bicyclist"] as const;
/** haa-frontend src/lib/companion-relations.ts. */
export const COMPANION_RELATIONS = ["passenger", "driver", "other"] as const;
/** haa-frontend src/types/intake.ts EVIDENCE_CATEGORY_VALUES. */
export const EVIDENCE_CATEGORIES = ["accidentReport", "incidentPhotos", "insuranceCard", "driversLicense"] as const;

export const MAX_COMPANIONS = 20;
export const MAX_DOCUMENT_CHANGES = 20;
/** The evidence screen's limit (haa-frontend intake/evidence/page.tsx MAX_FILE_SIZE). */
export const MAX_DOCUMENT_BYTES = 25 * 1000 * 1000;

const LOCATION_SOURCES = ["autosuggest", "current_location", "manual"] as const;
const LOCATION_PRECISIONS = ["address", "city_estimate", "unvalidated"] as const;

/** The name screen's rule (haa-frontend components/name/name-screen.tsx). */
const NAME_PATTERN = /^[a-zA-ZÀ-ÿ\s'-]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A companion's name is whatever the patient called them on the intake ("2nd Bro"
// included), so it is not held to the patient's own name rule — only to no
// control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the evidence screen lets a case hold (haa-frontend lib/upload-source.ts): stills and PDFs. */
const DOCUMENT_MIME_PATTERN = /^(image\/[a-z0-9.+-]+|application\/pdf)$/i;

const CONTACT_FIELDS = ["email", "phone", "mobile"];
const TOP_LEVEL_FIELDS = [
  "claimant",
  "accident",
  "injuries",
  "treatmentArea",
  "treatmentAreaLocationDetails",
  "companions",
  "documents",
];
const CLAIMANT_FIELDS = ["firstName", "lastName"];
const COMPANION_FIELDS = ["id", "firstName", "lastName", "relation", "cellNumber", "email"];
const DOCUMENTS_FIELDS = ["add", "remove"];
const DOCUMENT_FIELDS = ["storagePath", "fileName", "mimeType", "fileSize", "category"];
const ACCIDENT_FIELDS = ["incidentType", "incidentDate", "incidentLocation", "incidentLocationDetails", "role"];
const LOCATION_FIELDS = [
  "text",
  "latitude",
  "longitude",
  "placeId",
  "city",
  "state",
  "postalCode",
  "source",
  "precision",
];

export type CaseSummaryUpdateError =
  | "invalid_body"
  | "field_not_editable"
  | "unknown_field"
  | "invalid_name"
  | "invalid_accident"
  | "invalid_incident_date"
  | "invalid_injuries"
  | "invalid_treatment_area"
  | "invalid_location_details"
  | "invalid_companions"
  | "invalid_documents"
  | "no_changes";

export type CaseSummaryUpdateResult =
  { ok: true; update: CaseSummaryUpdatePayload } | { ok: false; error: CaseSummaryUpdateError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

// The patient's own contact fields are refused by name wherever they could
// stand for the patient; a companion's are allowed by passing false.
function keysProblem(
  value: Record<string, unknown>,
  allowed: string[],
  refuseContact = true
): CaseSummaryUpdateError | null {
  const keys = Object.keys(value);
  if (refuseContact && keys.some((key) => CONTACT_FIELDS.includes(key))) return "field_not_editable";
  if (keys.some((key) => !allowed.includes(key))) return "unknown_field";
  return null;
}

/**
 * The incident happened on or before today. "Today" is the patient's, and the
 * server only knows UTC, so a date one day ahead of UTC is still accepted —
 * the screen already refuses a future date in the patient's own timezone.
 */
function isAcceptableIncidentDate(value: string, now: Date): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (year < 1900) return false;
  const latest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return date.getTime() <= latest;
}

function parseLocationDetails(value: unknown): CaseLocationDetailsInput | null | "invalid" {
  if (value === null) return null;
  if (!isRecord(value) || keysProblem(value, LOCATION_FIELDS)) return "invalid";

  const source = value.source;
  const precision = value.precision;
  if (!LOCATION_SOURCES.includes(source as (typeof LOCATION_SOURCES)[number])) return "invalid";
  if (!LOCATION_PRECISIONS.includes(precision as (typeof LOCATION_PRECISIONS)[number])) return "invalid";

  const coordinate = (raw: unknown, limit: number) => {
    if (raw === undefined) return undefined;
    return typeof raw === "number" && Number.isFinite(raw) && Math.abs(raw) <= limit ? raw : "invalid";
  };
  const optionalText = (raw: unknown) => {
    if (raw === undefined) return undefined;
    return typeof raw === "string" && raw.length <= 300 ? raw : "invalid";
  };

  const latitude = coordinate(value.latitude, 90);
  const longitude = coordinate(value.longitude, 180);
  const fields = {
    text: optionalText(value.text),
    placeId: optionalText(value.placeId),
    city: optionalText(value.city),
    state: optionalText(value.state),
    postalCode: optionalText(value.postalCode),
  };
  if (latitude === "invalid" || longitude === "invalid") return "invalid";
  if (Object.values(fields).some((field) => field === "invalid")) return "invalid";

  return {
    ...(fields.text !== undefined && { text: fields.text as string }),
    ...(latitude !== undefined && { latitude }),
    ...(longitude !== undefined && { longitude }),
    ...(fields.placeId !== undefined && { placeId: fields.placeId as string }),
    ...(fields.city !== undefined && { city: fields.city as string }),
    ...(fields.state !== undefined && { state: fields.state as string }),
    ...(fields.postalCode !== undefined && { postalCode: fields.postalCode as string }),
    source: source as CaseLocationDetailsInput["source"],
    precision: precision as CaseLocationDetailsInput["precision"],
  };
}

/** "(407) 555-1234" from any spelling of ten US digits, as the intake's form writes it. */
function formatCellNumber(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const all = value.replace(/\D/g, "");
  // a leading US country code is dropped; anything else must be exactly ten digits
  const digits = all.length === 11 && all.startsWith("1") ? all.slice(1) : all;
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function parseCompanions(value: unknown): CaseCompanionInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMPANIONS) return null;
  const companions: CaseCompanionInput[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || keysProblem(entry, COMPANION_FIELDS, false)) return null;
    const id = entry.id === undefined ? undefined : entry.id;
    if (id !== undefined && (typeof id !== "string" || !UUID_PATTERN.test(id) || ids.has(id))) return null;
    const firstName = text(entry.firstName, 100);
    // the intake asks only for a first name; the column is not null, so a missing last name is ""
    const lastName = entry.lastName === undefined || entry.lastName === "" ? "" : text(entry.lastName, 100);
    const relation = text(entry.relation, 32);
    const cellNumber = formatCellNumber(entry.cellNumber);
    const rawEmail = entry.email === undefined || entry.email === null ? "" : entry.email;
    if (typeof rawEmail !== "string") return null;
    const email = rawEmail.trim();
    if (!firstName || CONTROL_CHARACTERS.test(firstName)) return null;
    if (lastName === null || CONTROL_CHARACTERS.test(lastName)) return null;
    if (!relation || !COMPANION_RELATIONS.includes(relation as (typeof COMPANION_RELATIONS)[number])) return null;
    if (!cellNumber) return null;
    if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) return null;
    if (id) ids.add(id);
    companions.push({ ...(id && { id }), firstName, lastName, relation, cellNumber, email: email || null });
  }
  return companions;
}

function parseDocumentChanges(value: unknown): { add: CaseDocumentInput[]; remove: string[] } | null {
  if (!isRecord(value) || keysProblem(value, DOCUMENTS_FIELDS)) return null;
  const add = value.add === undefined ? [] : value.add;
  const remove = value.remove === undefined ? [] : value.remove;
  if (!Array.isArray(add) || !Array.isArray(remove)) return null;
  if (add.length + remove.length === 0 || add.length + remove.length > MAX_DOCUMENT_CHANGES) return null;

  const added: CaseDocumentInput[] = [];
  const paths = new Set<string>();
  for (const entry of add) {
    if (!isRecord(entry) || keysProblem(entry, DOCUMENT_FIELDS)) return null;
    const storagePath = text(entry.storagePath, 500);
    const fileName = text(entry.fileName, 255);
    const mimeType = text(entry.mimeType, 100);
    const category = text(entry.category, 64);
    const fileSize = entry.fileSize;
    if (!storagePath || paths.has(storagePath) || !fileName || !mimeType || !DOCUMENT_MIME_PATTERN.test(mimeType)) {
      return null;
    }
    if (!category || !EVIDENCE_CATEGORIES.includes(category as (typeof EVIDENCE_CATEGORIES)[number])) return null;
    if (typeof fileSize !== "number" || !Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_DOCUMENT_BYTES) {
      return null;
    }
    paths.add(storagePath);
    added.push({ storagePath, fileName, mimeType, fileSize, category });
  }

  const removed: string[] = [];
  for (const id of remove) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id) || removed.includes(id)) return null;
    removed.push(id);
  }
  return { add: added, remove: removed };
}

export function parseCaseSummaryUpdate(body: unknown, now: Date = new Date()): CaseSummaryUpdateResult {
  if (!isRecord(body)) return { ok: false, error: "invalid_body" };
  const topLevel = keysProblem(body, TOP_LEVEL_FIELDS);
  if (topLevel) return { ok: false, error: topLevel };

  const update: CaseSummaryUpdatePayload = {};

  if (body.claimant !== undefined) {
    if (!isRecord(body.claimant)) return { ok: false, error: "invalid_body" };
    const problem = keysProblem(body.claimant, CLAIMANT_FIELDS);
    if (problem) return { ok: false, error: problem };
    const firstName = text(body.claimant.firstName, 100);
    const lastName = text(body.claimant.lastName, 100);
    if (!firstName || !lastName || !NAME_PATTERN.test(firstName) || !NAME_PATTERN.test(lastName)) {
      return { ok: false, error: "invalid_name" };
    }
    update.claimant = { firstName, lastName };
  }

  if (body.accident !== undefined) {
    if (!isRecord(body.accident)) return { ok: false, error: "invalid_body" };
    const problem = keysProblem(body.accident, ACCIDENT_FIELDS);
    if (problem) return { ok: false, error: problem };
    const incidentType = text(body.accident.incidentType, 64);
    const incidentLocation = text(body.accident.incidentLocation, 300);
    const role = text(body.accident.role, 64);
    const incidentDate = text(body.accident.incidentDate, 10);
    if (
      !incidentType ||
      !INCIDENT_TYPES.includes(incidentType as (typeof INCIDENT_TYPES)[number]) ||
      !incidentLocation ||
      !role ||
      !ROLES.includes(role as (typeof ROLES)[number])
    ) {
      return { ok: false, error: "invalid_accident" };
    }
    if (!incidentDate || !isAcceptableIncidentDate(incidentDate, now)) {
      return { ok: false, error: "invalid_incident_date" };
    }
    const details =
      body.accident.incidentLocationDetails === undefined
        ? undefined
        : parseLocationDetails(body.accident.incidentLocationDetails);
    if (details === "invalid") return { ok: false, error: "invalid_location_details" };
    update.accident = {
      incidentType,
      incidentDate,
      incidentLocation,
      role,
      ...(details !== undefined && { incidentLocationDetails: details }),
    };
  }

  if (body.injuries !== undefined) {
    const injuries = text(body.injuries, 1000);
    if (!injuries) return { ok: false, error: "invalid_injuries" };
    update.injuries = injuries;
  }

  if (body.treatmentAreaLocationDetails !== undefined && body.treatmentArea === undefined) {
    // details without the place they describe would contradict what is stored
    return { ok: false, error: "invalid_treatment_area" };
  }
  if (body.treatmentArea !== undefined) {
    const treatmentArea = text(body.treatmentArea, 300);
    if (!treatmentArea) return { ok: false, error: "invalid_treatment_area" };
    const details =
      body.treatmentAreaLocationDetails === undefined
        ? undefined
        : parseLocationDetails(body.treatmentAreaLocationDetails);
    if (details === "invalid") return { ok: false, error: "invalid_location_details" };
    update.treatmentArea = treatmentArea;
    if (details !== undefined) update.treatmentAreaLocationDetails = details;
  }

  if (body.companions !== undefined) {
    const companions = parseCompanions(body.companions);
    if (!companions) return { ok: false, error: "invalid_companions" };
    update.companions = companions;
  }

  if (body.documents !== undefined) {
    const documents = parseDocumentChanges(body.documents);
    if (!documents) return { ok: false, error: "invalid_documents" };
    update.documents = documents;
  }

  if (Object.keys(update).length === 0) return { ok: false, error: "no_changes" };
  return { ok: true, update };
}
