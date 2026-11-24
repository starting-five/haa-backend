import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// The cross-patient security matrix. Two independent authenticated patients,
// each with their own claimant, submission, agreement and evidence, and every
// operation tried in both directions.
//
// DocuSign is stubbed: this proves authorization, and a denied request must not
// reach DocuSign at all — which is itself asserted by counting the calls.
//
// Nothing here trusts source reading. Every claim is an observation from a real
// HTTP request or a database read afterwards.

/** Stamped on every claimant this suite creates, so its own leftovers are recognisable. */
const TEST_MARKER = "IsolationSuite";

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

interface DocusignStub {
  envelopeCreates: number;
  recipientViews: number;
  /** What GET /envelopes/{id} reports, so completion can be driven on demand. */
  envelopeStatus: string;
  /** How often the signed PDF was fetched — the duplicate-work check. */
  documentDownloads: number;
  restore: () => void;
}

function stubDocusign(): DocusignStub {
  const original = globalThis.fetch;
  const stub: DocusignStub = {
    envelopeCreates: 0,
    recipientViews: 0,
    envelopeStatus: "sent",
    documentDownloads: 0,
    restore: () => {
      globalThis.fetch = original;
    },
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/oauth/token")) return json({ access_token: "stub", expires_in: 3600 });
    if (url.includes("/oauth/userinfo"))
      return json({
        sub: "stub",
        name: "Stub",
        email: "stub@example.test",
        accounts: [
          {
            account_id: process.env.DOCUSIGN_API_ACCOUNT_ID,
            account_name: "Stub",
            base_uri: "https://demo.docusign.net",
            is_default: true,
          },
        ],
      });
    if (url.includes("/views/recipient")) {
      stub.recipientViews += 1;
      return json({ url: "https://demo.docusign.net/signing/stub" });
    }
    if (url.includes("/documents/combined")) {
      stub.documentDownloads += 1;
      // A minimal but real PDF, so what lands in Storage is a genuine object.
      return new Response(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 37, 69, 79, 70, 10]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.includes("/envelopes/")) return json({ status: stub.envelopeStatus });
    if (url.endsWith("/envelopes") && (init?.method ?? "GET").toUpperCase() === "POST") {
      stub.envelopeCreates += 1;
      return json({ envelopeId: `stub-${stub.envelopeCreates}-${randomInt(1e6, 9e6)}` });
    }
    return original(input, init);
  }) as typeof fetch;

  return stub;
}

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
  process.env.DOCUSIGN_TEMPLATE_ID_EN ||= "stub-template-en";
  process.env.DOCUSIGN_TEMPLATE_ID_ES ||= "stub-template-es";
  process.env.DOCUSIGN_TEMPLATE_ROLE_NAME ||= "Patient";
  process.env.FRONTEND_URL ||= "http://localhost:3000";

  const stub = stubDocusign();
  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const { resetTokenCache } = await import("../lib/docusign");
  resetTokenCache();

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const phones = new Set<string>();
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

  const auth = (token: string | null) => (token ? { Authorization: `Bearer ${token}` } : {});

  /** Never throws: a 500 serves an HTML page, and that must fail a check, not the run. */
  const body = async <T>(response: Response): Promise<Partial<T>> => {
    try {
      return (await response.clone().json()) as Partial<T>;
    } catch {
      return {};
    }
  };
  // The route refuses a request without a locale before it looks at identity,
  // so every create here names one; test-agreement-locale covers the choice.
  const agreementPost = (token: string | null, submissionId: string) =>
    fetch(`${base}/intake/agreement`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({ submissionId, locale: "en" }),
    });
  type DashboardCase = { submissionId: string; agreementStatus: string | null; awaitingSignature: boolean };
  const dashboardCases = async (token: string | null): Promise<DashboardCase[] | null> => {
    const response = await fetch(`${base}/patient/dashboard`, { headers: auth(token) });
    if (!response.ok) return null;
    return (await body<{ cases: DashboardCase[] }>(response)).cases ?? null;
  };
  const agreementGet = (token: string | null, submissionId: string) =>
    fetch(`${base}/intake/agreement/${submissionId}`, { headers: auth(token) });
  const uploadUrl = (
    token: string | null,
    submissionId: string,
    fileName = "evidence.pdf",
    category = "accidentReport"
  ) =>
    fetch(`${base}/intake/documents/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({ submissionId, fileName, category }),
    });

  const caseGet = (token: string | null, submissionId: string) =>
    fetch(`${base}/case/${submissionId}`, { headers: auth(token) });
  const complete = (token: string | null, submissionId: string, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/intake/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({
        submissionId,
        claimant: { residence: "Rewritten by the caller" },
        accident: { role: "passenger", description: "Rewritten by the caller" },
        treatmentArea: "Rewritten by the caller",
        documents: [],
        ...extra,
      }),
    });
  const portalGet = (token: string | null) => fetch(`${base}/portal/submissions`, { headers: auth(token) });
  const portalProfile = (token: string | null) =>
    fetch(`${base}/portal/lawyer/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({ firstName: "Not", lastName: "ALawyer" }),
    });

  /** Everything an unauthorized request could plausibly alter, for the before/after proof. */
  const snapshot = async (submissionId: string, claimantId: string) => {
    const [submission, accident, claimant, documents, companions] = await Promise.all([
      supabase.from("intake_submissions").select("*").eq("id", submissionId).maybeSingle(),
      supabase.from("accidents").select("*").eq("submission_id", submissionId).maybeSingle(),
      supabase.from("claimants").select("*").eq("id", claimantId).maybeSingle(),
      supabase.from("documents").select("*").eq("submission_id", submissionId),
      supabase.from("submission_companions").select("*").eq("submission_id", submissionId),
    ]);
    return JSON.stringify({
      submission: submission.data,
      accident: accident.data,
      claimant: claimant.data,
      documents: documents.data,
      companions: companions.data,
    });
  };

  /**
   * Removes one claimant and everything hanging off it, in dependency order.
   * Used both for this run's rows and for any a previous crashed run stranded —
   * a hard exit can bypass the teardown below, and identities must not pile up.
   */
  const removeClaimant = async (claimantId: string) => {
    const { data: submissions } = await supabase.from("intake_submissions").select("id").eq("claimant_id", claimantId);
    for (const submission of submissions ?? []) {
      const { data: folders } = await supabase.storage.from("submissions").list(submission.id, { limit: 100 });
      for (const folder of folders ?? []) {
        const { data: files } = await supabase.storage
          .from("submissions")
          .list(`${submission.id}/${folder.name}`, { limit: 100 });
        for (const file of files ?? []) {
          await supabase.storage.from("submissions").remove([`${submission.id}/${folder.name}/${file.name}`]);
        }
      }
      const { data: signed } = await supabase.storage.from("agreements").list(submission.id, { limit: 100 });
      for (const object of signed ?? []) {
        await supabase.storage.from("agreements").remove([`${submission.id}/${object.name}`]);
      }
      await supabase.from("agreements").delete().eq("submission_id", submission.id);
      await supabase.from("submission_companions").delete().eq("submission_id", submission.id);
      await supabase.from("documents").delete().eq("submission_id", submission.id);
      await supabase.from("accidents").delete().eq("submission_id", submission.id);
      await supabase.from("intake_submissions").delete().eq("id", submission.id);
    }
    await supabase.from("claimants").delete().eq("id", claimantId);
  };

  /** Only rows carrying this suite's marker; nothing else in the project is touched. */
  const sweepStrandedRows = async () => {
    const { data: stranded } = await supabase.from("claimants").select("id, user_id").eq("last_name", TEST_MARKER);
    for (const claimant of stranded ?? []) {
      await removeClaimant(claimant.id);
      if (claimant.user_id) await supabase.auth.admin.deleteUser(claimant.user_id);
    }
    return (stranded ?? []).length;
  };

  const strandedBefore = await sweepStrandedRows();
  if (strandedBefore > 0) console.log(`  (cleared ${strandedBefore} row(s) stranded by an earlier run)\n`);

  const makePatient = async (label: string, submit = true) => {
    const phone = newPhone();
    const token = await login(phone);
    const started = await fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token) },
      body: JSON.stringify({
        locale: "en",
        claimant: { firstName: label, lastName: TEST_MARKER, mobile: phone },
        accident: { incidentType: "car", incidentLocation: "San Diego, CA", incidentDate: "2026-09-05" },
      }),
    });
    const { submissionId } = (await body<{ submissionId: string }>(started)) as { submissionId: string };
    const { data: claimantRow } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
    // Scaffolding: agreements require a submitted case, and /intake/complete is
    // a separate route outside this phase's scope.
    if (submit) await supabase.from("intake_submissions").update({ status: "submitted" }).eq("id", submissionId);
    await supabase
      .from("claimants")
      .update({ email: `${label.toLowerCase()}@example.test` })
      .eq("mobile", phone);
    return { phone, token, submissionId, claimantId: claimantRow!.id };
  };

  try {
    const A = await makePatient("PatientA");
    const B = await makePatient("PatientB");
    record("two independent patients were created", A.submissionId !== B.submissionId);

    // ── authentication is required at all ───────────────────────────────────
    record("agreement GET without a token is denied", (await agreementGet(null, A.submissionId)).status === 401);
    record("agreement POST without a token is denied", (await agreementPost(null, A.submissionId)).status === 401);
    record("upload URL without a token is denied", (await uploadUrl(null, A.submissionId)).status === 401);
    record("a malformed token is denied", (await agreementGet("Bearer-nonsense", A.submissionId)).status === 401);
    record("an invalid JWT is denied", (await agreementGet("a.b.c", A.submissionId)).status === 401);

    // ── negative matrix, checked before anything legitimate exists ──────────
    const beforeEnvelopes = stub.envelopeCreates;

    const aReadsB = await agreementGet(A.token, B.submissionId);
    const bReadsA = await agreementGet(B.token, A.submissionId);
    record("A reading B's agreement is denied", aReadsB.status === 404);
    record("B reading A's agreement is denied", bReadsA.status === 404);
    record(
      "a denied read leaks no envelope or submission detail",
      !/envelope|claimant|recipient/i.test(await aReadsB.text())
    );

    const aCreatesForB = await agreementPost(A.token, B.submissionId);
    const bCreatesForA = await agreementPost(B.token, A.submissionId);
    record("A creating an agreement on B's submission is denied", aCreatesForB.status === 404);
    record("B creating an agreement on A's submission is denied", bCreatesForA.status === 404);
    record("a denied create never reaches DocuSign", stub.envelopeCreates === beforeEnvelopes);

    const { data: agreementsAfterDenial } = await supabase.from("agreements").select("id, submission_id");
    const strayForB = (agreementsAfterDenial ?? []).filter((row) => row.submission_id === B.submissionId);
    const strayForA = (agreementsAfterDenial ?? []).filter((row) => row.submission_id === A.submissionId);
    record("a denied create leaves no agreement row for B", strayForB.length === 0);
    record("a denied create leaves no agreement row for A", strayForA.length === 0);

    const C = await makePatient("PatientC", false);
    const aReadsUnsubmittedC = await agreementGet(A.token, C.submissionId);
    const aCreatesForUnsubmittedC = await agreementPost(A.token, C.submissionId);
    const aReadsNothing = await agreementGet(A.token, randomUUID());
    record("a foreign half-finished case answers as not found, not as unsubmitted", aReadsUnsubmittedC.status === 404);
    record("creating on a foreign half-finished case answers as not found", aCreatesForUnsubmittedC.status === 404);
    record("a submission that does not exist answers identically", aReadsNothing.status === 404);
    record(
      "the three answers are indistinguishable",
      (await aReadsUnsubmittedC.text()) === (await aReadsNothing.text())
    );
    // The owner of that same half-finished case is told the real reason.
    record(
      "its own owner is told it is not submitted yet",
      (await agreementPost(C.token, C.submissionId)).status === 409
    );

    const aUploadsToB = await uploadUrl(A.token, B.submissionId);
    const bUploadsToA = await uploadUrl(B.token, A.submissionId);
    record("A obtaining an upload URL for B is denied", aUploadsToB.status === 404);
    record("B obtaining an upload URL for A is denied", bUploadsToA.status === 404);
    record("a denied upload request returns no token", !(await aUploadsToB.text()).includes("token"));

    // ── the legitimate owner still works ────────────────────────────────────
    const aOwnUpload = await uploadUrl(A.token, A.submissionId);
    const aOwnUploadBody = await body<{ storagePath: string; token: string }>(aOwnUpload);
    record("A obtaining their own upload URL is allowed", aOwnUpload.status === 200 && Boolean(aOwnUploadBody.token));
    record(
      "the storage key is scoped to A's own submission",
      Boolean(aOwnUploadBody.storagePath?.startsWith(`${A.submissionId}/`))
    );

    const bOwnUpload = await uploadUrl(B.token, B.submissionId);
    record("B obtaining their own upload URL is allowed", bOwnUpload.status === 200);

    // ── a case still in review cannot be signed, even by its owner ──────────
    const envelopesBeforeReview = stub.envelopeCreates;
    const aInReview = await agreementPost(A.token, A.submissionId);
    const aInReviewBody = await body<{ error?: string }>(aInReview);
    record(
      "A signing their own case while it is in review is refused",
      aInReview.status === 409 && aInReviewBody.error === "case_not_approved"
    );
    record("a refused in-review create never reaches DocuSign", stub.envelopeCreates === envelopesBeforeReview);
    const { data: aRowsInReview } = await supabase.from("agreements").select("id").eq("submission_id", A.submissionId);
    record("a refused in-review create leaves no agreement row", (aRowsInReview ?? []).length === 0);
    record(
      "A can still read that nothing has been signed yet",
      (await agreementGet(A.token, A.submissionId)).status === 404
    );

    // ── the dashboard reports the same rule, for the caller's own case only ─
    record("the dashboard without a token is denied", (await dashboardCases(null)) === null);
    const aInReviewCases = await dashboardCases(A.token);
    record(
      "A's dashboard holds A's case alone",
      aInReviewCases?.length === 1 && aInReviewCases[0]?.submissionId === A.submissionId
    );
    record(
      "a case in review is not waiting for a signature",
      aInReviewCases?.[0]?.awaitingSignature === false && aInReviewCases[0]?.agreementStatus === null
    );

    // Scaffolding: the Admin Dashboard's approval (approve_for_retainer) is what opens
    // signing. portal/review-decision has its own tests.
    await supabase
      .from("intake_submissions")
      .update({ status: "retainer_pending_signature" })
      .in("id", [A.submissionId, B.submissionId]);

    const aCreatesForApprovedB = await agreementPost(A.token, B.submissionId);
    record("A creating on B's approved case is still not found", aCreatesForApprovedB.status === 404);

    const aAcceptedCases = await dashboardCases(A.token);
    record("an approved, unsigned case is waiting for a signature", aAcceptedCases?.[0]?.awaitingSignature === true);
    record(
      "B's approved case is not on A's dashboard",
      !(aAcceptedCases ?? []).some((c) => c.submissionId === B.submissionId)
    );

    const aOwnCreate = await agreementPost(A.token, A.submissionId);
    record("A creating their own agreement is allowed", aOwnCreate.status === 201);
    record(
      "the dashboard reports the sent agreement",
      (await dashboardCases(A.token))?.[0]?.agreementStatus === "sent"
    );
    const bOwnCreate = await agreementPost(B.token, B.submissionId);
    record("B creating their own agreement is allowed", bOwnCreate.status === 201);

    const aOwnRead = await agreementGet(A.token, A.submissionId);
    record("A reading their own agreement is allowed", aOwnRead.status === 200);
    record("B reading their own agreement is allowed", (await agreementGet(B.token, B.submissionId)).status === 200);
    record("the owner's read exposes no envelope id", !(await aOwnRead.text()).includes("envelope"));

    // ── with agreements now existing, retry the cross-patient reads ─────────
    record("A still cannot read B's existing agreement", (await agreementGet(A.token, B.submissionId)).status === 404);
    record("B still cannot read A's existing agreement", (await agreementGet(B.token, A.submissionId)).status === 404);

    const envelopesBeforeCrossCreate = stub.envelopeCreates;
    await agreementPost(A.token, B.submissionId);
    record("a cross-patient create still reaches no DocuSign", stub.envelopeCreates === envelopesBeforeCrossCreate);

    const { data: bAgreements } = await supabase.from("agreements").select("id").eq("submission_id", B.submissionId);
    record("B still has exactly one agreement", (bAgreements ?? []).length === 1);

    // ── a storage key cannot be steered out of its namespace ────────────────
    const traversal = await uploadUrl(A.token, A.submissionId, "../../escape.pdf", "../../elsewhere");
    const traversalBody = await body<{ storagePath: string }>(traversal);
    record(
      "traversal in the file name and category cannot escape the submission",
      traversal.status === 200 &&
        Boolean(traversalBody.storagePath?.startsWith(`${A.submissionId}/`)) &&
        !traversalBody.storagePath?.includes("..")
    );

    const forgedPath = await fetch(`${base}/intake/documents/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(A.token) },
      body: JSON.stringify({
        submissionId: A.submissionId,
        fileName: "x.pdf",
        category: "accidentReport",
        storagePath: `${B.submissionId}/accidentReport/stolen.pdf`,
      }),
    });
    const forgedPathBody = await body<{ storagePath: string }>(forgedPath);
    record(
      "a storagePath supplied by the caller is ignored",
      Boolean(forgedPathBody.storagePath?.startsWith(`${A.submissionId}/`))
    );

    // ── GET /case/:submissionId ─────────────────────────────────────────────
    // It carries the patient's first name and where they were hurt, so it is
    // owned data rather than a public status page.
    record("A reading their own case is allowed", (await caseGet(A.token, A.submissionId)).status === 200);
    record("A reading B's case is denied", (await caseGet(A.token, B.submissionId)).status === 404);
    record("B reading A's case is denied", (await caseGet(B.token, A.submissionId)).status === 404);
    record("reading a case without a token is denied", (await caseGet(null, A.submissionId)).status === 401);
    record("reading a case with an invalid token is denied", (await caseGet("a.b.c", A.submissionId)).status === 401);

    const ownCase = await caseGet(A.token, A.submissionId);
    const ownCaseBody = await body<{ firstName: string }>(ownCase);
    record("the case answers with the caller's own name", ownCaseBody.firstName === "PatientA");

    const foreignCase = await caseGet(A.token, B.submissionId);
    record("a denied case read leaks no name", !(await foreignCase.text()).includes("PatientB"));

    // ── POST /intake/complete ───────────────────────────────────────────────
    // The most damaging route in the audit: it rewrites the claimant, the
    // accident and the submission's status in one pass.
    const beforeC = await snapshot(C.submissionId, C.claimantId);
    const aCompletesC = await complete(A.token, C.submissionId);
    const afterC = await snapshot(C.submissionId, C.claimantId);
    record("A completing C's intake is denied", aCompletesC.status === 404);
    record("the denied completion changed nothing at all", beforeC === afterC);

    const anonCompletesC = await complete(null, C.submissionId);
    record("completing an intake without a token is denied", anonCompletesC.status === 401);
    record("the anonymous attempt changed nothing at all", (await snapshot(C.submissionId, C.claimantId)) === beforeC);

    const bCompletesA = await complete(B.token, A.submissionId);
    const afterA = await snapshot(A.submissionId, A.claimantId);
    record("B completing A's intake is denied", bCompletesA.status === 404);

    // Evidence metadata naming another patient's object is refused even for the
    // owner, so a case cannot be made to carry someone else's evidence.
    const foreignEvidence = await complete(C.token, C.submissionId, {
      documents: [{ storagePath: `${A.submissionId}/accidentReport/stolen.pdf`, fileName: "stolen.pdf" }],
    });
    record("evidence pointing outside the submission is refused", foreignEvidence.status === 403);
    record("that refusal left the submission untouched", (await snapshot(C.submissionId, C.claimantId)) === beforeC);

    // The owner completing their own intake still works.
    const cCompletesC = await complete(C.token, C.submissionId);
    const { data: cAfter } = await supabase
      .from("intake_submissions")
      .select("status")
      .eq("id", C.submissionId)
      .maybeSingle();
    record("C completing their own intake is allowed", cCompletesC.status === 200);
    record("the owner's completion marks it submitted", cAfter?.status === "submitted");
    record(
      "A's submission was never altered by any of this",
      (await snapshot(A.submissionId, A.claimantId)) === afterA
    );

    // A case the Admin Dashboard has decided on keeps the facts it was decided
    // and signed on; completing it again would put it back in review.
    const aRecompletes = await complete(A.token, A.submissionId);
    const { data: aAfterRecomplete } = await supabase
      .from("intake_submissions")
      .select("status")
      .eq("id", A.submissionId)
      .maybeSingle();
    record(
      "completing an approved case again is refused",
      aRecompletes.status === 409 && (await body<{ error: string }>(aRecompletes)).error === "case_already_reviewed"
    );
    record("the approved case stays approved", aAfterRecomplete?.status === "retainer_pending_signature");
    record("the refused completion changed nothing", (await snapshot(A.submissionId, A.claimantId)) === afterA);

    // ── nothing in the body may nominate whose case is acted on ─────────────
    const { data: aUser } = await supabase.auth.getUser(A.token);
    const beforeB = await snapshot(B.submissionId, B.claimantId);

    // C's own submission id — still waiting for review, so it may be completed
    // again — but every ownership identifier points at B.
    const forgedOwnership = await complete(C.token, C.submissionId, {
      claimantId: B.claimantId,
      claimant_id: B.claimantId,
      userId: (await supabase.auth.getUser(B.token)).data.user?.id,
      user_id: (await supabase.auth.getUser(B.token)).data.user?.id,
    });
    record("forged ownership identifiers do not change who is acted on", forgedOwnership.status === 200);
    record("B was untouched by A's forged identifiers", (await snapshot(B.submissionId, B.claimantId)) === beforeB);

    // B's submission id with A's own claimant id attached, the other way round.
    const forgedTarget = await complete(A.token, B.submissionId, {
      claimantId: A.claimantId,
      claimant_id: A.claimantId,
      user_id: aUser.user?.id,
    });
    record("a foreign submission id is still refused when paired with own ids", forgedTarget.status === 404);
    record("B was untouched by that attempt too", (await snapshot(B.submissionId, B.claimantId)) === beforeB);

    // The natural forgery: B's submission paired with B's own claimant id, so
    // every identifier in the request agrees with itself and only the session
    // disagrees.
    const fullyForged = await complete(A.token, B.submissionId, {
      claimantId: B.claimantId,
      claimant_id: B.claimantId,
    });
    record("a self-consistent forged identity is still refused", fullyForged.status === 404);
    record("B survived the self-consistent forgery", (await snapshot(B.submissionId, B.claimantId)) === beforeB);

    const forgedCase = await caseGet(A.token, B.submissionId);
    record("a forged case read is refused", forgedCase.status === 404);

    // ── portal routes are a different actor ─────────────────────────────────
    // A patient's session satisfies requireAuth. Without an actor check it also
    // reads every patient's name, phone, email and address.
    record("a patient session cannot list portal submissions", (await portalGet(A.token)).status === 403);
    record("a patient session cannot self-register as a lawyer", (await portalProfile(A.token)).status === 403);
    record("the portal still refuses an anonymous caller", (await portalGet(null)).status === 401);
    const { data: lawyerRows } = await supabase.from("lawyers").select("user_id");
    const { data: patientUsers } = await supabase.from("claimants").select("user_id").not("user_id", "is", null);
    const patientIds = new Set((patientUsers ?? []).map((r) => r.user_id));
    record(
      "no patient ended up in the lawyers table",
      (lawyerRows ?? []).every((r) => !patientIds.has(r.user_id))
    );

    // ── the capability itself, exercised against real Storage ───────────────
    // Each patient writes only inside their own namespace, so nothing here can
    // touch an object belonging to another test.
    const signedPut = (path: string, token: string) =>
      fetch(`${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/submissions/${path}?token=${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: new Blob([new Uint8Array([37, 80, 68, 70])]),
      });

    const aWrite = await signedPut(aOwnUploadBody.storagePath!, aOwnUploadBody.token!);
    record("A's own token writes A's own object", aWrite.status === 200);

    // The same capability aimed at B's namespace. The token is signed over the
    // object path, so re-pointing it invalidates it.
    const stolenPath = `${B.submissionId}/accidentReport/stolen.pdf`;
    const aWritesIntoB = await signedPut(stolenPath, aOwnUploadBody.token!);
    record("A's token cannot be replayed against B's namespace", aWritesIntoB.status >= 400);

    const { data: bObjects } = await supabase.storage.from("submissions").list(`${B.submissionId}/accidentReport`);
    record("nothing was written into B's namespace", (bObjects ?? []).length === 0);

    // Two uploads of the same file name must not land on the same object: a
    // patient re-attaching IMG_0001.jpg from a different source used to
    // silently replace the first one.
    const firstToken = await uploadUrl(A.token, A.submissionId, "IMG_0001.jpg");
    const secondToken = await uploadUrl(A.token, A.submissionId, "IMG_0001.jpg");
    const firstKey = (await body<{ storagePath: string; token: string }>(firstToken)).storagePath;
    const secondBody = await body<{ storagePath: string; token: string }>(secondToken);
    record(
      "the same file name yields two different object keys",
      Boolean(firstKey) && firstKey !== secondBody.storagePath
    );
    record("both keys stay inside the submission", Boolean(secondBody.storagePath?.startsWith(`${A.submissionId}/`)));
    record("the extension survives the uniquifier", Boolean(secondBody.storagePath?.endsWith(".jpg")));

    await signedPut(secondBody.storagePath!, secondBody.token!);
    // A token cannot be replayed to replace what it just wrote, either.
    const replaySameKey = await signedPut(secondBody.storagePath!, secondBody.token!);
    record("a token cannot overwrite the object it created", replaySameKey.status >= 400);

    const anonRead = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/submissions/${aOwnUploadBody.storagePath}`
    );
    record("an anonymous read of A's object is refused", anonRead.status >= 400);

    // ── the signed agreement is retrieved and kept, exactly once ────────────
    const { data: aAgreementRow } = await supabase
      .from("agreements")
      .select("id")
      .eq("submission_id", A.submissionId)
      .maybeSingle();
    const agreementId = aAgreementRow!.id;

    stub.envelopeStatus = "completed";
    const downloadsBefore = stub.documentDownloads;

    const firstSettle = await agreementGet(A.token, A.submissionId);
    record(
      "the owner is told the agreement completed",
      (await body<{ status: string }>(firstSettle)).status === "completed"
    );

    const { data: afterFirst } = await supabase
      .from("agreements")
      .select("status, completed_at, signed_document_path")
      .eq("id", agreementId)
      .maybeSingle();
    record("status is stored as completed", afterFirst?.status === "completed");
    record("completed_at is populated", Boolean(afterFirst?.completed_at));
    record("the signed document path is recorded", Boolean(afterFirst?.signed_document_path));
    record(
      "the path is derived from submission and agreement",
      afterFirst?.signed_document_path === `${A.submissionId}/${agreementId}.pdf`
    );
    record("the signed document was fetched once", stub.documentDownloads === downloadsBefore + 1);

    const aSignedCases = await dashboardCases(A.token);
    record(
      "a signed case is no longer waiting for a signature",
      aSignedCases?.[0]?.awaitingSignature === false && aSignedCases[0]?.agreementStatus === "completed"
    );
    const { data: aSignedRow } = await supabase
      .from("intake_submissions")
      .select("status")
      .eq("id", A.submissionId)
      .maybeSingle();
    // Signed, then handed straight to a lawyer (lib/lawyer-handoff.ts).
    record("completion moves the approved case on to the lawyer", aSignedRow?.status === "attorney");
    const aSecondSession = await agreementPost(A.token, A.submissionId);
    record(
      "a signed case opens no second signing session",
      aSecondSession.status === 409 && (await body<{ error?: string }>(aSecondSession)).error === "case_not_approved"
    );

    // A completed agreement on a case the admin never approved — one signed
    // before this lifecycle — does not carry it to signed.
    await supabase.from("agreements").insert({
      submission_id: C.submissionId,
      envelope_id: `isolation-legacy-${randomUUID()}`,
      status: "completed",
      locale: "en",
      signed_document_path: `${C.submissionId}/legacy.pdf`,
      completed_at: new Date().toISOString(),
    });
    const legacyRead = await agreementGet(C.token, C.submissionId);
    const { data: cLegacyRow } = await supabase
      .from("intake_submissions")
      .select("status")
      .eq("id", C.submissionId)
      .maybeSingle();
    record(
      "a completed agreement without approval leaves the case in review",
      legacyRead.status === 200 && cLegacyRow?.status === "submitted"
    );

    const storedPath = afterFirst!.signed_document_path as string;
    const { data: storedList } = await supabase.storage.from("agreements").list(A.submissionId, { limit: 100 });
    record("exactly one signed agreement object exists", (storedList ?? []).length === 1);

    // Reconciling again — a refresh, a re-opened return route — must not repeat
    // the work or produce a second object.
    await agreementGet(A.token, A.submissionId);
    await agreementGet(A.token, A.submissionId);
    const { data: listAfterRepeat } = await supabase.storage.from("agreements").list(A.submissionId, { limit: 100 });
    record("repeat reconciliation stores no second object", (listAfterRepeat ?? []).length === 1);
    record("repeat reconciliation downloads nothing more", stub.documentDownloads === downloadsBefore + 1);
    const { data: agreementsForA } = await supabase.from("agreements").select("id").eq("submission_id", A.submissionId);
    record("repeat reconciliation creates no second agreement", (agreementsForA ?? []).length === 1);

    // A retrieval that failed leaves a completed agreement with no document.
    // Reconciling again must repair that, or the record is lost silently.
    await supabase.storage.from("agreements").remove([storedPath]);
    await supabase.from("agreements").update({ signed_document_path: null }).eq("id", agreementId);
    const downloadsBeforeRepair = stub.documentDownloads;

    await agreementGet(A.token, A.submissionId);
    const { data: repaired } = await supabase
      .from("agreements")
      .select("signed_document_path")
      .eq("id", agreementId)
      .maybeSingle();
    const { data: repairedList } = await supabase.storage.from("agreements").list(A.submissionId, { limit: 100 });
    record(
      "a missing signed document is retrieved on the next reconciliation",
      repaired?.signed_document_path === storedPath
    );
    record("the repair fetched the document again", stub.documentDownloads === downloadsBeforeRepair + 1);
    record("the repair leaves exactly one object", (repairedList ?? []).length === 1);

    // And once repaired, further reconciliation is inert again.
    const downloadsAfterRepair = stub.documentDownloads;
    await agreementGet(A.token, A.submissionId);
    record("a repaired agreement is not fetched again", stub.documentDownloads === downloadsAfterRepair);

    // Two reconciliations racing on a completed agreement with no stored
    // document — a refresh landing on top of the return route's poll. Both may
    // pass the route's check before either writes, so the library re-reads and
    // the upload refuses to replace: one object, one recorded path.
    await supabase.storage.from("agreements").remove([storedPath]);
    await supabase.from("agreements").update({ signed_document_path: null }).eq("id", agreementId);
    await Promise.all([agreementGet(A.token, A.submissionId), agreementGet(A.token, A.submissionId)]);
    const { data: racedList } = await supabase.storage.from("agreements").list(A.submissionId, { limit: 100 });
    const { data: racedRow } = await supabase
      .from("agreements")
      .select("signed_document_path")
      .eq("id", agreementId)
      .maybeSingle();
    record("a raced reconciliation leaves exactly one object", (racedList ?? []).length === 1);
    record("a raced reconciliation records the path once", racedRow?.signed_document_path === storedPath);

    // ── the signed agreement is private and patient-scoped ──────────────────
    const anonAgreementRead = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/agreements/${storedPath}`);
    record("an anonymous read of the signed agreement is refused", anonAgreementRead.status >= 400);

    const bReadsAStored = await agreementGet(B.token, A.submissionId);
    record("B still cannot reach A's completed agreement", bReadsAStored.status === 404);
    record(
      "no response ever carried the storage path",
      !(await body<Record<string, unknown>>(firstSettle)).hasOwnProperty("signedDocumentPath") &&
        !(await firstSettle.clone().text()).includes(storedPath)
    );

    stub.envelopeStatus = "sent";

    // ── concurrency ─────────────────────────────────────────────────────────
    const raceEnvelopesBefore = stub.envelopeCreates;
    await Promise.all([agreementPost(A.token, A.submissionId), agreementPost(A.token, A.submissionId)]);
    const { data: aAgreements } = await supabase
      .from("agreements")
      .select("id, status")
      .eq("submission_id", A.submissionId);
    const activeForA = (aAgreements ?? []).filter((row) => !["declined", "voided"].includes(row.status));
    record("concurrent creates by the owner leave one active agreement", activeForA.length === 1);
    record("concurrent creates by the owner make no extra envelope", stub.envelopeCreates === raceEnvelopesBefore);

    const contested = await Promise.all([
      agreementPost(A.token, A.submissionId),
      agreementPost(B.token, A.submissionId),
    ]);
    record("in a contested race only the owner is served", contested[1].status === 404);
    const { data: contestedRows } = await supabase.from("agreements").select("id").eq("submission_id", A.submissionId);
    record("a contested race creates no second agreement", (contestedRows ?? []).length === 1);
  } finally {
    server.close();
    stub.restore();

    for (const phone of phones) {
      const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
      if (claimant) await removeClaimant(claimant.id);

      const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const user of users.users ?? []) {
        if (user.phone === phone.replace("+", "")) await supabase.auth.admin.deleteUser(user.id);
      }
    }

    let leftovers = 0;
    for (const phone of phones) {
      const { data } = await supabase.from("claimants").select("id").eq("mobile", phone);
      leftovers += (data ?? []).length;
    }
    const { data: marked } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    record("every record created by this test was removed", leftovers === 0 && (marked ?? []).length === 0);
  }

  console.log("Cross-patient isolation:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} isolation check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: a patient reaches only their own case");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
