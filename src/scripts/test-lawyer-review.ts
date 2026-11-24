import "dotenv/config";
import { strict as assert } from "assert";
import { createHash, randomBytes, randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// The lawyer case review, end to end: the real endpoints, the real database and
// real storage. A lawyer's review link must show enough to judge a case — what
// happened, when and where, and the files, which open while the link is open —
// and nothing that identifies or reaches the patient until the lawyer has
// accepted. That has to hold for every state an assignment can be in, for a
// caller who edits the request, for a lawyer holding another case's link, and
// for the other portal routes a signed-in account could try instead.
//
// Every patient row carries TEST_MARKER as its last name and every other
// account carries it in its metadata, so a run that dies half way is swept by
// the next one.

const TEST_MARKER = "LawyerReviewSuite";
const INCIDENT_DATE = "2025-11-17";

// Real objects behind every document: a 1×1 PNG, a one-line PDF, the start of
// a HEIC file, and HTML — the last uploaded under a .pdf name to stand for a
// patient-controlled file whose declared type cannot be trusted.
// Each case's PDF is its own, so a file served from the wrong case cannot pass as the right one.
const pdfFor = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% INSURANCE CARD TEST ${label}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1"
  );
const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypheic\u0000\u0000\u0000\u0000mif1heic", "latin1"),
]);
const HTML = Buffer.from("<html><body><script>document.title='x'</script>not a pdf</body></html>", "utf8");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

type Json = Record<string, unknown>;

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) {
    throw new Error("TEST_SUPABASE_PROJECT_REF is required.");
  }
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

  // A signed retainer hands its case to a lawyer by itself, and the lawyer's
  // review link reaches them only in the lawyer notification. Twilio is stubbed
  // to a fictional +1555 lawyer so the suite reads the link the lawyer is sent;
  // nothing leaves the machine and the admin list stays empty.
  process.env.TWILIO_ACCOUNT_SID = `AC${randomBytes(16).toString("hex")}`;
  process.env.TWILIO_AUTH_TOKEN = randomBytes(16).toString("hex");
  process.env.TWILIO_FROM_NUMBER = "+15550109999";
  process.env.INTAKE_ADMIN_NOTIFICATION_TO = "";
  process.env.INTAKE_LAWYER_NOTIFICATION_TO = "+15550100031";
  const lawyerMessages: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.twilio.com/")) return realFetch(input, init);
    lawyerMessages.push(new URLSearchParams(String(init?.body ?? "")).get("Body") ?? "");
    return new Response(JSON.stringify({ sid: `SM${randomBytes(16).toString("hex")}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const { calculateReviewDecisionExpiry } = await import("../lib/review-expiry");
  const { AUTOMATIC_HANDOFF_ACTOR_ID } = await import("../lib/lawyer-handoff");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const read = async (response: Response): Promise<{ status: number; body: Json; text: string }> => {
    const text = await response.text();
    let body: Json = {};
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = {};
    }
    return { status: response.status, body, text };
  };
  const post = async (path: string, payload: unknown, token?: string) =>
    read(
      await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      })
    );
  const get = async (path: string, token?: string) =>
    read(await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));

  const newPhone = () => `+1555${randomInt(1_000_000, 9_999_999)}`;

  const login = async (phone: string): Promise<string> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (response.ok) return ((await response.json()) as { accessToken: string }).accessToken;
      if (response.status !== 502 || attempt === 4) throw new Error(`login failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  const removeStorage = async (submissionId: string) => {
    const { data: folders } = await supabase.storage.from("submissions").list(submissionId, { limit: 100 });
    for (const folder of folders ?? []) {
      const { data: files } = await supabase.storage.from("submissions").list(`${submissionId}/${folder.name}`, {
        limit: 100,
      });
      for (const file of files ?? []) {
        await supabase.storage.from("submissions").remove([`${submissionId}/${folder.name}/${file.name}`]);
      }
    }
  };

  const markedAccounts = async (): Promise<string[]> => {
    const ids: string[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers failed: ${error.message}`);
      for (const user of data.users) {
        if ((user.user_metadata as Json | undefined)?.suite === TEST_MARKER) ids.push(user.id);
      }
      if (data.users.length < 200) break;
    }
    return ids;
  };

  /** Only rows and accounts carrying this suite's marker; nothing else in the project is touched. */
  const sweep = async (): Promise<number> => {
    let removed = 0;
    const { data: claimants } = await supabase.from("claimants").select("id, user_id").eq("last_name", TEST_MARKER);
    for (const claimant of claimants ?? []) {
      const { data: submissions } = await supabase
        .from("intake_submissions")
        .select("id")
        .eq("claimant_id", claimant.id);
      for (const submission of submissions ?? []) await removeStorage(submission.id);
      // auth.users → claimants → intake_submissions → everything else cascades.
      if (claimant.user_id) await supabase.auth.admin.deleteUser(claimant.user_id);
      await supabase.from("claimants").delete().eq("id", claimant.id);
      removed += 1;
    }
    for (const userId of await markedAccounts()) {
      await supabase.from("admin_users").delete().eq("user_id", userId);
      await supabase.auth.admin.deleteUser(userId);
      removed += 1;
    }
    return removed;
  };

  const strandedBefore = await sweep();
  if (strandedBefore > 0) console.log(`  (cleared ${strandedBefore} record(s) stranded by an earlier run)\n`);

  /** A signed-in account that is not a patient: an admin, or a lawyer who made an account. */
  const markedAccount = async (): Promise<{ userId: string; token: string }> => {
    const phone = newPhone();
    const { data, error } = await supabase.auth.admin.createUser({
      phone,
      phone_confirm: true,
      user_metadata: { suite: TEST_MARKER },
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    return { userId: data.user.id, token: await login(phone) };
  };

  type Case = {
    label: string;
    userId: string;
    submissionId: string;
    patientToken: string;
    location: string;
    protectedValues: string[];
    photoPath: string;
    files: {
      fileName: string;
      storagePath: string;
      bytes: Buffer;
      storedType: string;
      claimedType: string;
      category: string;
      expectedKind: "image" | "pdf" | "file";
    }[];
  };

  /** A submitted case with every protected field filled, a companion and a real photo. */
  const makeCase = async (label: string): Promise<Case> => {
    const phone = newPhone();
    const patientToken = await login(phone);
    const email = `${label.toLowerCase()}.${randomUUID().slice(0, 6)}@example.com`;
    // Shown before acceptance, so it must not carry anything that identifies the patient.
    const location = `${randomInt(1000, 9999)} Lamar Blvd & W 38th St, Austin, TX`;
    const started = await post(
      "/intake/start",
      {
        locale: "en",
        claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone, email },
        accident: { incidentType: "car", incidentLocation: location, incidentDate: INCIDENT_DATE },
      },
      patientToken
    );
    const submissionId = String(started.body.submissionId ?? "");
    const { data: userData } = await supabase.auth.getUser(patientToken);
    const userId = userData.user?.id ?? "";

    const suffix = randomUUID().slice(0, 8);
    const specs: Omit<Case["files"][number], "storagePath">[] = [
      {
        fileName: `${label}-license.png`,
        category: "driversLicense",
        bytes: PNG,
        storedType: "image/png",
        claimedType: "image/png",
        expectedKind: "image",
      },
      {
        fileName: `${label}-insurance-card.pdf`,
        category: "insuranceCard",
        bytes: pdfFor(label),
        storedType: "application/pdf",
        claimedType: "application/pdf",
        expectedKind: "pdf",
      },
      {
        fileName: `${label}-IMG_2232.HEIC`,
        category: "incidentPhotos",
        bytes: HEIC,
        storedType: "image/heic",
        claimedType: "image/heic",
        expectedKind: "file",
      },
      {
        fileName: `${label}-statement.pdf`,
        category: "accidentReport",
        bytes: HTML,
        storedType: "text/html",
        claimedType: "application/pdf",
        expectedKind: "file",
      },
    ];
    const files: Case["files"] = specs.map((file) => ({
      ...file,
      storagePath: `${submissionId}/${file.category}/${suffix}-${file.fileName}`,
    }));
    for (const file of files) {
      const upload = await supabase.storage
        .from("submissions")
        .upload(file.storagePath, file.bytes, { contentType: file.storedType });
      if (upload.error) throw new Error(`document upload failed: ${upload.error.message}`);
    }
    const photoPath = files[0]!.storagePath;

    const residence = `${label} Residence Rd, Austin, TX 78751`;
    const treatmentArea = `${label} Treatment Area, Round Rock, TX`;
    const companionFirst = `${label}Companion`;
    const companionCell = `+1512${randomInt(1_000_000, 9_999_999)}`;
    const companionEmail = `${label.toLowerCase()}.companion@example.com`;
    const completed = await post(
      "/intake/complete",
      {
        submissionId,
        claimant: { residence },
        accident: {
          incidentType: "car",
          incidentDate: INCIDENT_DATE,
          incidentLocation: location,
          role: "driver",
          description: `The other driver ran the light and hit my door. Reach me on ${phone} or ${email}.`,
          injuries: "headNeck,back",
        },
        treatmentArea,
        documents: files.map((file) => ({
          fileName: file.fileName,
          storagePath: file.storagePath,
          mimeType: file.claimedType,
          fileSize: file.bytes.length,
          category: file.category,
        })),
        companions: [
          {
            firstName: companionFirst,
            lastName: TEST_MARKER,
            relation: "passenger",
            cellNumber: companionCell,
            email: companionEmail,
          },
        ],
      },
      patientToken
    );
    if (started.status >= 300 || completed.status >= 300 || !userId) {
      throw new Error(`case setup failed: start ${started.status}, complete ${completed.status}`);
    }

    return {
      label,
      userId,
      submissionId,
      patientToken,
      location,
      photoPath,
      files,
      // Who the patient is and how to reach them, and what the files are called
      // and where they are kept. The accident's date and place are not here: a
      // pending lawyer is shown them.
      protectedValues: [
        label,
        TEST_MARKER,
        phone,
        phone.slice(-7),
        email,
        residence,
        treatmentArea,
        companionFirst,
        companionCell,
        companionEmail,
        ...files.flatMap((file) => [file.fileName, file.storagePath]),
        "INSURANCE CARD TEST",
        "/storage/v1/",
      ],
    };
  };

  const leaks = (text: string, kase: Case) => kase.protectedValues.filter((value) => text.includes(value));

  const assignmentFor = async (submissionId: string, status?: string) => {
    let query = supabase
      .from("review_assignments")
      .select("id, status, accepted_at, rejected_at, revoked_at, expires_at, decision_expires_at")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data } = await query.limit(1).maybeSingle();
    return data as Json | null;
  };

  try {
    const admin = await markedAccount();
    const { error: adminError } = await supabase.from("admin_users").insert({ user_id: admin.userId });
    if (adminError) throw new Error(`admin_users insert failed: ${adminError.message}`);
    const lawyerAccount = await markedAccount();

    const caseA = await makeCase("Quenby");
    const caseB = await makeCase("Ravindra");
    const caseC = await makeCase("Solveig");
    const caseD = await makeCase("Tancredi");

    // A case reaches a lawyer only once it is signed: the admin approves it for
    // the retainer, the patient signs, and reading the completed agreement moves
    // it to signed. A completed agreement row stands in for the DocuSign
    // ceremony, which the agreement suites cover.
    const signRetainer = async (kase: Case) => {
      const approved = await post(
        "/portal/review-decision",
        { claimantUserId: kase.userId, submissionId: kase.submissionId, action: "approve_for_retainer" },
        admin.token
      );
      if (approved.status !== 200) throw new Error(`approve_for_retainer failed: ${approved.status}`);
      const { error: agreementError } = await supabase.from("agreements").insert({
        submission_id: kase.submissionId,
        envelope_id: `lawyer-review-${randomUUID()}`,
        status: "completed",
        locale: "en",
        signed_document_path: `${kase.submissionId}/lawyer-review-fixture.pdf`,
        completed_at: new Date().toISOString(),
      });
      if (agreementError) throw new Error(`agreement fixture failed: ${agreementError.message}`);
      const settled = await get(`/intake/agreement/${kase.submissionId}`, kase.patientToken);
      if (settled.body.status !== "completed") throw new Error(`agreement read failed: ${settled.status}`);
    };

    // A submitted case reaches a lawyer by being signed: the handoff follows the
    // completed retainer, and the token is the one in the lawyer's notification.
    // A case already 'signed' — as one is put back below — is handed on by the
    // admin's pass_to_lawyer, whose response carries the link.
    const linkInLawyerMessage = async (submissionId: string): Promise<string> => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const message = lawyerMessages.find((body) => body.includes(`submissionId=${submissionId}`));
        if (message) return message.match(/https?:\/\/\S+\/review\/\S+/)?.[0] ?? "";
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return "";
    };
    const passToLawyer = async (kase: Case) => {
      const { data: current } = await supabase
        .from("intake_submissions")
        .select("status")
        .eq("id", kase.submissionId)
        .maybeSingle();
      if (current?.status === "submitted") {
        await signRetainer(kase);
        const link = await linkInLawyerMessage(kase.submissionId);
        const { data: handedOn } = await supabase
          .from("intake_submissions")
          .select("status")
          .eq("id", kase.submissionId)
          .maybeSingle();
        return {
          passed: handedOn?.status === "attorney" && Boolean(link),
          token: new URL(link || "http://invalid/").searchParams.get("t") ?? "",
        };
      }
      const response = await post(
        "/portal/review-decision",
        { claimantUserId: kase.userId, submissionId: kase.submissionId, action: "pass_to_lawyer" },
        admin.token
      );
      const link = String(response.body.reviewLink ?? "");
      return { passed: response.status === 200, token: new URL(link || "http://invalid/").searchParams.get("t") ?? "" };
    };
    const reviewCase = (kase: Case, token: string, extra: Json = {}) =>
      post("/portal/review-case", { claimantUserId: kase.userId, submissionId: kase.submissionId, token, ...extra });
    const decide = (kase: Case, token: string, action: string, extra: Json = {}) =>
      post("/portal/review-decision-link", {
        claimantUserId: kase.userId,
        submissionId: kase.submissionId,
        token,
        action,
        ...extra,
      });

    type Served = {
      status: number;
      type: string;
      disposition: string;
      nosniff: boolean;
      noStore: boolean;
      bytes: Buffer;
      body: Json;
    };
    const openDocument = async (payload: Json): Promise<Served> => {
      const response = await fetch(`${base}/portal/review-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      let body: Json = {};
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          body = JSON.parse(bytes.toString("utf8")) as Json;
        } catch {
          body = {};
        }
      }
      return {
        status: response.status,
        type: response.headers.get("content-type") ?? "",
        disposition: response.headers.get("content-disposition") ?? "",
        nosniff: response.headers.get("x-content-type-options") === "nosniff",
        noStore: /no-store/.test(response.headers.get("cache-control") ?? ""),
        bytes,
        body,
      };
    };
    const openFile = (kase: Case, token: string, documentId: string, extra: Json = {}) =>
      openDocument({ claimantUserId: kase.userId, submissionId: kase.submissionId, token, documentId, ...extra });
    const documentIds = async (kase: Case) => {
      const { data } = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("submission_id", kase.submissionId);
      return new Map((data ?? []).map((row) => [String(row.storage_path), String(row.id)]));
    };
    const useCount = async (submissionId: string) => {
      const { data } = await supabase
        .from("review_assignments")
        .select("token_use_count")
        .eq("submission_id", submissionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return Number((data as Json | null)?.token_use_count ?? -1);
    };

    // ── only an admin can pass a case on, or list every patient ───────────────
    const refusedMint = await post(
      "/portal/review-decision",
      { claimantUserId: caseA.userId, submissionId: caseA.submissionId, action: "pass_to_lawyer" },
      lawyerAccount.token
    );
    record(
      "a signed-in lawyer account cannot mint a review link (403)",
      refusedMint.status === 403 && !refusedMint.text.includes("reviewLink")
    );
    const patientMint = await post(
      "/portal/review-decision",
      { claimantUserId: caseB.userId, submissionId: caseB.submissionId, action: "pass_to_lawyer" },
      caseA.patientToken
    );
    record("a patient cannot mint a review link (403)", patientMint.status === 403);
    record("nobody can without a session (401)", (await post("/portal/review-decision", {})).status === 401);

    const lawyerList = await get("/portal/submissions", lawyerAccount.token);
    record(
      "a signed-in lawyer account cannot list every patient (403, no names)",
      lawyerList.status === 403 && leaks(lawyerList.text, caseA).length === 0
    );
    record(
      "a patient cannot list every patient (403)",
      (await get("/portal/submissions", caseA.patientToken)).status === 403
    );
    const adminList = await get("/portal/submissions", admin.token);
    record("an admin still lists submissions", adminList.status === 200 && adminList.text.includes(caseA.submissionId));

    const lawyerCaseRead = await get(`/case/${caseA.submissionId}`, lawyerAccount.token);
    record(
      "the patient's own case route refuses a lawyer's session",
      lawyerCaseRead.status === 404 && leaks(lawyerCaseRead.text, caseA).length === 0
    );

    const passedAt = new Date();
    const passA = await passToLawyer(caseA);
    record(
      "signing the retainer passes the case to a lawyer, whose notification carries the review link",
      passA.passed && passA.token.length > 20
    );
    const passB = await passToLawyer(caseB);
    const passC = await passToLawyer(caseC);
    const passD = await passToLawyer(caseD);

    // ── the link opens ───────────────────────────────────────────────────────
    const verifiedA = await post("/portal/review-access/verify", {
      claimantUserId: caseA.userId,
      submissionId: caseA.submissionId,
      token: passA.token,
    });
    record(
      "the review link still opens (verify 200, can decide)",
      verifiedA.status === 200 && verifiedA.body.canDecide === true
    );

    // ── pending: the case and its files, never the patient ──────────────────
    const pendingA = await reviewCase(caseA, passA.token);
    const pendingFacts = (pendingA.body.caseFacts ?? {}) as Json;
    const pendingIncident = (pendingA.body.incident ?? {}) as Json;
    const pendingDocuments = (pendingA.body.documents ?? []) as Json[];
    record("a pending review answers masked", pendingA.status === 200 && pendingA.body.access === "masked");
    record(
      `a pending review carries none of the patient's protected values (${leaks(pendingA.text, caseA).join(", ") || "none"})`,
      leaks(pendingA.text, caseA).length === 0
    );
    record(
      "a pending review has no patient and no companions",
      pendingA.body.patient === null && pendingA.body.companions === null
    );
    record(
      "a pending review shows the accident's date and place",
      pendingIncident.date === INCIDENT_DATE && pendingIncident.location === caseA.location
    );
    record(
      "a pending review keeps the case facts",
      pendingFacts.incidentType === "car" &&
        pendingFacts.role === "driver" &&
        pendingFacts.injuries === "headNeck,back" &&
        typeof pendingFacts.story === "string" &&
        (pendingFacts.story as string).startsWith("The other driver ran the light and hit my door. Reach me on •••")
    );
    record(
      "a pending review counts the documents and names who was there by relation only",
      JSON.stringify(pendingFacts.documentCounts) ===
        JSON.stringify([
          { category: "accidentReport", count: 1 },
          { category: "driversLicense", count: 1 },
          { category: "incidentPhotos", count: 1 },
          { category: "insuranceCard", count: 1 },
        ]) && JSON.stringify(pendingFacts.companionRelations) === JSON.stringify(["passenger"])
    );
    const idsA = await documentIds(caseA);
    record(
      "a pending review lists every file by id and kind — no name, no URL, no path",
      pendingDocuments.length === 4 &&
        pendingDocuments.every(
          (document) =>
            document.fileName === null &&
            document.available === true &&
            !("url" in document) &&
            [...idsA.values()].includes(String(document.id))
        ) &&
        JSON.stringify(pendingDocuments.map((document) => document.kind).sort()) ===
          JSON.stringify(["file", "file", "image", "pdf"])
    );
    const pendingReview = (pendingA.body.review ?? {}) as Json;
    // The deadline is the decision window (lib/review-expiry.ts): 30 minutes in
    // business hours, the next business morning after them — not the link's 14 days.
    const deadlineA = Date.parse(String(pendingReview.responseDeadline ?? ""));
    record(
      "a pending review can decide and carries the server's deadline",
      pendingReview.status === "pending" &&
        pendingReview.canDecide === true &&
        deadlineA >= calculateReviewDecisionExpiry(passedAt).getTime() - 1000 &&
        deadlineA <= calculateReviewDecisionExpiry(new Date()).getTime()
    );

    // ── pending: every file opens, under a neutral name ─────────────────────
    const usesBefore = await useCount(caseA.submissionId);
    const pendingFiles: { file: Case["files"][number]; served: Served }[] = [];
    for (const file of caseA.files) {
      pendingFiles.push({ file, served: await openFile(caseA, passA.token, idsA.get(file.storagePath) ?? "") });
    }
    const pendingOf = (storedType: string) => pendingFiles.find((entry) => entry.file.storedType === storedType);
    const pImage = pendingOf("image/png");
    const pPdf = pendingOf("application/pdf");
    const pHeic = pendingOf("image/heic");
    const pHtml = pendingOf("text/html");
    record(
      "pending: the image opens inline as an image, byte-identical",
      pImage?.served.status === 200 &&
        pImage.served.type === "image/png" &&
        pImage.served.disposition.startsWith("inline;") &&
        pImage.served.bytes.equals(pImage.file.bytes)
    );
    record(
      "pending: the PDF opens inline in the browser's viewer, byte-identical",
      pPdf?.served.status === 200 &&
        pPdf.served.type === "application/pdf" &&
        pPdf.served.disposition.startsWith("inline;") &&
        pPdf.served.bytes.equals(pPdf.file.bytes)
    );
    record(
      "pending: a HEIC photo is an opaque download, byte-identical",
      pHeic?.served.status === 200 &&
        pHeic.served.type === "application/octet-stream" &&
        pHeic.served.disposition.startsWith("attachment;") &&
        pHeic.served.bytes.equals(pHeic.file.bytes)
    );
    record(
      "pending: HTML stored under a .pdf name is only ever an opaque download",
      pHtml?.served.status === 200 &&
        pHtml.served.type === "application/octet-stream" &&
        pHtml.served.disposition.startsWith("attachment;") &&
        pHtml.served.bytes.equals(pHtml.file.bytes)
    );
    record(
      "pending: every file is offered under a neutral name, never the patient's",
      pendingFiles.every(
        ({ file, served }) =>
          /filename="(drivers-license|insurance-card|incident-photo|accident-report)-[0-9a-f]{8}\.[a-z0-9]{1,8}"/.test(
            served.disposition
          ) &&
          !served.disposition.includes(caseA.label) &&
          !served.disposition.includes(TEST_MARKER) &&
          !served.disposition.includes(file.fileName)
      )
    );
    record(
      "pending: files are sent nosniff and are never cached",
      pendingFiles.every(({ served }) => served.nosniff && served.noStore)
    );
    record("opening files does not use up the link", (await useCount(caseA.submissionId)) === usesBefore);

    // A row of this case pointing at another case's file — as a corrupted or
    // forged row would — and one whose object Storage does not hold: both are
    // listed as not openable, and the other case's path appears nowhere.
    const { data: forgedRows } = await supabase
      .from("documents")
      .insert([
        {
          submission_id: caseA.submissionId,
          storage_path: caseB.files[0]!.storagePath,
          file_name: "forged-cross-case.png",
          mime_type: "image/png",
          file_size: 10,
          category: "driversLicense",
        },
        {
          submission_id: caseA.submissionId,
          storage_path: `${caseA.submissionId}/incidentPhotos/never-uploaded.png`,
          file_name: "never-uploaded.png",
          mime_type: "image/png",
          file_size: 10,
          category: "incidentPhotos",
        },
      ])
      .select("id, storage_path");
    const forgedId = String(forgedRows?.find((row) => row.storage_path === caseB.files[0]!.storagePath)?.id ?? "");
    const missingId = String(forgedRows?.find((row) => row.storage_path !== caseB.files[0]!.storagePath)?.id ?? "");
    const withForged = await reviewCase(caseA, passA.token);
    const listed = (id: string) => ((withForged.body.documents ?? []) as Json[]).find((document) => document.id === id);
    record(
      "a row pointing at another case's file is listed as not openable, and that file's path appears nowhere",
      forgedId.length > 0 &&
        listed(forgedId)?.available === false &&
        !withForged.text.includes(caseB.files[0]!.storagePath)
    );
    record("a row whose file Storage does not hold is listed as not openable", listed(missingId)?.available === false);
    const forgedOpen = await openFile(caseA, passA.token, forgedId);
    record(
      "opening the row that points at another case's file is refused as not found, with none of its bytes",
      forgedOpen.status === 404 &&
        forgedOpen.body.error === "document_not_found" &&
        !forgedOpen.bytes.equals(caseB.files[0]!.bytes)
    );
    record(
      "opening a row with no file behind it is refused as not found",
      (await openFile(caseA, passA.token, missingId)).status === 404
    );
    if (forgedRows?.length) {
      await supabase
        .from("documents")
        .delete()
        .in(
          "id",
          forgedRows.map((row) => row.id)
        );
    }

    // ── direct calls and tampering ───────────────────────────────────────────
    const tampered = passA.token.slice(0, -4) + (passA.token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const tamperedCase = await reviewCase(caseA, tampered);
    record(
      "a tampered token is refused and carries no case",
      tamperedCase.status === 401 && tamperedCase.body.error === "invalid_token" && !("caseFacts" in tamperedCase.body)
    );
    record("no token at all is refused (400)", (await reviewCase(caseA, "")).status === 400);
    const storedHash = createHash("sha256").update(passA.token).digest("hex");
    record("the stored hash is not a token (401)", (await reviewCase(caseA, storedHash)).status === 401);
    const selfPromoted = await reviewCase(caseA, passA.token, {
      access: "full",
      status: "accepted",
      unlocked: true,
      canDecide: false,
      review: { status: "accepted" },
    });
    record(
      "fields the caller adds to the request unlock nothing",
      selfPromoted.body.access === "masked" && leaks(selfPromoted.text, caseA).length === 0
    );
    const queryPromoted = await read(
      await fetch(`${base}/portal/review-case?access=full&status=accepted`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimantUserId: caseA.userId, submissionId: caseA.submissionId, token: passA.token }),
      })
    );
    record(
      "query parameters unlock nothing",
      queryPromoted.body.access === "masked" && leaks(queryPromoted.text, caseA).length === 0
    );
    record(
      "a non-UUID id is refused before any query (400)",
      (
        await post("/portal/review-case", {
          claimantUserId: `${caseA.userId}' or '1'='1`,
          submissionId: caseA.submissionId,
          token: passA.token,
        })
      ).status === 400
    );
    record("the case is not readable by GET", (await get("/portal/review-case")).status === 404);

    // Files: only the document id comes from the caller, and it is looked up
    // within the link's own case.
    const idsB = await documentIds(caseB);
    const idsC = await documentIds(caseC);
    const pdfA = idsA.get(caseA.files[1]!.storagePath) ?? "";
    const pngB = idsB.get(caseB.files[0]!.storagePath) ?? "";
    const firstC = idsC.get(caseC.files[0]!.storagePath) ?? "";
    const foreign = await openFile(caseA, passA.token, pngB);
    record(
      "another case's document id is answered as not found, with none of its bytes",
      foreign.status === 404 &&
        foreign.body.error === "document_not_found" &&
        !foreign.bytes.equals(caseB.files[0]!.bytes)
    );
    record(
      "an unknown document id is answered the same way",
      (await openFile(caseA, passA.token, randomUUID())).status === 404
    );
    record(
      "a document id that is not a UUID is refused before any query (400)",
      (await openFile(caseA, passA.token, `${pdfA}' or '1'='1`)).status === 400 &&
        (await openFile(caseA, passA.token, "../../x")).status === 400
    );
    record("no document id at all is refused (400)", (await openFile(caseA, passA.token, "")).status === 400);
    const pathInBody = await openFile(caseA, passA.token, pdfA, {
      storagePath: caseB.files[1]!.storagePath,
      path: caseB.files[1]!.storagePath,
      objectPath: caseB.files[1]!.storagePath,
      bucket: "agreements",
    });
    record(
      "paths and buckets in the request are ignored: the case's own file comes back",
      pathInBody.status === 200 && pathInBody.bytes.equals(caseA.files[1]!.bytes)
    );
    record("a tampered token opens no file (401)", (await openFile(caseA, tampered, pdfA)).status === 401);
    record("a file request without a token is refused (400)", (await openFile(caseA, "", pdfA)).status === 400);
    record("files cannot be read by GET", (await get("/portal/review-document")).status === 404);

    // ── a lawyer holding another case's link ─────────────────────────────────
    const crossToken = await reviewCase(caseA, passC.token);
    record(
      "another case's link cannot open this case (401, nothing returned)",
      crossToken.status === 401 && leaks(crossToken.text, caseA).length === 0 && !("caseFacts" in crossToken.body)
    );
    const crossClaimant = await post("/portal/review-case", {
      claimantUserId: caseC.userId,
      submissionId: caseA.submissionId,
      token: passA.token,
    });
    record("this case's link with another patient's id is refused (401)", crossClaimant.status === 401);
    const crossSubmission = await post("/portal/review-case", {
      claimantUserId: caseA.userId,
      submissionId: caseC.submissionId,
      token: passA.token,
    });
    record(
      "this case's link cannot be pointed at another submission (401)",
      crossSubmission.status === 401 && leaks(crossSubmission.text, caseC).length === 0
    );
    record(
      "another case's link cannot open this case's files (401)",
      (await openFile(caseA, passC.token, pdfA)).status === 401
    );
    record(
      "this case's link with another patient's id opens no file (401)",
      (
        await openDocument({
          claimantUserId: caseC.userId,
          submissionId: caseA.submissionId,
          token: passA.token,
          documentId: pdfA,
        })
      ).status === 401
    );
    record(
      "this case's link pointed at another submission opens none of its files (401)",
      (
        await openDocument({
          claimantUserId: caseA.userId,
          submissionId: caseC.submissionId,
          token: passA.token,
          documentId: firstC,
        })
      ).status === 401
    );
    record(
      "this case's token with another case's own ids opens none of its files (401)",
      (
        await openDocument({
          claimantUserId: caseC.userId,
          submissionId: caseC.submissionId,
          token: passA.token,
          documentId: firstC,
        })
      ).status === 401
    );

    // ── decisions need the link's token ──────────────────────────────────────
    const assignmentA = await assignmentFor(caseA.submissionId);
    const oldContract = await post("/portal/review-decision-link", {
      claimantUserId: caseA.userId,
      submissionId: caseA.submissionId,
      assignmentId: assignmentA?.id,
      action: "accept_case",
    });
    record("a decision naming only the assignment id is refused (400)", oldContract.status === 400);
    const crossDecision = await decide(caseA, passC.token, "accept_case", { assignmentId: assignmentA?.id });
    const afterCross = await assignmentFor(caseA.submissionId);
    record(
      "another case's link cannot decide this case, whatever assignment id it names",
      crossDecision.status === 401 && afterCross?.status === "pending"
    );

    // ── accepted: unlocked ───────────────────────────────────────────────────
    const acceptA = await decide(caseA, passA.token, "accept_case");
    const acceptedRow = await assignmentFor(caseA.submissionId);
    record(
      "the lawyer accepts through the link (200, qualified)",
      acceptA.status === 200 && acceptA.body.status === "qualified"
    );
    record(
      "the acceptance is recorded on the assignment",
      acceptedRow?.status === "accepted" && typeof acceptedRow?.accepted_at === "string"
    );
    const { data: submissionA } = await supabase
      .from("intake_submissions")
      .select("status")
      .eq("id", caseA.submissionId)
      .maybeSingle();
    record("the case is marked qualified", submissionA?.status === "qualified");
    const { data: eventsA } = await supabase
      .from("review_decision_events")
      .select("action, actor_role, actor_user_id, assignment_id, metadata, next_status")
      .eq("submission_id", caseA.submissionId)
      .order("created_at", { ascending: true });
    record(
      "the audit log holds the approval (by the admin), the pass on signing (automatic) and the acceptance (by the link)",
      eventsA?.length === 3 &&
        eventsA[0]?.action === "approve_for_retainer" &&
        eventsA[0]?.actor_user_id === admin.userId &&
        eventsA[0]?.next_status === "retainer_pending_signature" &&
        eventsA[1]?.action === "pass_to_lawyer" &&
        eventsA[1]?.actor_user_id === AUTOMATIC_HANDOFF_ACTOR_ID &&
        (eventsA[1]?.metadata as Json | null)?.automatic === true &&
        eventsA[1]?.assignment_id === acceptedRow?.id &&
        eventsA[1]?.next_status === "attorney" &&
        eventsA[2]?.action === "accept_case" &&
        eventsA[2]?.actor_role === "lawyer" &&
        eventsA[2]?.assignment_id === acceptedRow?.id &&
        (eventsA[2]?.metadata as Json | null)?.source === "review_link"
    );
    record("a second decision is refused (409)", (await decide(caseA, passA.token, "reject_case")).status === 409);

    const fullA = await reviewCase(caseA, passA.token);
    const patientA = (fullA.body.patient ?? {}) as Json;
    const incidentA = (fullA.body.incident ?? {}) as Json;
    const companionsA = (fullA.body.companions ?? []) as Json[];
    const documentsA = (fullA.body.documents ?? []) as Json[];
    record("after acceptance the review answers full", fullA.status === 200 && fullA.body.access === "full");
    record(
      "after acceptance the patient's name, phone, email and address arrive",
      patientA.firstName === caseA.label &&
        patientA.lastName === TEST_MARKER &&
        patientA.mobile === caseA.protectedValues[2] &&
        patientA.email === caseA.protectedValues[4] &&
        patientA.residence === caseA.protectedValues[5]
    );
    record(
      "after acceptance the accident's date and place are still there",
      incidentA.date === INCIDENT_DATE && incidentA.location === caseA.location
    );
    record(
      "after acceptance the story is whole and the companion is named",
      String(((fullA.body.caseFacts ?? {}) as Json).story ?? "").includes(caseA.protectedValues[2] ?? "-") &&
        companionsA[0]?.firstName === `${caseA.label}Companion`
    );
    record(
      "after acceptance every file is listed under the patient's own name",
      caseA.files.every((file) =>
        documentsA.some((document) => document.fileName === file.fileName && document.available === true)
      )
    );
    const acceptedFiles: { file: Case["files"][number]; served: Served }[] = [];
    for (const file of caseA.files) {
      acceptedFiles.push({ file, served: await openFile(caseA, passA.token, idsA.get(file.storagePath) ?? "") });
    }
    const typeFor = (kind: string) =>
      kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "application/octet-stream";
    record(
      "after acceptance every file opens the way its stored type allows, byte-identical",
      acceptedFiles.every(
        ({ file, served }) =>
          served.status === 200 &&
          served.bytes.equals(file.bytes) &&
          served.type === typeFor(file.expectedKind) &&
          served.disposition.startsWith(file.expectedKind === "file" ? "attachment;" : "inline;")
      )
    );
    record(
      "after acceptance a file is offered under the patient's own name",
      acceptedFiles.every(({ file, served }) => served.disposition.includes(`filename="${file.fileName}"`))
    );
    record(
      "even after acceptance, no Storage URL or object path is in the review",
      !fullA.text.includes("/storage/v1/") &&
        !fullA.text.includes("storage_path") &&
        !fullA.text.includes("storagePath") &&
        caseA.files.every((file) => !fullA.text.includes(file.storagePath))
    );

    // Document ids and paths are not parameters of the case endpoint.
    const { data: caseBRows } = await supabase
      .from("documents")
      .select("id, storage_path")
      .eq("submission_id", caseB.submissionId);
    const probed = await reviewCase(caseA, passA.token, {
      documentId: caseBRows?.[0]?.id,
      documentIds: (caseBRows ?? []).map((row) => row.id),
      storagePath: caseBRows?.[0]?.storage_path,
      path: caseBRows?.[0]?.storage_path,
    });
    const ownIds = ((fullA.body.documents ?? []) as Json[])
      .map((document) => document.id)
      .sort()
      .join();
    const probedIds = ((probed.body.documents ?? []) as Json[])
      .map((document) => document.id)
      .sort()
      .join();
    record(
      "another case's document ids or paths in the request are ignored: only this case's own files come back",
      probed.status === 200 &&
        probedIds === ownIds &&
        // Only what is B's alone: the marker surname and the PDF's shared text
        // are the same for every case.
        caseB.protectedValues
          .filter((value) => !caseA.protectedValues.includes(value))
          .every((value) => !probed.text.includes(value))
    );
    const reopened = await post("/portal/review-access/verify", {
      claimantUserId: caseA.userId,
      submissionId: caseA.submissionId,
      token: passA.token,
    });
    record(
      "the accepted link still opens, without a decision to make",
      reopened.status === 200 && reopened.body.canDecide === false
    );

    // The strongest form of "another lawyer": a link that has accepted its own
    // case, presented with another case's correct ids. Its acceptance belongs
    // to its own submission and opens nothing else.
    const acceptedLinkElsewhere = await reviewCase(caseC, passA.token);
    record(
      "an accepted link cannot open another case, even with that case's own ids",
      acceptedLinkElsewhere.status === 401 &&
        leaks(acceptedLinkElsewhere.text, caseC).length === 0 &&
        !("caseFacts" in acceptedLinkElsewhere.body)
    );
    record(
      "nor any of its files",
      (
        await openDocument({
          claimantUserId: caseC.userId,
          submissionId: caseC.submissionId,
          token: passA.token,
          documentId: firstC,
        })
      ).status === 401
    );
    const acceptedLinkDecidesElsewhere = await decide(caseC, passA.token, "reject_case");
    record(
      "nor decide it",
      acceptedLinkDecidesElsewhere.status === 401 && (await assignmentFor(caseC.submissionId))?.status === "pending"
    );

    // ── rejected: masked, and the files are withdrawn ────────────────────────
    const beforeRejectB = await openFile(caseB, passB.token, pngB);
    const rejectB = await decide(caseB, passB.token, "reject_case");
    const rejectedB = await reviewCase(caseB, passB.token);
    record(
      "the lawyer rejects through the link (200, not_qualified)",
      rejectB.status === 200 && rejectB.body.status === "not_qualified"
    );
    record(
      "a rejected review stays masked, lists no files and cannot decide",
      rejectedB.body.access === "masked" &&
        leaks(rejectedB.text, caseB).length === 0 &&
        rejectedB.body.documents === null &&
        ((rejectedB.body.review ?? {}) as Json).status === "rejected" &&
        ((rejectedB.body.review ?? {}) as Json).canDecide === false
    );
    record(
      "a rejected review still shows the accident's date and place",
      ((rejectedB.body.incident ?? {}) as Json).date === INCIDENT_DATE &&
        ((rejectedB.body.incident ?? {}) as Json).location === caseB.location
    );
    const afterRejectB = await openFile(caseB, passB.token, pngB);
    record(
      "a file that opened before the rejection is refused after it (403)",
      beforeRejectB.status === 200 && afterRejectB.status === 403 && afterRejectB.body.error === "documents_unavailable"
    );
    // pass_to_lawyer is allowed only from signed, so a case a lawyer has turned
    // down cannot be sent on as it stands. Whether it may be is a product
    // decision; the case is put back to signed here so the second lawyer's
    // masking can still be checked.
    const repassRejected = await post(
      "/portal/review-decision",
      { claimantUserId: caseB.userId, submissionId: caseB.submissionId, action: "pass_to_lawyer" },
      admin.token
    );
    record(
      "a case a lawyer turned down is not sent on again as it stands (409)",
      repassRejected.status === 409 && repassRejected.body.error === "status_transition_not_allowed"
    );
    await supabase.from("intake_submissions").update({ status: "signed" }).eq("id", caseB.submissionId);
    const passB2 = await passToLawyer(caseB);
    const acceptB2 = await decide(caseB, passB2.token, "accept_case");
    const firstLawyerAfter = await reviewCase(caseB, passB.token);
    const secondLawyerAfter = await reviewCase(caseB, passB2.token);
    record(
      "a second lawyer can be sent the case and accept it",
      passB2.passed && acceptB2.status === 200 && secondLawyerAfter.body.access === "full"
    );
    record(
      "the first lawyer's rejected link stays masked after the other lawyer accepts, and opens no file",
      firstLawyerAfter.body.access === "masked" &&
        leaks(firstLawyerAfter.text, caseB).length === 0 &&
        (await openFile(caseB, passB.token, pngB)).status === 403
    );

    // ── decision window expired: masked, files still visible, no decision ──
    const beforeExpiryC = await openFile(caseC, passC.token, firstC);
    await supabase
      .from("review_assignments")
      .update({ decision_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("submission_id", caseC.submissionId)
      .eq("status", "pending");
    const expiredC = await reviewCase(caseC, passC.token);
    record(
      "a review past its decision window stays masked, lists files and cannot decide",
      expiredC.status === 200 &&
        expiredC.body.access === "masked" &&
        leaks(expiredC.text, caseC).length === 0 &&
        Array.isArray(expiredC.body.documents) &&
        ((expiredC.body.review ?? {}) as Json).status === "pending" &&
        ((expiredC.body.review ?? {}) as Json).canDecide === false
    );
    record(
      "a file still opens after the decision window closes while the link is alive",
      beforeExpiryC.status === 200 && (await openFile(caseC, passC.token, firstC)).status === 200
    );
    const lateAccept = await decide(caseC, passC.token, "accept_case");
    const afterLate = await assignmentFor(caseC.submissionId);
    const { data: lateEvents } = await supabase
      .from("review_decision_events")
      .select("action")
      .eq("submission_id", caseC.submissionId)
      .eq("action", "accept_case");
    record(
      "a late decision is refused and nothing is written",
      lateAccept.status === 409 &&
        lateAccept.body.error === "decision_window_expired" &&
        afterLate?.status === "pending" &&
        afterLate?.accepted_at === null &&
        (lateEvents ?? []).length === 0
    );
    const expiredVerify = await post("/portal/review-access/verify", {
      claimantUserId: caseC.userId,
      submissionId: caseC.submissionId,
      token: passC.token,
    });
    record(
      "a link still verifies after the decision window closes",
      expiredVerify.status === 200 && expiredVerify.body.canDecide === false
    );

    await supabase
      .from("review_assignments")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", String(acceptedRow?.id ?? ""));
    const acceptedThenExpired = await reviewCase(caseA, passA.token);
    record(
      "an accepted link that has expired masks again and opens no file",
      acceptedThenExpired.body.access === "masked" &&
        leaks(acceptedThenExpired.text, caseA).length === 0 &&
        acceptedThenExpired.body.documents === null &&
        (await openFile(caseA, passA.token, pdfA)).status === 403
    );

    // ── revoked: refused outright ────────────────────────────────────────────
    const idsD = await documentIds(caseD);
    const firstD = idsD.get(caseD.files[0]!.storagePath) ?? "";
    const beforeRevokeD = await openFile(caseD, passD.token, firstD);
    await supabase
      .from("review_assignments")
      .update({ revoked_at: new Date().toISOString() })
      .eq("submission_id", caseD.submissionId)
      .eq("status", "pending");
    const revokedD = await reviewCase(caseD, passD.token);
    record(
      "a revoked review is refused with nothing returned",
      revokedD.status === 401 && revokedD.body.error === "token_revoked" && leaks(revokedD.text, caseD).length === 0
    );
    record(
      "a revoked link opens no file (401), even one it opened before",
      beforeRevokeD.status === 200 && (await openFile(caseD, passD.token, firstD)).status === 401
    );
    const revokedDecision = await decide(caseD, passD.token, "accept_case");
    record(
      "a revoked link cannot decide",
      revokedDecision.status === 401 && (await assignmentFor(caseD.submissionId))?.status === "pending"
    );

    const acceptedB2Row = await assignmentFor(caseB.submissionId, "accepted");
    await supabase
      .from("review_assignments")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", String(acceptedB2Row?.id ?? ""));
    const revokedAfterAccept = await reviewCase(caseB, passB2.token);
    record(
      "revoking an accepted link withdraws the case and its files from it",
      revokedAfterAccept.status === 401 &&
        leaks(revokedAfterAccept.text, caseB).length === 0 &&
        (await openFile(caseB, passB2.token, pngB)).status === 401
    );
  } finally {
    server.close();
    globalThis.fetch = realFetch;
    await sweep();
    const { data: leftovers } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    const leftoverAccounts = await markedAccounts();
    record(
      "every record created by this test was removed",
      (leftovers ?? []).length === 0 && leftoverAccounts.length === 0
    );
  }

  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) {
    console.error(`FAIL: ${failed} lawyer review check(s) failed`);
    process.exit(1);
  }
  console.log(
    "PASS: a review link shows the case and its files, and nothing that identifies the patient until the lawyer accepts"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
