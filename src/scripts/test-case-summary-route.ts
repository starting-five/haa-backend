import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt } from "crypto";
import type { AddressInfo } from "net";

// GET and POST /case/:submissionId, and GET /case/:submissionId/documents/:id,
// against a real stack: two patients, each
// with a case submitted through /intake/start and /intake/complete, and every
// edit tried by its owner, by the other patient, by no one, and in every stage
// of the case — every submitted stage editable, an unsubmitted intake not.
// Each claim is read back from the database, not from the response alone — a
// 400 that still wrote something is a failure, and so is a save that moves
// the case's status.
//
//   TEST_SUPABASE_PROJECT_REF=local DOTENV_CONFIG_PATH=<local backend env> npm run test:case-summary-route

/** Stamped on every claimant this suite creates, so its own leftovers are recognisable. */
const TEST_MARKER = "CaseSummarySuite";

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) throw new Error("TEST_SUPABASE_PROJECT_REF is required.");
  // "local" names a Supabase CLI stack on this machine, and only on a loopback address.
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const configuredRef =
    expectedRef === "local"
      ? /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(supabaseUrl)
        ? "local"
        : undefined
      : supabaseUrl.match(/^https:\/\/([a-z]{20})\.supabase\.co/)?.[1];
  assert(
    configuredRef === expectedRef,
    "Refusing to run: SUPABASE_URL does not point at the project named by TEST_SUPABASE_PROJECT_REF"
  );

  process.env.DEV_OTP_BRIDGE = "enabled";
  delete process.env.NODE_ENV;

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const phones = new Set<string>();
  const uploadedPaths = new Set<string>();
  const newPhone = () => {
    const value = `+1555${randomInt(1_000_000, 9_999_999)}`;
    phones.add(value);
    return value;
  };

  const login = async (phone: string): Promise<string> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const r = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (r.ok) return ((await r.json()) as { accessToken: string }).accessToken;
      if (r.status !== 502 || attempt === 4) throw new Error(`login failed: ${r.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  const auth = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
  const getCase = (token: string | null, submissionId: string) =>
    fetch(`${base}/case/${submissionId}`, { headers: auth(token) });
  const saveCase = (token: string | null, submissionId: string, body: unknown) =>
    fetch(`${base}/case/${submissionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify(body),
    });
  /** Never throws: a 500 serves an HTML page, and that must fail a check, not the run. */
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    try {
      return (await response.clone().json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const ORIGINAL = {
    incidentType: "car",
    incidentDate: "2026-09-05",
    incidentLocation: "San Diego, CA, USA",
    role: "driver",
    injuries: "back,neck",
    treatmentArea: "San Diego, CA 92101",
  };

  const makePatient = async (label: string) => {
    const phone = newPhone();
    const token = await login(phone);
    const email = `${label.toLowerCase()}@example.test`;
    const started = await fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({
        locale: "en",
        claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone, email },
        accident: {
          incidentType: ORIGINAL.incidentType,
          incidentLocation: ORIGINAL.incidentLocation,
          incidentDate: ORIGINAL.incidentDate,
        },
      }),
    });
    const { submissionId } = (await json(started)) as { submissionId: string };
    const completed = await fetch(`${base}/intake/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({
        submissionId,
        claimant: {},
        accident: {
          incidentType: ORIGINAL.incidentType,
          incidentDate: ORIGINAL.incidentDate,
          incidentLocation: ORIGINAL.incidentLocation,
          role: ORIGINAL.role,
          injuries: ORIGINAL.injuries,
        },
        treatmentArea: ORIGINAL.treatmentArea,
        documents: [],
        companions: [{ firstName: "Lena", lastName: TEST_MARKER, relation: "friend", cellNumber: "5550100" }],
      }),
    });
    assert(completed.ok, `could not submit ${label}'s case: ${completed.status}`);
    const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", phone).single();
    return { phone, email, token, submissionId, claimantId: claimant!.id as string };
  };

  type Patient = Awaited<ReturnType<typeof makePatient>>;

  const snapshot = async (patient: Patient) => {
    const { data: claimant } = await supabase
      .from("claimants")
      .select("first_name, last_name, mobile, email")
      .eq("id", patient.claimantId)
      .single();
    const { data: accident } = await supabase
      .from("accidents")
      .select("incident_type, incident_date, incident_location, role, injuries, incident_place_id")
      .eq("submission_id", patient.submissionId)
      .single();
    const { data: submission } = await supabase
      .from("intake_submissions")
      .select("status, treatment_area, treatment_area_place_id")
      .eq("id", patient.submissionId)
      .single();
    const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authPhone = (users.users ?? []).find((user) => user.phone === patient.phone.replace("+", ""))?.phone ?? null;
    return JSON.stringify({ claimant, accident, submission, authPhone });
  };

  const setStatus = async (patient: Patient, status: string) => {
    const { error } = await supabase.from("intake_submissions").update({ status }).eq("id", patient.submissionId);
    assert(!error, `could not set status ${status}`);
  };

  const EDIT = {
    claimant: { firstName: "Mariana", lastName: "Ortega-Ruiz" },
    accident: {
      incidentType: "motorcycle",
      incidentDate: "2026-09-01",
      incidentLocation: "Orlando, FL, USA",
      incidentLocationDetails: {
        text: "Orlando, FL, USA",
        latitude: 28.5383,
        longitude: -81.3792,
        placeId: "ChIJd7zN_thz54gRnr-lPAaywwo",
        city: "Orlando",
        state: "FL",
        source: "autosuggest",
        precision: "city_estimate",
      },
      role: "passenger",
    },
    injuries: "head,shoulder",
    treatmentArea: "Orlando, FL 32801",
    treatmentAreaLocationDetails: {
      text: "Orlando, FL 32801",
      placeId: "ChIJ-treatment-place",
      city: "Orlando",
      state: "FL",
      postalCode: "32801",
      source: "autosuggest",
      precision: "city_estimate",
    },
  };

  try {
    const A = await makePatient("PatientA");
    const B = await makePatient("PatientB");
    record("two patients with submitted cases were created", A.submissionId !== B.submissionId);

    // ── reading ─────────────────────────────────────────────────────────────
    const read = await getCase(A.token, A.submissionId);
    const summary = await json(read);
    record("the owner reads their case summary", read.status === 200);
    record(
      "the summary carries name, phone and email from the claimant",
      summary.firstName === "PatientA" &&
        summary.lastName === TEST_MARKER &&
        summary.phone === A.phone &&
        summary.email === A.email
    );
    record(
      "the summary carries the accident, injuries and treatment area as submitted",
      summary.incidentType === ORIGINAL.incidentType &&
        summary.incidentDate === ORIGINAL.incidentDate &&
        summary.incidentLocation === ORIGINAL.incidentLocation &&
        summary.role === ORIGINAL.role &&
        summary.injuries === ORIGINAL.injuries &&
        summary.treatmentArea === ORIGINAL.treatmentArea
    );
    const companions = summary.companions as { id: string; firstName: string; relation: string }[] | undefined;
    record(
      "companions are listed with their id and the details the patient gave, for editing",
      companions?.length === 1 &&
        companions[0]?.firstName === "Lena" &&
        JSON.stringify(Object.keys(companions[0] ?? {}).sort()) ===
          '["cellNumber","email","firstName","id","lastName","relation"]'
    );
    record("a submitted case is reported editable", summary.editable === true);
    record("the other patient cannot read it", (await getCase(B.token, A.submissionId)).status === 404);
    record("no session cannot read it", (await getCase(null, A.submissionId)).status === 401);

    // ── what is refused writes nothing ──────────────────────────────────────
    const before = await snapshot(A);
    const refusals: [string, string | null, unknown, number, string | undefined][] = [
      ["a body changing email", A.token, { email: "attacker@example.test" }, 400, "field_not_editable"],
      ["a body changing phone", A.token, { phone: "+15550000000" }, 400, "field_not_editable"],
      ["a body changing mobile", A.token, { mobile: "+15550000000" }, 400, "field_not_editable"],
      [
        "a name change carrying claimant.email",
        A.token,
        { claimant: { ...EDIT.claimant, email: "attacker@example.test" } },
        400,
        "field_not_editable",
      ],
      [
        "a name change carrying claimant.mobile",
        A.token,
        { claimant: { ...EDIT.claimant, mobile: "+15550000000" } },
        400,
        "field_not_editable",
      ],
      ["a valid edit that also sets status", A.token, { injuries: "head", status: "signed" }, 400, "unknown_field"],
      ["an invalid name", A.token, { claimant: { firstName: "<script>", lastName: "x" } }, 400, "invalid_name"],
      ["an empty body", A.token, {}, 400, "no_changes"],
      ["the other patient's edit", B.token, EDIT, 404, undefined],
      ["an edit with no session", null, EDIT, 401, undefined],
    ];
    for (const [label, token, body, status, error] of refusals) {
      const response = await saveCase(token, A.submissionId, body);
      const answer = await json(response);
      record(
        `${label} is refused (${status}${error ? ` ${error}` : ""})`,
        response.status === status && (error === undefined || answer.error === error)
      );
    }
    record("…and none of them changed the case, the claimant or the sign-in phone", (await snapshot(A)) === before);

    // ── the owner's edit lands in the database ──────────────────────────────
    const saved = await saveCase(A.token, A.submissionId, EDIT);
    const savedBody = await json(saved);
    record("the owner's edit is saved", saved.status === 200);
    const { data: claimantAfter } = await supabase
      .from("claimants")
      .select("first_name, last_name, mobile, email")
      .eq("id", A.claimantId)
      .single();
    const { data: accidentAfter } = await supabase
      .from("accidents")
      .select("incident_type, incident_date, incident_location, role, injuries, incident_place_id, incident_lat")
      .eq("submission_id", A.submissionId)
      .single();
    const { data: submissionAfter } = await supabase
      .from("intake_submissions")
      .select("status, treatment_area, treatment_area_postal_code")
      .eq("id", A.submissionId)
      .single();
    record(
      "the name is stored on the claimant",
      claimantAfter?.first_name === "Mariana" && claimantAfter.last_name === "Ortega-Ruiz"
    );
    record(
      "email and phone are untouched by a successful save",
      claimantAfter?.mobile === A.phone && claimantAfter.email === A.email
    );
    record(
      "the accident is stored",
      accidentAfter?.incident_type === "motorcycle" &&
        accidentAfter.incident_date === "2026-09-01" &&
        accidentAfter.incident_location === "Orlando, FL, USA" &&
        accidentAfter.role === "passenger" &&
        accidentAfter.incident_place_id === EDIT.accident.incidentLocationDetails.placeId &&
        Number(accidentAfter.incident_lat) === EDIT.accident.incidentLocationDetails.latitude
    );
    record("the injuries are stored", accidentAfter?.injuries === "head,shoulder");
    record(
      "the treatment area is stored with its details",
      submissionAfter?.treatment_area === "Orlando, FL 32801" && submissionAfter.treatment_area_postal_code === "32801"
    );
    record("saving does not move the case on", submissionAfter?.status === "submitted");
    record(
      "the response is the updated summary",
      savedBody.firstName === "Mariana" &&
        savedBody.incidentType === "motorcycle" &&
        (savedBody.incidentLocationDetails as { placeId?: string } | null)?.placeId ===
          EDIT.accident.incidentLocationDetails.placeId &&
        savedBody.phone === A.phone
    );
    const reread = await json(await getCase(A.token, A.submissionId));
    record(
      "a fresh read shows the saved values",
      reread.lastName === "Ortega-Ruiz" &&
        reread.injuries === "head,shoulder" &&
        (reread.treatmentAreaLocationDetails as { postalCode?: string } | null)?.postalCode === "32801"
    );
    const partial = await saveCase(A.token, A.submissionId, { injuries: "knee" });
    const { data: afterPartial } = await supabase
      .from("accidents")
      .select("injuries, incident_type")
      .eq("submission_id", A.submissionId)
      .single();
    record(
      "a single-section save changes only that section",
      partial.status === 200 && afterPartial?.injuries === "knee" && afterPartial.incident_type === "motorcycle"
    );
    record("B's case was never touched", (await json(await getCase(B.token, B.submissionId))).firstName === "PatientB");

    // ── who was with you: add, edit and remove through Save ─────────────────
    const companionRows = async (patient: Patient) =>
      (
        await supabase
          .from("submission_companions")
          .select("id, first_name, relation, cell_number, email")
          .eq("submission_id", patient.submissionId)
          .order("created_at", { ascending: true })
      ).data ?? [];
    const lena = (await companionRows(A))[0]!;
    const bCompanion = (await companionRows(B))[0]!;
    const twoPeople = await saveCase(A.token, A.submissionId, {
      companions: [
        {
          id: lena.id,
          firstName: "Lena",
          lastName: TEST_MARKER,
          relation: "passenger",
          cellNumber: "4075550101",
          email: "lena@example.test",
        },
        { firstName: "Omar", lastName: TEST_MARKER, relation: "driver", cellNumber: "(407) 555-0102" },
      ],
    });
    const afterTwo = await companionRows(A);
    const omar = afterTwo.find((row) => row.first_name === "Omar");
    record(
      "a kept companion is edited in place and a new one is added",
      twoPeople.status === 200 &&
        afterTwo.length === 2 &&
        afterTwo.some(
          (row) =>
            row.id === lena.id &&
            row.relation === "passenger" &&
            row.cell_number === "(407) 555-0101" &&
            row.email === "lena@example.test"
        ) &&
        omar?.cell_number === "(407) 555-0102" &&
        omar.email === null
    );
    record("…and the response lists both", ((await json(twoPeople)).companions as unknown[] | undefined)?.length === 2);
    const removedOne = await saveCase(A.token, A.submissionId, {
      companions: [
        { id: omar?.id, firstName: "Omar", lastName: TEST_MARKER, relation: "driver", cellNumber: "4075550102" },
      ],
    });
    const afterRemove = await companionRows(A);
    record(
      "a companion left out of the list is removed",
      removedOne.status === 200 && afterRemove.length === 1 && afterRemove[0]?.id === omar?.id
    );
    const intakeStyle = await saveCase(A.token, A.submissionId, {
      companions: [
        { id: omar?.id, firstName: "Omar", lastName: TEST_MARKER, relation: "driver", cellNumber: "4075550102" },
        { firstName: "2nd", lastName: "Bro", relation: "driver", cellNumber: "1111111111" },
      ],
    });
    const afterIntakeStyle = await companionRows(A);
    record(
      'a companion named as the intake allows ("2nd Bro") is stored',
      intakeStyle.status === 200 &&
        afterIntakeStyle.length === 2 &&
        afterIntakeStyle.some((row) => row.first_name === "2nd" && row.cell_number === "(111) 111-1111")
    );
    const backToOmar = await saveCase(A.token, A.submissionId, {
      companions: [
        { id: omar?.id, firstName: "Omar", lastName: TEST_MARKER, relation: "driver", cellNumber: "4075550102" },
      ],
    });
    record("…and removed again", backToOmar.status === 200 && (await companionRows(A)).length === 1);

    const foreignCompanion = await saveCase(A.token, A.submissionId, {
      companions: [
        { id: bCompanion.id, firstName: "Lena", lastName: TEST_MARKER, relation: "other", cellNumber: "4075550103" },
      ],
    });
    record(
      "another case's companion id is refused (400 invalid_companions) and nothing changes on either case",
      foreignCompanion.status === 400 &&
        (await json(foreignCompanion)).error === "invalid_companions" &&
        JSON.stringify(await companionRows(A)) === JSON.stringify(afterRemove) &&
        (await companionRows(B)).length === 1 &&
        (await companionRows(B))[0]?.first_name === "Lena"
    );

    // ── documents: register an upload, read it back, remove it ───────────────
    // a real 1×1 PNG, uploaded through the same signed-token route the screen uses
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const upload = async (patient: Patient, fileName: string) => {
      const minted = await json(
        await fetch(`${base}/intake/documents/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth(patient.token) },
          body: JSON.stringify({ submissionId: patient.submissionId, fileName, category: "insuranceCard" }),
        })
      );
      const storagePath = String(minted.storagePath ?? "");
      const { error } = await supabase.storage
        .from("submissions")
        .uploadToSignedUrl(storagePath, String(minted.token ?? ""), PNG, { contentType: "image/png" });
      assert(!error, `could not upload ${fileName}: ${error?.message}`);
      uploadedPaths.add(storagePath);
      return storagePath;
    };
    const fileFor = (storagePath: string) => ({
      storagePath,
      fileName: "card.png",
      mimeType: "image/png",
      fileSize: PNG.length,
      category: "insuranceCard",
    });
    const documentRows = async (patient: Patient) =>
      (await supabase.from("documents").select("id, storage_path").eq("submission_id", patient.submissionId)).data ??
      [];
    const objectExists = async (storagePath: string) => {
      const slash = storagePath.lastIndexOf("/");
      const { data } = await supabase.storage
        .from("submissions")
        .list(storagePath.slice(0, slash), { search: storagePath.slice(slash + 1) });
      return (data ?? []).some((object) => object.name === storagePath.slice(slash + 1));
    };

    const aPath = await upload(A, "card.png");
    const added = await saveCase(A.token, A.submissionId, { documents: { add: [fileFor(aPath)] } });
    const aDocs = await documentRows(A);
    const aDocument = aDocs.find((row) => row.storage_path === aPath);
    record(
      "an uploaded file is recorded on the case by Save, and the summary lists it",
      added.status === 200 &&
        aDocs.length === 1 &&
        Boolean(aDocument) &&
        ((await json(added)).documents as { id: string }[] | undefined)?.[0]?.id === aDocument?.id
    );
    const served = await fetch(`${base}/case/${A.submissionId}/documents/${aDocument?.id}`, { headers: auth(A.token) });
    const servedBytes = Buffer.from(await served.arrayBuffer());
    record(
      "the owner reads the file back for its thumbnail: the same bytes, served as an image, never cached",
      served.status === 200 &&
        served.headers.get("content-type") === "image/png" &&
        served.headers.get("cache-control") === "private, no-store" &&
        served.headers.get("x-content-type-options") === "nosniff" &&
        servedBytes.equals(PNG)
    );
    record(
      "the other patient cannot read it (404), nor can no session (401), nor an unknown id (404)",
      (await fetch(`${base}/case/${A.submissionId}/documents/${aDocument?.id}`, { headers: auth(B.token) })).status ===
        404 &&
        (await fetch(`${base}/case/${A.submissionId}/documents/${aDocument?.id}`)).status === 401 &&
        (
          await fetch(`${base}/case/${A.submissionId}/documents/00000000-0000-4000-8000-000000000000`, {
            headers: auth(A.token),
          })
        ).status === 404
    );
    record(
      "…and B cannot read it through B's own case either",
      (await fetch(`${base}/case/${B.submissionId}/documents/${aDocument?.id}`, { headers: auth(B.token) })).status ===
        404
    );

    const bPath = await upload(B, "b-card.png");
    const documentRefusals: [string, unknown][] = [
      ["a file in another case's folder", { add: [fileFor(bPath)] }],
      ["a file that was never uploaded", { add: [fileFor(`${A.submissionId}/insuranceCard/ghost-12345678.png`)] }],
      ["a path that climbs out of the case", { add: [fileFor(`${A.submissionId}/../${B.submissionId}/x.png`)] }],
      ["the same file recorded twice", { add: [fileFor(aPath)] }],
    ];
    for (const [label, documents] of documentRefusals) {
      const response = await saveCase(A.token, A.submissionId, { documents });
      record(
        `${label} is refused (400 invalid_documents) and records nothing`,
        response.status === 400 &&
          (await json(response)).error === "invalid_documents" &&
          (await documentRows(A)).length === 1
      );
    }
    const bDocAdded = await saveCase(B.token, B.submissionId, { documents: { add: [fileFor(bPath)] } });
    const bDocument = (await documentRows(B))[0];
    const foreignRemoval = await saveCase(A.token, A.submissionId, { documents: { remove: [bDocument?.id] } });
    record(
      "removing another case's document is refused (400) and both stay, with their files",
      bDocAdded.status === 200 &&
        foreignRemoval.status === 400 &&
        (await documentRows(B)).length === 1 &&
        (await objectExists(bPath)) &&
        (await documentRows(A)).length === 1
    );
    const removed = await saveCase(A.token, A.submissionId, { documents: { remove: [aDocument?.id] } });
    record(
      "removing the owner's document deletes its row and its stored file",
      removed.status === 200 && (await documentRows(A)).length === 0 && !(await objectExists(aPath))
    );
    record(
      "…and it can no longer be read",
      (await fetch(`${base}/case/${A.submissionId}/documents/${aDocument?.id}`, { headers: auth(A.token) })).status ===
        404
    );

    // ── every stage of a submitted case is editable, and saving never moves it ──
    for (const status of ["retainer_pending_signature", "signed", "attorney", "qualified", "not_qualified", "doctor"]) {
      await setStatus(B, status);
      const read = await json(await getCase(B.token, B.submissionId));
      const nameOnly = await saveCase(B.token, B.submissionId, {
        claimant: { firstName: `B${status.replace(/[^a-z]/g, "")}`, lastName: TEST_MARKER },
      });
      const treatment = await saveCase(B.token, B.submissionId, { treatmentArea: `Tampa, FL ${status.length}` });
      const { data: after } = await supabase
        .from("intake_submissions")
        .select("status, treatment_area")
        .eq("id", B.submissionId)
        .single();
      const { data: claimantAfter } = await supabase
        .from("claimants")
        .select("first_name, mobile, email")
        .eq("id", B.claimantId)
        .single();
      record(
        `${status}: reported editable, a name-only and a treatment-area save both land, and the status stays ${status}`,
        read.editable === true &&
          nameOnly.status === 200 &&
          treatment.status === 200 &&
          after?.status === status &&
          after.treatment_area === `Tampa, FL ${status.length}` &&
          claimantAfter?.first_name === `B${status.replace(/[^a-z]/g, "")}` &&
          claimantAfter.mobile === B.phone &&
          claimantAfter.email === B.email
      );
      const forged = await saveCase(B.token, B.submissionId, { email: "attacker@example.test" });
      record(
        `${status}: email is still refused`,
        forged.status === 400 && (await json(forged)).error === "field_not_editable"
      );
    }

    // ── an intake that was never submitted is not edited here ───────────────
    await setStatus(B, "intake");
    const intakeBefore = await snapshot(B);
    const intakeRead = await json(await getCase(B.token, B.submissionId));
    const intakeSave = await saveCase(B.token, B.submissionId, EDIT);
    const lateFile = await upload(B, "late.png");
    const intakeDocuments = await saveCase(B.token, B.submissionId, { documents: { add: [fileFor(lateFile)] } });
    record(
      "…and refuses document and companion changes the same way",
      intakeDocuments.status === 409 &&
        (await saveCase(B.token, B.submissionId, { companions: [] })).status === 409 &&
        (await documentRows(B)).length === 1 &&
        (await companionRows(B)).length === 1
    );
    record(
      "an unsubmitted intake is reported not editable, answered 409 case_locked, nothing written",
      intakeRead.editable === false &&
        intakeSave.status === 409 &&
        (await json(intakeSave)).error === "case_locked" &&
        (await snapshot(B)) === intakeBefore
    );
    await setStatus(B, "submitted");
  } finally {
    server.close();
    if (uploadedPaths.size > 0) await supabase.storage.from("submissions").remove([...uploadedPaths]);

    for (const phone of phones) {
      const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
      if (claimant) await supabase.from("claimants").delete().eq("id", claimant.id);
      const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const user of users.users ?? []) {
        if (user.phone === phone.replace("+", "")) await supabase.auth.admin.deleteUser(user.id);
      }
    }
    const { data: marked } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    const { data: renamed } = await supabase.from("claimants").select("id").eq("last_name", "Ortega-Ruiz");
    record(
      "every record created by this test was removed",
      (marked ?? []).length === 0 && (renamed ?? []).length === 0
    );
  }

  console.log("Case summary route:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  assert(failed.length === 0, `${failed.length} case summary route check(s) failed`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
