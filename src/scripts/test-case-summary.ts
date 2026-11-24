import { strict as assert } from "assert";
import { canEditCaseSummary, SUBMITTED_CASE_STATUSES } from "../lib/case-status";
import { parseCaseSummaryUpdate } from "../lib/case-summary";
import { locationColumns, locationDetailsFromRow } from "../lib/location-columns";

// What Case Summary's Save may change, without a database: which cases it may
// change, the body POST /case/:submissionId accepts, and that email and phone
// are refused however a request is shaped. The route itself is exercised
// against a real stack by test-case-summary-route.ts.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

const NOW = new Date("2026-10-09T12:00:00.000Z");
const parse = (body: unknown) => parseCaseSummaryUpdate(body, NOW);
const errorOf = (body: unknown) => {
  const result = parse(body);
  return result.ok ? "ok" : result.error;
};

const ACCIDENT = {
  incidentType: "car",
  incidentDate: "2026-09-05",
  incidentLocation: "San Diego, CA, USA",
  role: "driver",
};
const DETAILS = {
  text: "San Diego, CA, USA",
  latitude: 32.7157,
  longitude: -117.1611,
  placeId: "ChIJSx6SrQ9T2YARed8V_f0hOg0",
  city: "San Diego",
  state: "CA",
  postalCode: "92101",
  source: "autosuggest",
  precision: "address",
};

// ── edit policy ─────────────────────────────────────────────────────────────
for (const status of SUBMITTED_CASE_STATUSES) {
  record(`a ${status} case can be edited`, canEditCaseSummary(status));
}
for (const status of ["intake", "in_progress", "", "SUBMITTED"]) {
  record(`"${status}" cannot be edited here`, !canEditCaseSummary(status));
}

// ── email and phone are never accepted ──────────────────────────────────────
for (const field of ["email", "phone", "mobile"]) {
  record(`top-level ${field} is refused`, errorOf({ [field]: "x" }) === "field_not_editable");
  record(
    `claimant.${field} is refused even beside a valid name`,
    errorOf({ claimant: { firstName: "Ana", lastName: "Ruiz", [field]: "x" } }) === "field_not_editable"
  );
  record(
    `${field} inside accident is refused`,
    errorOf({ accident: { ...ACCIDENT, [field]: "x" } }) === "field_not_editable"
  );
  record(
    `${field} next to a valid change still refuses the whole body`,
    errorOf({ injuries: "back", [field]: "x" }) === "field_not_editable"
  );
}

// ── nothing else can be smuggled in ─────────────────────────────────────────
for (const field of ["status", "submissionId", "claimantId", "userId", "admin_notes"]) {
  record(`top-level ${field} is refused`, errorOf({ injuries: "back", [field]: "x" }) === "unknown_field");
}
record(
  "an unknown claimant field is refused",
  errorOf({ claimant: { firstName: "Ana", lastName: "Ruiz", user_id: "x" } }) === "unknown_field"
);
record(
  "an unknown accident field is refused",
  errorOf({ accident: { ...ACCIDENT, description: "x" } }) === "unknown_field"
);
record(
  "an unknown location detail is refused",
  errorOf({ treatmentArea: "Orlando, FL", treatmentAreaLocationDetails: { ...DETAILS, extra: 1 } }) ===
    "invalid_location_details"
);
for (const body of [null, "x", 1, [], [{ injuries: "back" }]]) {
  record(`a ${JSON.stringify(body)} body is refused`, errorOf(body) === "invalid_body");
}
record("an empty body is refused", errorOf({}) === "no_changes");
record("a claimant that is not an object is refused", errorOf({ claimant: "Ana Ruiz" }) === "invalid_body");

// ── names ───────────────────────────────────────────────────────────────────
record(
  "a valid name is accepted and trimmed",
  (() => {
    const result = parse({ claimant: { firstName: "  José ", lastName: "O'Neil-Ruiz " } });
    return (
      result.ok && result.update.claimant?.firstName === "José" && result.update.claimant.lastName === "O'Neil-Ruiz"
    );
  })()
);
record("a missing last name is refused", errorOf({ claimant: { firstName: "Ana" } }) === "invalid_name");
record(
  "a blank first name is refused",
  errorOf({ claimant: { firstName: "  ", lastName: "Ruiz" } }) === "invalid_name"
);
record(
  "digits in a name are refused",
  errorOf({ claimant: { firstName: "Ana1", lastName: "Ruiz" } }) === "invalid_name"
);
record("markup in a name is refused", errorOf({ claimant: { firstName: "<b>", lastName: "Ruiz" } }) === "invalid_name");
record(
  "a 101-character name is refused",
  errorOf({ claimant: { firstName: "a".repeat(101), lastName: "Ruiz" } }) === "invalid_name"
);

// ── accident ────────────────────────────────────────────────────────────────
record("a complete accident is accepted", errorOf({ accident: ACCIDENT }) === "ok");
record(
  "an unknown incident type is refused",
  errorOf({ accident: { ...ACCIDENT, incidentType: "boat" } }) === "invalid_accident"
);
record("an unknown role is refused", errorOf({ accident: { ...ACCIDENT, role: "witness" } }) === "invalid_accident");
record(
  "a missing location is refused",
  errorOf({ accident: { ...ACCIDENT, incidentLocation: "" } }) === "invalid_accident"
);
record("a partial accident is refused", errorOf({ accident: { incidentType: "car" } }) === "invalid_accident");
record("today is accepted", errorOf({ accident: { ...ACCIDENT, incidentDate: "2026-10-09" } }) === "ok");
record(
  "tomorrow in UTC is accepted for a patient ahead of UTC",
  errorOf({ accident: { ...ACCIDENT, incidentDate: "2026-10-10" } }) === "ok"
);
record(
  "two days ahead is refused",
  errorOf({ accident: { ...ACCIDENT, incidentDate: "2026-10-11" } }) === "invalid_incident_date"
);
for (const date of ["2026-02-30", "2026-13-01", "09/05/2026", "2026-9-5", "1899-12-31", ""]) {
  record(
    `incident date "${date}" is refused`,
    errorOf({ accident: { ...ACCIDENT, incidentDate: date } }) === "invalid_incident_date"
  );
}
record(
  "accident location details are carried through",
  (() => {
    const result = parse({ accident: { ...ACCIDENT, incidentLocationDetails: DETAILS } });
    return result.ok && result.update.accident?.incidentLocationDetails?.placeId === DETAILS.placeId;
  })()
);
record(
  "null accident details are accepted (clears them)",
  (() => {
    const result = parse({ accident: { ...ACCIDENT, incidentLocationDetails: null } });
    return result.ok && result.update.accident?.incidentLocationDetails === null;
  })()
);
record(
  "an out-of-range latitude is refused",
  errorOf({ accident: { ...ACCIDENT, incidentLocationDetails: { ...DETAILS, latitude: 91 } } }) ===
    "invalid_location_details"
);
record(
  "an unknown location source is refused",
  errorOf({ accident: { ...ACCIDENT, incidentLocationDetails: { ...DETAILS, source: "gps" } } }) ===
    "invalid_location_details"
);

// ── injuries and treatment area ─────────────────────────────────────────────
record("injuries are accepted", errorOf({ injuries: "back,neck" }) === "ok");
record("empty injuries are refused", errorOf({ injuries: " " }) === "invalid_injuries");
record("non-string injuries are refused", errorOf({ injuries: ["back"] }) === "invalid_injuries");
record("a treatment area is accepted", errorOf({ treatmentArea: "Orlando, FL 32801" }) === "ok");
record("an empty treatment area is refused", errorOf({ treatmentArea: "" }) === "invalid_treatment_area");
record(
  "treatment details without the area are refused",
  errorOf({ treatmentAreaLocationDetails: DETAILS }) === "invalid_treatment_area"
);

// ── companions ──────────────────────────────────────────────────────────────
const PERSON = { firstName: "Maria", lastName: "Lopez", relation: "passenger", cellNumber: "4075551234", email: "" };
const ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const companionsOf = (body: unknown) => {
  const result = parse(body);
  return result.ok ? result.update.companions : undefined;
};
record("a new companion is accepted", errorOf({ companions: [PERSON] }) === "ok");
record(
  "…its cell number is stored as the intake stores it, and an empty email as null",
  JSON.stringify(companionsOf({ companions: [{ ...PERSON, cellNumber: "+1 407-555-1234" }] })) ===
    JSON.stringify([{ ...PERSON, cellNumber: "(407) 555-1234", email: null }])
);
record("a companion kept by id is accepted", errorOf({ companions: [{ ...PERSON, id: ID }] }) === "ok");
record("an empty list removes everyone", errorOf({ companions: [] }) === "ok");
record(
  "a companion's email is allowed",
  errorOf({ companions: [{ ...PERSON, email: "maria@example.test" }] }) === "ok"
);
record("a last name is optional, as on the intake", errorOf({ companions: [{ ...PERSON, lastName: "" }] }) === "ok");
record(
  'a companion\'s name is what the intake accepts, digits included ("2nd Bro")',
  errorOf({ companions: [{ ...PERSON, firstName: "2nd", lastName: "Bro" }] }) === "ok"
);
record(
  "…while the patient's own name keeps its rule",
  errorOf({ claimant: { firstName: "2nd", lastName: "Bro" } }) === "invalid_name"
);
for (const [label, person] of [
  ["no first name", { ...PERSON, firstName: " " }],
  ["a name with a control character", { ...PERSON, firstName: "Ma\u0000ria" }],
  ["a name over 100 characters", { ...PERSON, firstName: "M".repeat(101) }],
  ["a relation the intake does not offer", { ...PERSON, relation: "cousin" }],
  ["a cell number that is not ten digits", { ...PERSON, cellNumber: "555-1234" }],
  ["eleven digits that are not a US country code", { ...PERSON, cellNumber: "24075551234" }],
  ["no cell number", { ...PERSON, cellNumber: "" }],
  ["an invalid email", { ...PERSON, email: "not-an-email" }],
  ["an id that is not a uuid", { ...PERSON, id: "1" }],
  ["an unknown field", { ...PERSON, phone: "4075551234" }],
] as const) {
  record(`a companion with ${label} is refused`, errorOf({ companions: [person] }) === "invalid_companions");
}
record(
  "the same id twice is refused",
  errorOf({
    companions: [
      { ...PERSON, id: ID },
      { ...PERSON, id: ID },
    ],
  }) === "invalid_companions"
);
record("companions must be a list", errorOf({ companions: PERSON }) === "invalid_companions");
record(
  "more than 20 companions are refused",
  errorOf({ companions: Array.from({ length: 21 }, () => PERSON) }) === "invalid_companions"
);
record(
  "a companion list does not open the patient's own contact fields",
  errorOf({ companions: [PERSON], email: "me@example.test" }) === "field_not_editable" &&
    errorOf({ companions: [PERSON], claimant: { firstName: "A", lastName: "B", phone: "1" } }) === "field_not_editable"
);

// ── documents ───────────────────────────────────────────────────────────────
const FILE = {
  storagePath: `${ID}/insuranceCard/card-1a2b3c4d.jpg`,
  fileName: "card.jpg",
  mimeType: "image/jpeg",
  fileSize: 120_000,
  category: "insuranceCard",
};
record("adding an uploaded file is accepted", errorOf({ documents: { add: [FILE] } }) === "ok");
record(
  "adding a PDF is accepted",
  errorOf({ documents: { add: [{ ...FILE, mimeType: "application/pdf" }] } }) === "ok"
);
record("removing a document by id is accepted", errorOf({ documents: { remove: [ID] } }) === "ok");
for (const [label, documents] of [
  ["nothing to add or remove", {}],
  ["a video", { add: [{ ...FILE, mimeType: "video/mp4" }] }],
  ["an unknown category", { add: [{ ...FILE, category: "selfie" }] }],
  ["an empty file", { add: [{ ...FILE, fileSize: 0 }] }],
  ["a file over 25 MB", { add: [{ ...FILE, fileSize: 25_000_001 }] }],
  ["the same file twice", { add: [FILE, FILE] }],
  ["a removal that is not a uuid", { remove: ["../x"] }],
  ["the same removal twice", { remove: [ID, ID] }],
  ["an unknown field", { add: [FILE], replace: [] }],
  ["more than 20 changes", { remove: Array.from({ length: 21 }, (_, i) => ID.replace(/.$/, String(i % 10))) }],
] as const) {
  record(`documents with ${label} are refused`, errorOf({ documents }) === "invalid_documents");
}

// ── stored location details read back as they were written ─────────────────
const written = locationColumns(DETAILS as Parameters<typeof locationColumns>[0], "incident");
const readBack = locationDetailsFromRow(
  // PostgREST hands numeric columns back as strings.
  { ...written, incident_lat: String(DETAILS.latitude), incident_lng: String(DETAILS.longitude) },
  "incident",
  DETAILS.text
);
record("location details round-trip through the columns", JSON.stringify(readBack) === JSON.stringify(DETAILS));
record(
  "a place stored without a source reads back as no details",
  locationDetailsFromRow({ incident_source: null, incident_precision: null }, "incident", "Somewhere") === null
);
record("no place reads back as no details", locationDetailsFromRow(written, "incident", "") === null);

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
assert(failed.length === 0, `${failed.length} case summary check(s) failed`);
