import "dotenv/config";
import { strict as assert } from "assert";
import { createHash, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// The lawyer handoff that follows a signed retainer, through the real routes,
// database and storage.
//
// When DocuSign reports the patient's envelope completed, the case must go
// retainer_pending_signature → signed → attorney with nobody acting: the signed
// PDF stored first, one review assignment, one decision event, and the lawyer
// notification once per lawyer — however many times, and however concurrently,
// the completion is read. The Admin Dashboard's pass_to_lawyer must keep working
// for a case that is 'signed' but not with a lawyer (signed before this change,
// or whose automatic handoff could not finish) and must not double up with the
// automatic path. Nothing may skip the state machine or the signed PDF.
//
// Twilio and DocuSign are stubbed and every request to them counted; nothing
// leaves the machine. The recipients are fictional +1555 numbers set here.
//
// Writes rows marked with TEST_MARKER and removes them, and their stored PDFs,
// afterwards. Runs only against the project TEST_SUPABASE_PROJECT_REF names, or
// "local" for a Supabase CLI stack on a loopback address.

const TEST_MARKER = "LawyerHandoffSuite";
const ADMIN_RECIPIENTS = ["+15550100011", "+15550100012"];
const LAWYER_RECIPIENTS = ["+15550100021", "+15550100022"];
const FRONTEND = "https://app.example.test";

type Sms = { to: string; body: string };
type Json = Record<string, unknown>;

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) throw new Error("TEST_SUPABASE_PROJECT_REF is required.");
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
  process.env.TWILIO_ACCOUNT_SID = `AC${randomBytes(16).toString("hex")}`;
  process.env.TWILIO_AUTH_TOKEN = randomBytes(16).toString("hex");
  process.env.TWILIO_FROM_NUMBER = "+15550109999";
  process.env.INTAKE_ADMIN_NOTIFICATION_TO = ADMIN_RECIPIENTS.join(",");
  process.env.INTAKE_LAWYER_NOTIFICATION_TO = LAWYER_RECIPIENTS.join(",");
  process.env.ADMIN_DASHBOARD_URL = "https://admin.example.test";
  process.env.FRONTEND_URL = FRONTEND;
  // DocuSign is stubbed, but its client still signs a JWT before asking: a real
  // throwaway key and placeholder identifiers, never the environment's own.
  if (!process.env.DOCUSIGN_RSA_PRIVATE_KEY) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.DOCUSIGN_RSA_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    process.env.DOCUSIGN_INTEGRATION_KEY = randomUUID();
    process.env.DOCUSIGN_USER_ID = randomUUID();
    process.env.DOCUSIGN_API_ACCOUNT_ID = randomUUID();
    process.env.DOCUSIGN_OAUTH_HOST = "account-d.docusign.com";
  }
  process.env.DOCUSIGN_TEMPLATE_ID_EN ||= "stub-template-en";
  process.env.DOCUSIGN_TEMPLATE_ID_ES ||= "stub-template-es";
  process.env.DOCUSIGN_TEMPLATE_ROLE_NAME ||= "Patient";

  const { supabase } = await import("../lib/supabase");
  const { AGREEMENTS_BUCKET } = await import("../lib/agreement-document");
  const { AUTOMATIC_HANDOFF_ACTOR_ID } = await import("../lib/lawyer-handoff");

  // ── stubs: DocuSign answers on demand; Twilio records what it was asked ─────
  const original = globalThis.fetch;
  const sent: Sms[] = [];
  const docusign = { envelopeStatus: "sent", envelopeCreates: 0, documentFails: false };
  // Each envelope's signed PDF is its own, so a document served for the wrong case cannot pass.
  const pdfFor = (envelopeId: string) =>
    Buffer.from(`%PDF-1.4\n% SIGNED RETAINER ${envelopeId}\ntrailer << >>\n%%EOF\n`, "latin1");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.twilio.com/")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      sent.push({ to: form.get("To") ?? "", body: form.get("Body") ?? "" });
      return json({ sid: `SM${randomBytes(16).toString("hex")}` });
    }
    if (url.includes("/oauth/token")) return json({ access_token: "stub", expires_in: 3600 });
    if (url.includes("/oauth/userinfo"))
      return json({
        sub: "stub",
        accounts: [
          { account_id: process.env.DOCUSIGN_API_ACCOUNT_ID, base_uri: "https://demo.docusign.net", is_default: true },
        ],
      });
    if (url.includes("/views/recipient")) return json({ url: "https://demo.docusign.net/signing/stub" });
    if (url.includes("/documents/combined")) {
      if (docusign.documentFails) return json({ errorCode: "STUBBED_FAILURE" }, 500);
      const envelopeId = url.match(/\/envelopes\/([^/]+)\/documents/)?.[1] ?? "";
      return new Response(new Uint8Array(pdfFor(envelopeId)), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.includes("/envelopes/")) return json({ status: docusign.envelopeStatus });
    if (url.endsWith("/envelopes") && (init?.method ?? "GET").toUpperCase() === "POST") {
      docusign.envelopeCreates += 1;
      return json({ envelopeId: `stub-${docusign.envelopeCreates}-${randomInt(1e6, 9e6)}` });
    }
    return original(input, init);
  }) as typeof fetch;

  const { resetTokenCache } = await import("../lib/docusign");
  resetTokenCache();
  const { app } = await import("../app");
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const checks: [string, boolean][] = [];
  const record = (label: string, passed: boolean, detail = "") =>
    checks.push([detail ? `${label}  — ${detail}` : label, passed]);
  const userIds: string[] = [];
  const submissionIds: string[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await original(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    let parsed: Json = {};
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as Json;
    } catch {
      parsed = {};
    }
    return { status: r.status, body: parsed, bytes };
  };

  const login = async (phone: string) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const r = await call("POST", "/intake/verify-otp", null, { phone, code: "111111" });
      if (r.status === 200) {
        const token = String(r.body.accessToken);
        const { data } = await supabase.auth.getUser(token);
        if (data.user) userIds.push(data.user.id);
        return { token, userId: data.user?.id ?? "" };
      }
      if (r.status !== 502 || attempt === 4) throw new Error(`login failed: ${r.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  // A real admin: an email user listed in admin_users, signed in by password.
  const adminEmail = `lawyer-handoff-${randomUUID()}@example.test`;
  const adminPassword = randomBytes(18).toString("base64url");
  const { data: adminUser, error: adminError } = await supabase.auth.admin.createUser({
    email: adminEmail,
    password: adminPassword,
    email_confirm: true,
  });
  if (adminError || !adminUser.user) throw new Error(`admin user failed: ${adminError?.message}`);
  userIds.push(adminUser.user.id);
  await supabase.from("admin_users").insert({ user_id: adminUser.user.id });
  const adminSession = await original(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  const adminToken = adminSession.access_token ?? "";

  type Patient = { token: string; userId: string; submissionId: string; claimantId: string };

  /** A patient with a submitted case, through /intake/start and /intake/complete. */
  const submittedPatient = async (label: string, locale = "en"): Promise<Patient> => {
    const phone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const session = await login(phone);
    const started = await call("POST", "/intake/start", session.token, {
      locale,
      claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone },
      accident: { incidentType: "car", incidentLocation: "Tampa, FL", incidentDate: "2026-09-20" },
    });
    const submissionId = String(started.body.submissionId ?? "");
    submissionIds.push(submissionId);
    await call("POST", "/intake/complete", session.token, {
      submissionId,
      claimant: { residence: "Tampa, FL" },
      accident: { role: "driver", description: "Rear-ended at a light." },
      treatmentArea: "Tampa, FL",
      documents: [],
    });
    const { data: claimant } = await supabase.from("claimants").select("id").eq("user_id", session.userId).single();
    return { ...session, submissionId, claimantId: String(claimant?.id ?? "") };
  };

  const decision = (p: Patient, action: string) =>
    call("POST", "/portal/review-decision", adminToken, {
      claimantUserId: p.userId,
      submissionId: p.submissionId,
      action,
    });
  const openSigning = (p: Patient, locale = "en") =>
    call("POST", "/intake/agreement", p.token, { submissionId: p.submissionId, locale });
  const reconcile = (p: Patient, token = p.token) => call("GET", `/intake/agreement/${p.submissionId}`, token);
  const statusOf = async (submissionId: string) =>
    (await supabase.from("intake_submissions").select("status").eq("id", submissionId).single()).data?.status;
  const assignmentsOf = async (submissionId: string) =>
    (
      await supabase
        .from("review_assignments")
        .select("id, status, assigned_by_user_id, review_link_token_hash")
        .eq("submission_id", submissionId)
    ).data ?? [];
  const eventsOf = async (submissionId: string) =>
    (
      await supabase
        .from("review_decision_events")
        .select("action, actor_user_id, actor_role, previous_status, next_status, metadata")
        .eq("submission_id", submissionId)
        .eq("action", "pass_to_lawyer")
    ).data ?? [];
  const agreementsOf = async (submissionId: string) =>
    (
      await supabase
        .from("agreements")
        .select("id, status, envelope_id, signed_document_path")
        .eq("submission_id", submissionId)
    ).data ?? [];
  const notificationRows = async (submissionId: string, eventType: string) =>
    (
      await supabase
        .from("case_notifications")
        .select("recipient, status")
        .eq("submission_id", submissionId)
        .eq("event_type", eventType)
    ).data ?? [];
  // The lawyer notification carries the review link; it names the case by its submission id.
  const lawyerSmsFor = (submissionId: string) =>
    sent.filter((m) => m.body.includes("New case match!") && m.body.includes(`submissionId=${submissionId}`));
  const lawyerSmsTotal = () => sent.filter((m) => m.body.includes("New case match!")).length;
  const tokenFrom = (sms: Sms | undefined) => {
    const link = sms?.body.match(/https?:\/\/\S+\/review\/\S+/)?.[0] ?? "";
    return link ? (new URL(link).searchParams.get("t") ?? "") : "";
  };
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");

  /** Approve, open the ceremony and have DocuSign report it completed on the next read. */
  const approvedAndSent = async (label: string, locale = "en") => {
    const p = await submittedPatient(label, locale);
    const approved = await decision(p, "approve_for_retainer");
    if (approved.status !== 200) throw new Error(`approve failed: ${approved.status}`);
    docusign.envelopeStatus = "sent";
    const opened = await openSigning(p, locale);
    if (opened.status !== 201 && opened.status !== 200) throw new Error(`open signing failed: ${opened.status}`);
    docusign.envelopeStatus = "completed";
    return p;
  };

  try {
    record("an admin session for the approval", Boolean(adminToken));

    // ── A: one signing, start to finish ─────────────────────────────────────
    const A = await approvedAndSent("HandoffA");
    record(
      "8. a case out for signing is not with a lawyer",
      (await statusOf(A.submissionId)) === "retainer_pending_signature" &&
        (await assignmentsOf(A.submissionId)).length === 0
    );
    const done = await reconcile(A);
    await settle();
    record(
      "1. DocuSign completion moves retainer_pending_signature → attorney, nobody acting",
      done.status === 200 && done.body.status === "completed" && (await statusOf(A.submissionId)) === "attorney"
    );

    const [agreementA] = await agreementsOf(A.submissionId);
    const storedA = agreementA?.signed_document_path
      ? await supabase.storage.from(AGREEMENTS_BUCKET).download(agreementA.signed_document_path)
      : null;
    const storedBytesA = storedA?.data ? Buffer.from(await storedA.data.arrayBuffer()) : null;
    record(
      "2. the signed agreement is recorded: completed, its PDF stored, byte for byte DocuSign's",
      agreementA?.status === "completed" &&
        Boolean(agreementA.signed_document_path) &&
        Boolean(storedBytesA?.equals(pdfFor(String(agreementA.envelope_id))))
    );

    const assignmentsA = await assignmentsOf(A.submissionId);
    const eventsA = await eventsOf(A.submissionId);
    record(
      "3. the handoff: one pending review assignment, made by the automatic actor",
      assignmentsA.length === 1 &&
        assignmentsA[0]?.status === "pending" &&
        assignmentsA[0]?.assigned_by_user_id === AUTOMATIC_HANDOFF_ACTOR_ID
    );
    record(
      "3. …and one pass_to_lawyer decision event, signed → attorney, marked automatic",
      eventsA.length === 1 &&
        eventsA[0]?.previous_status === "signed" &&
        eventsA[0]?.next_status === "attorney" &&
        (eventsA[0]?.metadata as Json | undefined)?.automatic === true &&
        (eventsA[0]?.metadata as Json | undefined)?.link_issued === true
    );

    const smsA = lawyerSmsFor(A.submissionId);
    const tokenA = tokenFrom(smsA[0]);
    record(
      "4. the lawyer notification goes once to each lawyer on the list",
      smsA.length === 2 &&
        new Set(smsA.map((m) => m.to)).size === 2 &&
        smsA.every((m) => LAWYER_RECIPIENTS.includes(m.to))
    );
    record(
      "4. …with a review link whose token is the assignment's, and recorded once per lawyer as sent",
      tokenA.length > 20 &&
        hash(tokenA) === assignmentsA[0]?.review_link_token_hash &&
        smsA.every((m) => tokenFrom(m) === tokenA) &&
        (await notificationRows(A.submissionId, "attorney_review_ready")).filter((r) => r.status === "sent").length ===
          2
    );
    record(
      "4/policy. the lawyer message names no one",
      smsA.every((m) => !m.body.includes("HandoffA") && !m.body.includes(TEST_MARKER) && !/\+1555/.test(m.body))
    );
    record(
      "14. the admin list gets the retainer_signed message, not the lawyer one, and lawyers get no admin message",
      sent.filter((m) => ADMIN_RECIPIENTS.includes(m.to)).every((m) => !m.body.includes("New case match!")) &&
        sent.filter((m) => LAWYER_RECIPIENTS.includes(m.to)).every((m) => m.body.includes("New case match!")) &&
        (await notificationRows(A.submissionId, "retainer_signed")).length === 2
    );

    // ── 5. the completion read again, every way the patient's app can ───────
    const lawyerBeforeRepeat = lawyerSmsTotal();
    for (let i = 0; i < 3; i += 1) await reconcile(A);
    for (let i = 0; i < 2; i += 1) await openSigning(A);
    await call("GET", "/patient/dashboard", A.token);
    await settle();
    record(
      "5. repeated completions and re-opened signing do not hand the case on again",
      lawyerSmsTotal() === lawyerBeforeRepeat &&
        (await assignmentsOf(A.submissionId)).length === 1 &&
        (await eventsOf(A.submissionId)).length === 1 &&
        (await agreementsOf(A.submissionId)).length === 1 &&
        (await statusOf(A.submissionId)) === "attorney"
    );

    // ── the lawyer side, through the link the lawyer was sent ───────────────
    const credentialA = { claimantUserId: A.userId, submissionId: A.submissionId, token: tokenA };
    const verified = await call("POST", "/portal/review-access/verify", null, credentialA);
    const maskedA = await call("POST", "/portal/review-case", null, credentialA);
    const dashboardBefore = await call("GET", "/patient/dashboard", A.token);
    const caseBefore = ((dashboardBefore.body.cases ?? []) as Json[]).find((c) => c.submissionId === A.submissionId);
    record(
      "12/13. before accepting, the lawyer sees the case masked and cannot open the retainer",
      verified.status === 200 &&
        verified.body.canDecide === true &&
        maskedA.body.access === "masked" &&
        (await call("POST", "/portal/review-retainer", null, credentialA)).status === 403
    );
    record(
      "13. provider matching is unchanged: no lawyer is matched until one accepts",
      ((caseBefore?.providers as Json)?.lawyer as Json)?.matched === false
    );
    const accepted = await call("POST", "/portal/review-decision-link", null, {
      ...credentialA,
      action: "accept_case",
    });
    const fullA = await call("POST", "/portal/review-case", null, credentialA);
    const retainerA = await call("POST", "/portal/review-retainer", null, credentialA);
    const dashboardAfter = await call("GET", "/patient/dashboard", A.token);
    const caseAfter = ((dashboardAfter.body.cases ?? []) as Json[]).find((c) => c.submissionId === A.submissionId);
    record(
      "12. after accepting, the lawyer opens this case's signed retainer, byte for byte",
      accepted.status === 200 &&
        fullA.body.access === "full" &&
        ((fullA.body.signedRetainer ?? {}) as Json).available === true &&
        retainerA.status === 200 &&
        Boolean(storedBytesA) &&
        retainerA.bytes.equals(storedBytesA!)
    );
    record(
      "13. …and the patient's dashboard then shows the lawyer matched",
      ((caseAfter?.providers as Json)?.lawyer as Json)?.matched === true
    );

    // ── 6. ten completions racing for one case, an admin click among them ───
    const B = await approvedAndSent("HandoffB");
    const lawyerBeforeB = lawyerSmsTotal();
    const raced = await Promise.all([
      ...Array.from({ length: 10 }, () => reconcile(B)),
      decision(B, "pass_to_lawyer"),
      decision(B, "pass_to_lawyer"),
    ]);
    await settle();
    const assignmentsB = await assignmentsOf(B.submissionId);
    record(
      "6. concurrent completions and admin clicks: one assignment, one event, one message per lawyer",
      (await statusOf(B.submissionId)) === "attorney" &&
        assignmentsB.length === 1 &&
        (await eventsOf(B.submissionId)).length === 1 &&
        lawyerSmsTotal() - lawyerBeforeB === 2 &&
        lawyerSmsFor(B.submissionId).length === 2 &&
        (await notificationRows(B.submissionId, "attorney_review_ready")).length === 2,
      `${assignmentsB.length} assignments, ${lawyerSmsTotal() - lawyerBeforeB} lawyer SMS`
    );
    record(
      "6. …every completion read still tells the patient it completed",
      raced.slice(0, 10).every((r) => r.status === 200 && r.body.status === "completed")
    );
    record(
      "10. an admin click on a case already handed on is refused, not repeated (409)",
      raced.slice(10).every((r) => r.status === 409) &&
        (await decision(B, "pass_to_lawyer")).status === 409 &&
        (await assignmentsOf(B.submissionId)).length === 1
    );

    // ── 7. completion that is not authoritative moves nothing ──────────────
    const C = await submittedPatient("HandoffC");
    await decision(C, "approve_for_retainer");
    docusign.envelopeStatus = "sent";
    await openSigning(C);
    const lawyerBeforeC = lawyerSmsTotal();
    for (const status of ["sent", "delivered", "declined"]) {
      docusign.envelopeStatus = status;
      await reconcile(C);
    }
    const stranger = await submittedPatient("HandoffStranger");
    docusign.envelopeStatus = "completed";
    const forged = await reconcile(C, stranger.token);
    const unauthenticated = await call("GET", `/intake/agreement/${C.submissionId}`, null);
    await settle();
    record(
      "7. an envelope DocuSign has not completed, another patient's session and no session move nothing",
      forged.status >= 400 &&
        unauthenticated.status === 401 &&
        (await statusOf(C.submissionId)) === "retainer_pending_signature" &&
        (await assignmentsOf(C.submissionId)).length === 0 &&
        lawyerSmsTotal() === lawyerBeforeC
    );

    // ── 8. a completed agreement on a case nobody approved ─────────────────
    const D = await submittedPatient("HandoffD");
    const lawyerBeforeD = lawyerSmsTotal();
    await supabase.from("agreements").insert({
      submission_id: D.submissionId,
      envelope_id: `legacy-${randomUUID()}`,
      status: "completed",
      locale: "en",
      completed_at: new Date().toISOString(),
    });
    await reconcile(D);
    const passUnapproved = await decision(D, "pass_to_lawyer");
    await settle();
    record(
      "8. a completed agreement on an unapproved case is neither signed nor handed on, by reading or by the admin",
      (await statusOf(D.submissionId)) === "submitted" &&
        passUnapproved.status === 409 &&
        passUnapproved.body.error === "status_transition_not_allowed" &&
        (await assignmentsOf(D.submissionId)).length === 0 &&
        lawyerSmsTotal() === lawyerBeforeD
    );

    // ── the signed PDF cannot be fetched: the case waits in 'signed' ───────
    const E = await approvedAndSent("HandoffE");
    const lawyerBeforeE = lawyerSmsTotal();
    docusign.documentFails = true;
    const doneE = await reconcile(E);
    await settle();
    const [agreementE] = await agreementsOf(E.submissionId);
    record(
      "no signed PDF, no lawyer: the case stops at 'signed' with nothing issued",
      doneE.body.status === "completed" &&
        agreementE?.status === "completed" &&
        !agreementE.signed_document_path &&
        (await statusOf(E.submissionId)) === "signed" &&
        (await assignmentsOf(E.submissionId)).length === 0 &&
        lawyerSmsTotal() === lawyerBeforeE
    );
    const refused = await decision(E, "pass_to_lawyer");
    record(
      "…and the admin cannot pass it on while the PDF is still missing (409)",
      refused.status === 409 &&
        refused.body.error === "retainer_document_unavailable" &&
        (await assignmentsOf(E.submissionId)).length === 0
    );
    docusign.documentFails = false;
    const passedE = await decision(E, "pass_to_lawyer");
    await settle();
    const [agreementE2] = await agreementsOf(E.submissionId);
    const eventsE = await eventsOf(E.submissionId);
    record(
      "…once the PDF can be fetched, the admin's pass_to_lawyer stores it and hands the case on",
      passedE.status === 200 &&
        typeof passedE.body.reviewLink === "string" &&
        Boolean(agreementE2?.signed_document_path) &&
        (await statusOf(E.submissionId)) === "attorney" &&
        eventsE.length === 1 &&
        eventsE[0]?.actor_user_id === adminUser.user.id &&
        (eventsE[0]?.metadata as Json | undefined)?.automatic === undefined &&
        lawyerSmsFor(E.submissionId).length === 2
    );

    // ── 11. cases from before this change keep their state ─────────────────
    // F: signed under the old workflow, its PDF stored, never passed on.
    const F = await approvedAndSent("HandoffF");
    const [agreementF] = await agreementsOf(F.submissionId);
    if (!agreementF) throw new Error("agreement fixture for F missing");
    await supabase
      .from("agreements")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        signed_document_path: `${F.submissionId}/legacy.pdf`,
      })
      .eq("id", agreementF.id);
    await supabase.from("intake_submissions").update({ status: "signed" }).eq("id", F.submissionId);
    const lawyerBeforeF = lawyerSmsTotal();
    for (let i = 0; i < 2; i += 1) await reconcile(F);
    await call("GET", "/patient/dashboard", F.token);
    await settle();
    record(
      "11. a case signed before this change is not handed on by a later read — it stays 'signed' for the admin",
      (await statusOf(F.submissionId)) === "signed" &&
        (await assignmentsOf(F.submissionId)).length === 0 &&
        lawyerSmsTotal() === lawyerBeforeF
    );
    const passedF = await decision(F, "pass_to_lawyer");
    await settle();
    record(
      "10/11. the admin's pass_to_lawyer still hands it on, once, with its link in the response",
      passedF.status === 200 &&
        (await statusOf(F.submissionId)) === "attorney" &&
        (await assignmentsOf(F.submissionId)).length === 1 &&
        lawyerSmsFor(F.submissionId).length === 2 &&
        tokenFrom({ to: "", body: String(passedF.body.reviewLink ?? "") }) ===
          tokenFrom(lawyerSmsFor(F.submissionId)[0])
    );
    // H: eight admin clicks on one signed case at once — every one of them past
    // the route's status check, racing inside the handoff itself.
    const H = await approvedAndSent("HandoffH");
    const [agreementH] = await agreementsOf(H.submissionId);
    if (!agreementH) throw new Error("agreement fixture for H missing");
    await supabase
      .from("agreements")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        signed_document_path: `${H.submissionId}/legacy.pdf`,
      })
      .eq("id", agreementH.id);
    await supabase.from("intake_submissions").update({ status: "signed" }).eq("id", H.submissionId);
    const lawyerBeforeH = lawyerSmsTotal();
    const clicks = await Promise.all(Array.from({ length: 8 }, () => decision(H, "pass_to_lawyer")));
    await settle();
    record(
      "6. eight concurrent admin clicks on a signed case: one hands it on, the rest are refused, one message per lawyer",
      clicks.filter((r) => r.status === 200).length === 1 &&
        clicks.filter((r) => r.status === 409).length === 7 &&
        (await assignmentsOf(H.submissionId)).length === 1 &&
        (await eventsOf(H.submissionId)).length === 1 &&
        lawyerSmsTotal() - lawyerBeforeH === 2 &&
        lawyerSmsFor(H.submissionId).length === 2,
      `${clicks.map((r) => r.status).join(",")}; ${lawyerSmsTotal() - lawyerBeforeH} lawyer SMS`
    );

    // A: already with a lawyer — and now accepted — keeps that state through every read.
    const statusA = await statusOf(A.submissionId);
    await reconcile(A);
    await openSigning(A);
    record(
      "11. a case already with a lawyer is left as it is by later reads and refused by pass_to_lawyer",
      statusA === "qualified" &&
        (await statusOf(A.submissionId)) === "qualified" &&
        (await decision(A, "pass_to_lawyer")).status === 409 &&
        (await assignmentsOf(A.submissionId)).length === 1
    );

    // ── 14. no lawyer recipients configured ─────────────────────────────────
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = "";
    const G = await approvedAndSent("HandoffG", "es");
    const smsBeforeG = sent.length;
    await reconcile(G);
    await settle();
    record(
      "14. an empty lawyer list sends nothing, and the Spanish-retainer case is still handed on",
      (await statusOf(G.submissionId)) === "attorney" &&
        (await assignmentsOf(G.submissionId)).length === 1 &&
        sent.slice(smsBeforeG).every((m) => !m.body.includes("New case match!")) &&
        (await notificationRows(G.submissionId, "attorney_review_ready")).length === 0
    );
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = LAWYER_RECIPIENTS.join(",");
  } catch (error) {
    record(`suite completed (${(error as Error).message})`, false);
  } finally {
    for (const submissionId of submissionIds) {
      const { data: objects } = await supabase.storage.from(AGREEMENTS_BUCKET).list(submissionId, { limit: 100 });
      if (objects?.length) {
        await supabase.storage.from(AGREEMENTS_BUCKET).remove(objects.map((o) => `${submissionId}/${o.name}`));
      }
    }
    const { data: claimants } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    for (const c of claimants ?? []) await supabase.from("intake_submissions").delete().eq("claimant_id", c.id);
    await supabase.from("claimants").delete().eq("last_name", TEST_MARKER);
    for (const id of userIds) await supabase.auth.admin.deleteUser(id);
    server.close();
    globalThis.fetch = original;
  }

  const failed = checks.filter(([, passed]) => !passed);
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} passed`);
  console.log(`  Twilio requests: ${sent.length}; DocuSign envelope creates: ${docusign.envelopeCreates}`);
  if (failed.length) throw new Error(`${failed.length} handoff check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: a signed retainer reaches a lawyer once, with its signed PDF, and nothing else does");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
