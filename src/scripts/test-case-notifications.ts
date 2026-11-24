import "dotenv/config";
import { strict as assert } from "assert";
import { generateKeyPairSync, randomBytes, randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// Admin SMS notifications, through the real routes, database and session.
//
// The retainer_signed notification is the one this suite is for: it must go to
// the admin list exactly once per case, and only after the case is stored as
// 'signed' — never for an approval, an envelope, a signing URL, a status that
// is still out for signing, a dashboard read, or any repeat of the completion.
// Signing then hands the case to a lawyer (test-lawyer-handoff.ts covers that),
// so a signed case is found with the lawyer, as 'attorney'.
// The intake notifications are checked alongside, so the change cannot regress
// them, and so are the patient's own texts (patient_intake_started,
// patient_intake_submitted, patient_retainer_ready): each is identified by the
// number it was sent to, never by a link in its body, and must reach exactly
// that patient's phone exactly once.
//
// Patient texts are always enabled. Sections A–I verify that patient delivery
// and case workflow stay correct regardless of PATIENT_SMS_NOTIFICATIONS values
// that might still be present in an environment.
//
// J is the brand ambassador's text (ambassador_patient_onboarded): sent to the
// ambassador the referral provider attributes the submission to, once, when the
// intake is submitted.
//
// K is the patient told an attorney has accepted their case (#55), sent from the
// lawyer review link.
//
// Twilio, DocuSign and Dub are stubbed and every request to them counted; nothing
// leaves the machine. The recipients are fictional +1555 numbers set here.
//
// Writes rows marked with TEST_MARKER and removes them afterwards. Runs only
// against the project TEST_SUPABASE_PROJECT_REF names, or "local" for a
// Supabase CLI stack on a loopback address.

const TEST_MARKER = "CaseNotificationsSuite";
const ADMIN_RECIPIENTS = ["+15550100001", "+15550100002"];
const LAWYER_RECIPIENT = "+15550100003";
const DASHBOARD = "https://admin.example.test";

type Sms = { to: string; body: string; statusAtSend: string | null; submissionId: string | null };

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
  process.env.INTAKE_LAWYER_NOTIFICATION_TO = "";
  process.env.ADMIN_DASHBOARD_URL = DASHBOARD;
  process.env.PATIENT_SMS_NOTIFICATIONS = "enabled";
  // a placeholder: every request to the referral provider is answered by the stub below
  process.env.DUB_API_KEY = `dub_test_${randomBytes(8).toString("hex")}`;
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
  process.env.FRONTEND_URL ||= "http://localhost:3000";

  const { supabase } = await import("../lib/supabase");

  // ── stubs: DocuSign answers on demand; Twilio records what it was asked ─────
  const original = globalThis.fetch;
  const sent: Sms[] = [];
  const docusign = { envelopeStatus: "sent", envelopeCreates: 0, recipientViews: 0 };
  let twilioFails = false;
  // numbers Twilio answers as opted out (STOP), as it does with error 21610
  const optedOut = new Set<string>();
  // the referral provider: which link each submission's lead was attributed to
  const dubCustomers = new Map<string, { linkId: string; partnerId?: string }>();
  const dub = { customerLookups: 0, down: false };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.twilio.com/")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const body = form.get("Body") ?? "";
      // The case this message is about, and its status at the moment of sending.
      const claimantId = body.match(/\/patient\/([0-9a-f-]{36})/)?.[1] ?? null;
      let submissionId: string | null = null;
      let statusAtSend: string | null = null;
      if (claimantId) {
        const { data } = await supabase
          .from("intake_submissions")
          .select("id, status")
          .eq("claimant_id", claimantId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        submissionId = data?.id ?? null;
        statusAtSend = data?.status ?? null;
      }
      sent.push({ to: form.get("To") ?? "", body, statusAtSend, submissionId });
      if (twilioFails) return json({ message: "stubbed failure", code: 30003 }, 400);
      if (optedOut.has(form.get("To") ?? "")) {
        return json({ message: "Attempt to send to unsubscribed recipient", code: 21610 }, 400);
      }
      return json({ sid: `SM${randomBytes(16).toString("hex")}` });
    }
    if (url.startsWith("https://api.dub.co/customers")) {
      dub.customerLookups += 1;
      if (dub.down) return json({ error: { code: "internal_server_error" } }, 500);
      const externalId = new URL(url).searchParams.get("externalId") ?? "";
      const referral = dubCustomers.get(externalId);
      return json(
        referral
          ? [
              {
                id: `cus_${randomBytes(6).toString("hex")}`,
                externalId,
                link: {
                  id: referral.linkId,
                  domain: "go.example.test",
                  key: "ambassador",
                  shortLink: "https://go.example.test/ambassador",
                },
                partner: referral.partnerId
                  ? { id: referral.partnerId, name: "Ambassador", email: null, image: null }
                  : null,
              },
            ]
          : []
      );
    }
    if (url.includes("/oauth/token")) return json({ access_token: "stub", expires_in: 3600 });
    if (url.includes("/oauth/userinfo"))
      return json({
        sub: "stub",
        accounts: [
          {
            account_id: process.env.DOCUSIGN_API_ACCOUNT_ID,
            base_uri: "https://demo.docusign.net",
            is_default: true,
          },
        ],
      });
    if (url.includes("/views/recipient")) {
      docusign.recipientViews += 1;
      return json({ url: "https://demo.docusign.net/signing/stub" });
    }
    if (url.includes("/documents/combined"))
      return new Response(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 37, 69, 79, 70, 10]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    if (url.includes("/envelopes/")) return json({ status: docusign.envelopeStatus });
    if (url.endsWith("/envelopes") && (init?.method ?? "GET").toUpperCase() === "POST") {
      docusign.envelopeCreates += 1;
      return json({ envelopeId: `stub-${docusign.envelopeCreates}-${randomInt(1e6, 9e6)}` });
    }
    return original(input, init);
  }) as typeof fetch;

  const { patientSmsEnabled, ambassadorSmsEnabled } = await import("../lib/case-notifications");
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
  const ambassadorIds: string[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await original(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
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
  const adminEmail = `case-notifications-${randomUUID()}@example.test`;
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

  /** A patient with a submitted case, through /intake/start and /intake/complete. */
  const submittedPatient = async (label: string, { startTwice = false } = {}) => {
    const phone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const session = await login(phone);
    const startBody = {
      locale: "en",
      claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone },
      accident: { incidentType: "car", incidentLocation: "Tampa, FL", incidentDate: "2026-09-20" },
    };
    const started = await call("POST", "/intake/start", session.token, startBody);
    // The app calls start twice in one intake — at verification and again once
    // the accident screens are answered; the second resumes the same case.
    if (startTwice) await call("POST", "/intake/start", session.token, startBody);
    const submissionId = String(started.body.submissionId ?? "");
    const completed = await call("POST", "/intake/complete", session.token, {
      submissionId,
      claimant: { residence: "Tampa, FL" },
      accident: { role: "driver", description: "Rear-ended at a light." },
      treatmentArea: "Tampa, FL",
      documents: [],
    });
    const { data: claimant } = await supabase.from("claimants").select("id").eq("user_id", session.userId).single();
    return { ...session, phone, submissionId, claimantId: String(claimant?.id ?? ""), started, completed };
  };

  const approve = (p: { userId: string; submissionId: string }) =>
    call("POST", "/portal/review-decision", adminToken, {
      claimantUserId: p.userId,
      submissionId: p.submissionId,
      action: "approve_for_retainer",
    });
  const openSigning = (p: { token: string; submissionId: string }) =>
    call("POST", "/intake/agreement", p.token, { submissionId: p.submissionId, locale: "en" });
  const reconcile = (p: { token: string; submissionId: string }) =>
    call("GET", `/intake/agreement/${p.submissionId}`, p.token);
  const statusOf = async (submissionId: string) =>
    (await supabase.from("intake_submissions").select("status").eq("id", submissionId).single()).data?.status;
  const sentFor = (submissionId: string, eventFragment: RegExp) =>
    sent.filter((m) => m.submissionId === submissionId && eventFragment.test(m.body));
  const SIGNED = /signed their retainer/;
  // The patient's own texts, found by the number they went to.
  const PATIENT_STARTED = /We received your case intake\./;
  const PATIENT_SUBMITTED = /We received your completed onboarding information\./;
  const PATIENT_RETAINER_READY = /Your retainer agreement is ready for review and signature\./;
  const PATIENT_TEXT = new RegExp(
    [PATIENT_STARTED, PATIENT_SUBMITTED, PATIENT_RETAINER_READY].map((r) => r.source).join("|")
  );
  const sentTo = (phone: string, fragment: RegExp) => sent.filter((m) => m.to === phone && fragment.test(m.body));
  const ADMIN_TEXT = /New client alert|signed their retainer/;
  // Every signed-retainer SMS, whoever it names: an extra send cannot hide by
  // leaving out the link the per-case filter reads.
  const signedTotal = () => sent.filter((m) => SIGNED.test(m.body)).length;
  const rows = async (submissionId: string, eventType: string) =>
    (
      await supabase
        .from("case_notifications")
        .select("recipient, status, message_body")
        .eq("submission_id", submissionId)
        .eq("event_type", eventType)
    ).data ?? [];

  try {
    record("an admin session for the approval", Boolean(adminToken));
    record(
      "17. patient texts are always on regardless of PATIENT_SMS_NOTIFICATIONS value",
      [undefined, "", "enabled", "disabled", "true", "1", "yes", "on", "enable"].every((value) =>
        patientSmsEnabled(value === undefined ? {} : { PATIENT_SMS_NOTIFICATIONS: value })
      )
    );

    // ── A: the whole lifecycle, once ─────────────────────────────────────────
    const A = await submittedPatient("NotifyA");
    await settle();
    record(
      "7. intake start notifies each admin once and texts the patient's own phone once",
      sentFor(A.submissionId, /New client alert: intake\./).length === 2 &&
        sentTo(A.phone, PATIENT_STARTED).length === 1 &&
        sent.filter((m) => PATIENT_STARTED.test(m.body)).every((m) => m.to === A.phone)
    );
    record(
      "8. intake submission notifies each admin once and texts the patient's own phone once, linking their dashboard",
      sentFor(A.submissionId, /New client alert: submitted\./).length === 2 &&
        sentTo(A.phone, PATIENT_SUBMITTED).length === 1 &&
        sent.filter((m) => PATIENT_SUBMITTED.test(m.body)).every((m) => m.to === A.phone) &&
        sentTo(A.phone, PATIENT_SUBMITTED).every((m) => m.body.includes("/en/intake/dashboard"))
    );
    record("…and no retainer text before the admin approves", sentTo(A.phone, PATIENT_RETAINER_READY).length === 0);
    record(
      "…and no patient text goes to an admin number",
      sent.filter((m) => PATIENT_TEXT.test(m.body)).every((m) => !ADMIN_RECIPIENTS.includes(m.to))
    );

    const approved = await approve(A);
    await settle();
    record(
      "approval moves the case to retainer_pending_signature",
      approved.status === 200 && (await statusOf(A.submissionId)) === "retainer_pending_signature"
    );
    record("1. the retainer becoming pending sends no signed notification", signedTotal() === 0);
    const retainerReady = sentTo(A.phone, PATIENT_RETAINER_READY);
    record(
      "13. approval texts the patient's own phone once that their retainer is ready, linking their dashboard",
      retainerReady.length === 1 &&
        sent.filter((m) => PATIENT_RETAINER_READY.test(m.body)).every((m) => m.to === A.phone) &&
        retainerReady[0]!.body.includes("/en/intake/dashboard") &&
        !retainerReady[0]!.body.includes("NotifyA"),
      `${retainerReady.length} sent`
    );
    const readyRows = await rows(A.submissionId, "patient_retainer_ready");
    record(
      "…recorded once, as sent, to that phone in case_notifications",
      readyRows.length === 1 && readyRows[0]!.status === "sent" && readyRows[0]!.recipient === A.phone
    );
    const approvedAgain = await approve(A);
    await settle();
    record(
      "…a repeated approval is refused and texts nothing more",
      approvedAgain.status === 409 && sentTo(A.phone, PATIENT_RETAINER_READY).length === 1
    );

    const opened = await openSigning(A);
    await settle();
    record(
      "2/3. creating the envelope and opening the signing page send none",
      opened.status === 200 || opened.status === 201 ? docusign.envelopeCreates === 1 && signedTotal() === 0 : false,
      `${opened.status} creates=${docusign.envelopeCreates}`
    );

    for (const status of ["sent", "delivered"]) {
      docusign.envelopeStatus = status;
      await reconcile(A);
    }
    await call("GET", "/patient/dashboard", A.token);
    await settle();
    record(
      "…nor does an envelope still out for signing, reconciled twice",
      signedTotal() === 0 && (await statusOf(A.submissionId)) === "retainer_pending_signature"
    );
    record("11. a dashboard read sends none", signedTotal() === 0);

    docusign.envelopeStatus = "completed";
    const done = await reconcile(A);
    await settle();
    const firstSigned = sentFor(A.submissionId, SIGNED);
    record(
      "4. completing the signing notifies each admin exactly once",
      done.body.status === "completed" &&
        signedTotal() === 2 &&
        firstSigned.length === 2 &&
        new Set(firstSigned.map((m) => m.to)).size === 2,
      `${firstSigned.length} sent`
    );
    record(
      "…to the admin list, not the lawyer list",
      firstSigned.length > 0 && firstSigned.every((m) => ADMIN_RECIPIENTS.includes(m.to))
    );
    // The handoff to a lawyer follows the signing at once, so by the time a
    // message goes the case may already have moved on from 'signed' to
    // 'attorney' — never still out for signing.
    record(
      "12. the case was stored 'signed' before each message was sent",
      firstSigned.length > 0 && firstSigned.every((m) => m.statusAtSend === "signed" || m.statusAtSend === "attorney"),
      firstSigned.map((m) => m.statusAtSend).join(",")
    );
    record(
      "9/policy. the message says signed and ready for review, links the admin dashboard, and names no one",
      firstSigned.length > 0 &&
        firstSigned.every(
          (m) =>
            m.body.includes(`${DASHBOARD}/patient/${A.claimantId}`) &&
            !m.body.includes("NotifyA") &&
            !m.body.includes(TEST_MARKER) &&
            !/\+1555/.test(m.body)
        )
    );
    const aRows = await rows(A.submissionId, "retainer_signed");
    record(
      "…recorded once per recipient as sent in case_notifications",
      aRows.length === 2 && aRows.every((r) => r.status === "sent")
    );

    for (let i = 0; i < 3; i += 1) await reconcile(A);
    for (let i = 0; i < 2; i += 1) await openSigning(A);
    await call("GET", "/patient/dashboard", A.token);
    await Promise.all(Array.from({ length: 10 }, () => reconcile(A)));
    await settle();
    record(
      "5/6. repeated, concurrent and already-completed reads send nothing more",
      signedTotal() === 2 && (await rows(A.submissionId, "retainer_signed")).length === 2
    );
    record("…and the case has gone on to the lawyer, once", (await statusOf(A.submissionId)) === "attorney");

    // ── B: ten concurrent completions racing for one pending case ───────────
    const B = await submittedPatient("NotifyB");
    const beforeB = signedTotal();
    await approve(B);
    docusign.envelopeStatus = "sent";
    await openSigning(B);
    docusign.envelopeStatus = "completed";
    await Promise.all(Array.from({ length: 10 }, () => reconcile(B)));
    await settle();
    record(
      "6. ten concurrent completions: one notification per admin",
      signedTotal() - beforeB === 2 &&
        sentFor(B.submissionId, SIGNED).length === 2 &&
        (await rows(B.submissionId, "retainer_signed")).length === 2,
      `${signedTotal() - beforeB} sent`
    );

    // ── C: Twilio fails ─────────────────────────────────────────────────────
    const C = await submittedPatient("NotifyC");
    const beforeC = signedTotal();
    await approve(C);
    docusign.envelopeStatus = "sent";
    await openSigning(C);
    twilioFails = true;
    docusign.envelopeStatus = "completed";
    const failedCompletion = await reconcile(C);
    await settle();
    twilioFails = false;
    const cRows = await rows(C.submissionId, "retainer_signed");
    record(
      "10. a failed send is recorded as failed and the patient is still told it completed",
      failedCompletion.status === 200 &&
        failedCompletion.body.status === "completed" &&
        cRows.length === 2 &&
        cRows.every((r) => r.status === "failed")
    );
    record("…and the case still goes on to the lawyer", (await statusOf(C.submissionId)) === "attorney");
    await reconcile(C);
    await settle();
    record(
      "…later reads do not resend it (the transition happened once)",
      signedTotal() - beforeC === 2 && sentFor(C.submissionId, SIGNED).length === 2
    );

    // ── D: no admin recipients configured ───────────────────────────────────
    process.env.INTAKE_ADMIN_NOTIFICATION_TO = "";
    const beforeD = sent.length;
    const D = await submittedPatient("NotifyD");
    await approve(D);
    docusign.envelopeStatus = "sent";
    await openSigning(D);
    docusign.envelopeStatus = "completed";
    const quiet = await reconcile(D);
    await settle();
    const sinceD = sent.slice(beforeD);
    record(
      "9. an empty admin list texts no admin, and the case still completes",
      quiet.body.status === "completed" &&
        sinceD.filter((m) => ADMIN_TEXT.test(m.body)).length === 0 &&
        (await rows(D.submissionId, "retainer_signed")).length === 0 &&
        (await statusOf(D.submissionId)) === "attorney"
    );
    record(
      "…while the patient still gets their own texts, each once, and nothing else is sent",
      sentTo(D.phone, PATIENT_STARTED).length === 1 &&
        sentTo(D.phone, PATIENT_SUBMITTED).length === 1 &&
        sentTo(D.phone, PATIENT_RETAINER_READY).length === 1 &&
        sinceD.length === 3 &&
        sinceD.every((m) => m.to === D.phone),
      `${sinceD.length} sent`
    );
    process.env.INTAKE_ADMIN_NOTIFICATION_TO = ADMIN_RECIPIENTS.join(",");

    // ── E: a completed agreement on a case nobody approved ──────────────────
    const E = await submittedPatient("NotifyE");
    const beforeE = signedTotal();
    await supabase.from("agreements").insert({
      submission_id: E.submissionId,
      envelope_id: `legacy-${randomUUID()}`,
      status: "completed",
      locale: "en",
      completed_at: new Date().toISOString(),
    });
    await reconcile(E);
    await settle();
    record(
      "a completed agreement on an unapproved case neither signs it nor notifies",
      (await statusOf(E.submissionId)) === "submitted" && signedTotal() === beforeE
    );
    record(
      "14. a case nobody approved never gets the retainer text",
      sentTo(E.phone, PATIENT_STARTED).length === 1 &&
        sentTo(E.phone, PATIENT_SUBMITTED).length === 1 &&
        sentTo(E.phone, PATIENT_RETAINER_READY).length === 0 &&
        (await rows(E.submissionId, "patient_retainer_ready")).length === 0
    );

    // ── F: two starts in one intake ──────────────────────────────────────────
    const F = await submittedPatient("NotifyF", { startTwice: true });
    await settle();
    record(
      "15. two starts in one intake text the patient once (duplicate-send protection)",
      sentTo(F.phone, PATIENT_STARTED).length === 1 &&
        (await rows(F.submissionId, "patient_intake_started")).filter((r) => r.status === "sent").length === 1
    );

    // ── G: a start whose phone is not the verified one ──────────────────────
    const verifiedPhone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const otherPhone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const G = await login(verifiedPhone);
    const beforeG = sent.length;
    const mismatched = await call("POST", "/intake/start", G.token, {
      locale: "en",
      claimant: { firstName: "NotifyG", lastName: TEST_MARKER, mobile: otherPhone },
    });
    await settle();
    record(
      "16. a start naming another phone is refused (403 phone_mismatch) and texts no one",
      mismatched.status === 403 &&
        mismatched.body.error === "phone_mismatch" &&
        sent.length === beforeG &&
        sent.every((m) => m.to !== otherPhone),
      `${mismatched.status}`
    );

    // ── H: even with a disabled env value set, patient texts still send ──────
    process.env.PATIENT_SMS_NOTIFICATIONS = "disabled";
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = LAWYER_RECIPIENT;
    const beforeH = signedTotal();
    const H = await submittedPatient("NotifyH");
    await settle();
    record(
      "18. disabled env value: intake start and submission still alert each admin once and still text the patient",
      sentFor(H.submissionId, /New client alert: intake\./).length === 2 &&
        sentFor(H.submissionId, /New client alert: submitted\./).length === 2 &&
        sentTo(H.phone, PATIENT_STARTED).length === 1 &&
        sentTo(H.phone, PATIENT_SUBMITTED).length === 1
    );
    const approvedH = await approve(H);
    await settle();
    record(
      "…the approval still moves the case on, with a retainer-ready patient text",
      approvedH.status === 200 &&
        (await statusOf(H.submissionId)) === "retainer_pending_signature" &&
        sentTo(H.phone, PATIENT_RETAINER_READY).length === 1
    );
    docusign.envelopeStatus = "sent";
    await openSigning(H);
    docusign.envelopeStatus = "completed";
    await reconcile(H);
    await settle();
    record(
      "…signing still alerts each admin once",
      signedTotal() - beforeH === 2 &&
        sentFor(H.submissionId, SIGNED).length === 2 &&
        sentFor(H.submissionId, SIGNED).every((m) => ADMIN_RECIPIENTS.includes(m.to))
    );
    const lawyerTexts = sent.filter((m) => m.to === LAWYER_RECIPIENT && /New case match!/.test(m.body));
    const lawyerRows = await rows(H.submissionId, "attorney_review_ready");
    record(
      "…and the case goes to the lawyer, whose text carries this case's review link, once",
      (await statusOf(H.submissionId)) === "attorney" &&
        lawyerTexts.length === 1 &&
        lawyerTexts[0]!.body.includes(`/en/review/${H.userId}?submissionId=${H.submissionId}&t=`) &&
        lawyerRows.length === 1 &&
        lawyerRows[0]!.status === "sent" &&
        lawyerRows[0]!.recipient === LAWYER_RECIPIENT,
      `${lawyerTexts.length} sent`
    );
    const patientRowsH = await Promise.all(
      ["patient_intake_started", "patient_intake_submitted", "patient_retainer_ready"].map((event) =>
        rows(H.submissionId, event)
      )
    );
    record(
      "…the patient got all three onboarding texts and each patient event recorded one sent attempt",
      sentTo(H.phone, PATIENT_STARTED).length === 1 &&
        sentTo(H.phone, PATIENT_SUBMITTED).length === 1 &&
        sentTo(H.phone, PATIENT_RETAINER_READY).length === 1 &&
        patientRowsH.every((eventRows) => eventRows.length === 1 && eventRows[0]!.status === "sent")
    );
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = "";

    // ── I: unset and mistyped env values still send patient texts ───────────
    for (const [label, value] of [
      ["unset", undefined],
      ['"true"', "true"],
    ] as const) {
      if (value === undefined) delete process.env.PATIENT_SMS_NOTIFICATIONS;
      else process.env.PATIENT_SMS_NOTIFICATIONS = value;
      const I = await submittedPatient(`NotifyI${value ?? "unset"}`);
      await settle();
      record(
        `19. ${label}: the admins are still alerted and the patient is still texted`,
        sentFor(I.submissionId, /New client alert: intake\./).length === 2 &&
          sentFor(I.submissionId, /New client alert: submitted\./).length === 2 &&
          sentTo(I.phone, PATIENT_STARTED).length === 1 &&
          sentTo(I.phone, PATIENT_SUBMITTED).length === 1 &&
          (await rows(I.submissionId, "patient_intake_started")).length === 1
      );
    }
    process.env.PATIENT_SMS_NOTIFICATIONS = "enabled";

    // ── J: the brand ambassador whose link brought the patient in ───────────
    record("20. ambassador texts are always enabled", ambassadorSmsEnabled() && ambassadorSmsEnabled({}));

    // A real ambassador: a verified phone, a profile and the referral link the provider attributes leads to.
    const ambassadorPhone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const ambassadorLink = `link_${randomBytes(8).toString("hex")}`;
    const ambassadorPartner = `pn_${randomBytes(8).toString("hex")}`;
    const { data: ambassadorUser, error: ambassadorUserError } = await supabase.auth.admin.createUser({
      phone: ambassadorPhone,
      phone_confirm: true,
    });
    if (ambassadorUserError || !ambassadorUser.user)
      throw new Error(`ambassador user failed: ${ambassadorUserError?.message}`);
    const ambassadorId = ambassadorUser.user.id;
    userIds.push(ambassadorId);
    ambassadorIds.push(ambassadorId);
    const { error: profileError } = await supabase
      .from("profiles")
      // a different number on the profile: the text must go to the verified sign-in phone
      .insert({
        user_id: ambassadorId,
        email: `ambassador-${randomBytes(4).toString("hex")}@example.test`,
        phone: "+15550000000",
      });
    if (profileError) throw new Error(`ambassador profile failed: ${profileError.message}`);
    const { error: ambassadorProfileError } = await supabase.from("ambassador_profiles").insert({
      user_id: ambassadorId,
      username: `notify${randomBytes(4).toString("hex")}`,
      provider_link_id: ambassadorLink,
      provider_partner_id: ambassadorPartner,
    });
    if (ambassadorProfileError) throw new Error(`ambassador_profiles failed: ${ambassadorProfileError.message}`);

    const ONBOARDED = /A new patient just onboarded using your link/;
    const toAmbassador = () => sent.filter((m) => m.to === ambassadorPhone && ONBOARDED.test(m.body));
    const ambassadorRows = (submissionId: string) => rows(submissionId, "ambassador_patient_onboarded");
    const startOnly = async (label: string) => {
      const phone = `+1555${randomInt(1_000_000, 9_999_999)}`;
      const session = await login(phone);
      const started = await call("POST", "/intake/start", session.token, {
        locale: "en",
        claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone },
        accident: { incidentType: "car", incidentLocation: "Tampa, FL", incidentDate: "2026-09-20" },
      });
      return { ...session, phone, submissionId: String(started.body.submissionId ?? "") };
    };
    const complete = (p: { token: string; submissionId: string }) =>
      call("POST", "/intake/complete", p.token, {
        submissionId: p.submissionId,
        claimant: { residence: "Tampa, FL" },
        accident: { role: "driver", description: "Rear-ended at a light." },
        treatmentArea: "Tampa, FL",
        documents: [],
      });

    process.env.PATIENT_SMS_NOTIFICATIONS = "disabled";

    // J1: started through the link — nothing yet; submitted — the ambassador, once
    const lookupsBeforeJ = dub.customerLookups;
    const J = await startOnly("NotifyJ");
    dubCustomers.set(J.submissionId, { linkId: ambassadorLink, partnerId: ambassadorPartner });
    await settle();
    record(
      "21. an intake that is only started texts no ambassador and asks the referral provider nothing",
      toAmbassador().length === 0 && dub.customerLookups === lookupsBeforeJ
    );
    const completedJ = await complete(J);
    await settle();
    const textJ = toAmbassador();
    const dashboard = `${(process.env.FRONTEND_URL ?? "").replace(/\/+$/, "")}/en/ambassadors/dashboard`;
    record(
      "22. submitting the intake texts the referring ambassador once, at their verified phone, with the exact message",
      completedJ.status === 200 &&
        textJ.length === 1 &&
        textJ[0]!.body ===
          `HelpAfterAccident: A new patient just onboarded using your link, visit your dashboard at ${dashboard} for more details. Reply STOP to opt out.`,
      textJ[0]?.body ?? "none"
    );
    const jRows = await ambassadorRows(J.submissionId);
    record(
      "…names no one, goes to no one else, and is recorded once as sent to that phone",
      textJ.length === 1 &&
        !textJ[0]!.body.includes("NotifyJ") &&
        sent.filter((m) => ONBOARDED.test(m.body)).every((m) => m.to === ambassadorPhone) &&
        !sent.some((m) => m.to === "+15550000000") &&
        jRows.length === 1 &&
        jRows[0]!.status === "sent" &&
        jRows[0]!.recipient === ambassadorPhone
    );
    record(
      "…while the admin alerts still go out once each",
      sentFor(J.submissionId, /New client alert: submitted\./).length === 2
    );

    // J2: the same intake completed again — nothing more
    const again = await complete(J);
    await settle();
    record(
      "23. completing the same intake again sends the ambassador nothing more",
      again.status === 200 && toAmbassador().length === 1 && (await ambassadorRows(J.submissionId)).length === 1,
      `${again.status}`
    );

    // J3–J5: no referral, a link no ambassador holds, the provider down — nothing, and each intake is submitted
    const noReferral = await startOnly("NotifyJNone");
    await complete(noReferral);
    const unknownLink = await startOnly("NotifyJUnknown");
    dubCustomers.set(unknownLink.submissionId, { linkId: `link_${randomBytes(8).toString("hex")}` });
    await complete(unknownLink);
    await settle();
    const providerDown = await startOnly("NotifyJDown");
    dubCustomers.set(providerDown.submissionId, { linkId: ambassadorLink });
    dub.down = true;
    await complete(providerDown);
    await settle();
    dub.down = false;
    record(
      "24. no text without a referral, for a link no ambassador holds, or when the referral provider is down",
      toAmbassador().length === 1 &&
        (await statusOf(noReferral.submissionId)) === "submitted" &&
        (await statusOf(unknownLink.submissionId)) === "submitted" &&
        (await statusOf(providerDown.submissionId)) === "submitted" &&
        (await ambassadorRows(providerDown.submissionId)).length === 0
    );

    // J6: an ambassador who submits their own intake through their own link
    const self = await login(ambassadorPhone);
    const selfStart = await call("POST", "/intake/start", self.token, {
      locale: "en",
      claimant: { firstName: "NotifyJSelf", lastName: TEST_MARKER, mobile: ambassadorPhone },
      accident: { incidentType: "car", incidentLocation: "Tampa, FL", incidentDate: "2026-09-20" },
    });
    const selfSubmission = String(selfStart.body.submissionId ?? "");
    dubCustomers.set(selfSubmission, { linkId: ambassadorLink });
    await complete({ token: self.token, submissionId: selfSubmission });
    await settle();
    record(
      "25. an ambassador who submits their own intake through their own link is not texted about it",
      Boolean(selfSubmission) && toAmbassador().length === 1 && (await ambassadorRows(selfSubmission)).length === 0
    );

    // J7: Twilio fails, and an ambassador who replied STOP — recorded as failed, intake untouched
    const failing = await startOnly("NotifyJFail");
    dubCustomers.set(failing.submissionId, { linkId: ambassadorLink });
    twilioFails = true;
    const failingDone = await complete(failing);
    await settle();
    twilioFails = false;
    const stopped = await startOnly("NotifyJStop");
    dubCustomers.set(stopped.submissionId, { linkId: ambassadorLink });
    optedOut.add(ambassadorPhone);
    await complete(stopped);
    await settle();
    optedOut.delete(ambassadorPhone);
    const failedRows = await ambassadorRows(failing.submissionId);
    const stoppedRows = await ambassadorRows(stopped.submissionId);
    record(
      "26. a Twilio failure or an opted-out (STOP) ambassador is recorded as failed, and the intake stays submitted",
      failingDone.status === 200 &&
        failedRows.length === 1 &&
        failedRows[0]!.status === "failed" &&
        stoppedRows.length === 1 &&
        stoppedRows[0]!.status === "failed" &&
        (await statusOf(failing.submissionId)) === "submitted" &&
        (await statusOf(stopped.submissionId)) === "submitted"
    );
    process.env.PATIENT_SMS_NOTIFICATIONS = "enabled";

    // ── K: the patient told an attorney accepted their case (patient_case_accepted, #55) ──
    // Sent from the lawyer's review link when they accept, after the case is
    // stored as qualified; never on a reject, never twice, never while patient
    // texts are off. The link the lawyer received is read from their text.
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = LAWYER_RECIPIENT;
    const ACCEPTED = /An attorney has accepted your case\./;
    const withLawyer = async (label: string) => {
      const p = await submittedPatient(label);
      await approve(p);
      docusign.envelopeStatus = "sent";
      await openSigning(p);
      docusign.envelopeStatus = "completed";
      await reconcile(p);
      await settle();
      const lawyerText = sent.find(
        (m) => m.to === LAWYER_RECIPIENT && m.body.includes(`/en/review/${p.userId}?submissionId=${p.submissionId}`)
      );
      const token = lawyerText?.body.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1] ?? "";
      return { ...p, token };
    };
    const decide = (p: { userId: string; submissionId: string; token: string }, action: string) =>
      call("POST", "/portal/review-decision-link", null, {
        claimantUserId: p.userId,
        submissionId: p.submissionId,
        token: p.token,
        action,
      });

    const K = await withLawyer("NotifyK");
    const beforeAccept = sentTo(K.phone, ACCEPTED).length;
    const accepted = await decide(K, "accept_case");
    await settle();
    const acceptedTexts = sentTo(K.phone, ACCEPTED);
    record(
      "28. a lawyer accepting through the review link texts that patient once, after the case is stored qualified",
      Boolean(K.token) &&
        beforeAccept === 0 &&
        accepted.status === 200 &&
        (await statusOf(K.submissionId)) === "qualified" &&
        acceptedTexts.length === 1 &&
        acceptedTexts[0]!.body ===
          `HelpAfterAccident: An attorney has accepted your case. Visit your dashboard to review your case details and next steps: ${(process.env.FRONTEND_URL ?? "").replace(/\/+$/, "")}/en/intake/dashboard. Reply STOP to opt out, HELP for help.` &&
        sent.filter((m) => ACCEPTED.test(m.body)).every((m) => m.to === K.phone),
      `${accepted.status} ${acceptedTexts.length} sent`
    );
    const acceptedAgain = await decide(K, "accept_case");
    await settle();
    record(
      "…a repeated accept is refused (409) and texts nothing more",
      acceptedAgain.status === 409 && sentTo(K.phone, ACCEPTED).length === 1,
      `${acceptedAgain.status}`
    );

    const R = await withLawyer("NotifyKReject");
    const rejected = await decide(R, "reject_case");
    await settle();
    record(
      "29. a lawyer rejecting the case texts the patient no acceptance",
      Boolean(R.token) && rejected.status === 200 && sentTo(R.phone, ACCEPTED).length === 0,
      `${rejected.status}`
    );

    process.env.PATIENT_SMS_NOTIFICATIONS = "disabled";
    const Q = await withLawyer("NotifyKOff");
    const quietAccept = await decide(Q, "accept_case");
    await settle();
    record(
      "30. with a disabled env value, an accept still lands and still texts the patient once",
      Boolean(Q.token) &&
        quietAccept.status === 200 &&
        (await statusOf(Q.submissionId)) === "qualified" &&
        sentTo(Q.phone, ACCEPTED).length === 1 &&
        (await rows(Q.submissionId, "patient_case_accepted")).length === 1
    );
    process.env.PATIENT_SMS_NOTIFICATIONS = "enabled";
    process.env.INTAKE_LAWYER_NOTIFICATION_TO = "";
  } catch (error) {
    record(`suite completed (${(error as Error).message})`, false);
  } finally {
    const { data: claimants } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    for (const c of claimants ?? []) await supabase.from("intake_submissions").delete().eq("claimant_id", c.id);
    await supabase.from("claimants").delete().eq("last_name", TEST_MARKER);
    for (const id of ambassadorIds) {
      await supabase.from("ambassador_profiles").delete().eq("user_id", id);
      await supabase.from("profiles").delete().eq("user_id", id);
    }
    for (const id of userIds) await supabase.auth.admin.deleteUser(id);
    server.close();
    globalThis.fetch = original;
  }

  const failed = checks.filter(([, passed]) => !passed);
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} passed`);
  console.log(`  Twilio requests: ${sent.length}; DocuSign envelope creates: ${docusign.envelopeCreates}`);
  if (failed.length) throw new Error(`${failed.length} notification check(s) failed`);
}

main()
  .then(() => {
    console.log(
      "\nPASS: admins are told once, and only once the retainer is signed; each patient text reaches only that patient, once, and only when enabled"
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
