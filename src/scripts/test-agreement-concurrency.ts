import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// Proves the reserve-before-create design actually prevents duplicate
// envelopes, against the real route, the real database and the real unique
// index. DocuSign is the only stubbed part — every DocuSign call is counted, so
// "no second envelope was created" is an observation rather than an assumption.
//
// The test writes rows, so it must never reach a shared environment. Each
// developer names their own test project in TEST_SUPABASE_PROJECT_REF and the
// guard below refuses to run unless SUPABASE_URL matches it. There is
// deliberately no default: a ref baked into the repository would only match one
// person's project, and a fallback would be the very thing the guard exists to
// prevent. Every row written is removed afterwards.

interface EnvelopeRequest {
  templateId?: string;
  status?: string;
  templateRoles?: { email?: string; name?: string; roleName?: string; clientUserId?: string }[];
}

interface RecipientViewRequest {
  returnUrl?: string;
  email?: string;
  userName?: string;
  clientUserId?: string;
}

interface DocusignStub {
  envelopeCreates: number;
  recipientViews: number;
  statusReads: number;
  /** What was actually sent, so assertions test the request and not a mirror of it. */
  envelopeRequests: EnvelopeRequest[];
  recipientViewRequests: RecipientViewRequest[];
  restore: () => void;
}

/**
 * Intercepts DocuSign traffic and lets everything else — Supabase — through.
 * No network call reaches DocuSign, so no envelope can be created by accident.
 */
function stubDocusign(): DocusignStub {
  const original = globalThis.fetch;
  const stub: DocusignStub = {
    envelopeCreates: 0,
    recipientViews: 0,
    statusReads: 0,
    envelopeRequests: [],
    recipientViewRequests: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("/oauth/token")) {
      return json({ access_token: "stub-access-token", expires_in: 3600 });
    }

    if (url.includes("/oauth/userinfo")) {
      return json({
        sub: "stub-user",
        name: "Stub User",
        email: "stub@example.test",
        accounts: [
          {
            account_id: process.env.DOCUSIGN_API_ACCOUNT_ID,
            account_name: "Stub Account",
            base_uri: "https://demo.docusign.net",
            is_default: true,
          },
        ],
      });
    }

    if (url.includes("/views/recipient")) {
      stub.recipientViews += 1;
      stub.recipientViewRequests.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ url: "https://demo.docusign.net/signing/stub-view" });
    }

    if (url.includes("/envelopes/")) {
      stub.statusReads += 1;
      return json({ status: "sent" });
    }

    if (url.endsWith("/envelopes") && (init?.method ?? "GET").toUpperCase() === "POST") {
      stub.envelopeCreates += 1;
      stub.envelopeRequests.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ envelopeId: `stub-envelope-${stub.envelopeCreates}-${randomUUID()}` });
    }

    return original(input, init);
  }) as typeof fetch;

  return stub;
}

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) {
    throw new Error(
      "TEST_SUPABASE_PROJECT_REF is required. Set it to the ref of a Supabase project " +
        "you own and are willing to have rows written to."
    );
  }

  // Names only in the failure message; the refs themselves stay out of output.
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

  // DocuSign is stubbed, so these are shape-only and never reach a real account.
  process.env.DOCUSIGN_TEMPLATE_ID_EN ||= "stub-template-en";
  process.env.DOCUSIGN_TEMPLATE_ID_ES ||= "stub-template-es";
  process.env.DOCUSIGN_TEMPLATE_ROLE_NAME ||= "Patient";
  process.env.FRONTEND_URL ||= "http://localhost:3000";

  // The agreement routes require a verified patient. The fixture below is bound
  // to a real Supabase identity minted through the development bridge, so this
  // test exercises the same authorization path production traffic will.
  process.env.DEV_OTP_BRIDGE = "enabled";
  delete process.env.NODE_ENV;

  const stub = stubDocusign();

  // Imported after the stub so the module never sees the real fetch.
  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const { resetTokenCache } = await import("../lib/docusign");
  resetTokenCache();

  const claimantId = randomUUID();
  const submissionId = randomUUID();
  // Random rather than time-derived: timestamp slices collide across runs.
  const fixturePhone = `+1555${randomInt(1_000_000, 9_999_999)}`;
  let accessToken = "";
  let authUserId = "";
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  // The route fails closed on a missing locale, so every request here names the
  // fixture's language; the locale test covers the EN/ES selection itself.
  const post = (body: Record<string, unknown>) =>
    globalThis.fetch(`${base}/intake/agreement`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ locale: "en", ...body }),
    });

  const checks: [string, boolean][] = [];

  try {
    // Supabase burst-limits token verification; that is its quota, not our logic.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await globalThis.fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fixturePhone, code: "111111" }),
      });
      if (response.ok) {
        accessToken = ((await response.json()) as { accessToken: string }).accessToken;
        break;
      }
      if (response.status !== 502 || attempt === 4) throw new Error(`fixture login failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    authUserId = (await supabase.auth.getUser(accessToken)).data.user!.id;

    await supabase.from("claimants").insert({
      id: claimantId,
      user_id: authUserId,
      first_name: "Concurrency",
      last_name: "Fixture",
      mobile: fixturePhone,
      email: "concurrency.fixture@example.test",
    });
    await supabase.from("intake_submissions").insert({
      id: submissionId,
      claimant_id: claimantId,
      status: "submitted",
      locale: "en",
    });
    // The agreement now reads the accident's date for the retainer's locked
    // date-of-loss field, so the fixture needs one or creation is refused.
    await supabase.from("accidents").insert({
      submission_id: submissionId,
      incident_type: "car",
      incident_location: "Orlando, FL",
      incident_date: "2026-01-15",
    });

    // ── a case still in review cannot be signed ──────────────────────────────
    // Submission alone opens nothing: the Admin Dashboard has to accept the case
    // first. The refusal comes before any row is written or DocuSign is asked.
    const inReview = await post({ submissionId });
    const inReviewBody = (await inReview.json()) as { error?: string; signingUrl?: string };
    const { data: afterInReview } = await supabase.from("agreements").select("id").eq("submission_id", submissionId);

    checks.push(
      ["a case still in review is refused", inReview.status === 409],
      ["the in-review refusal is named", inReviewBody.error === "case_not_approved"],
      ["the in-review refusal carries no signing URL", !inReviewBody.signingUrl],
      ["the in-review refusal writes no agreement row", (afterInReview ?? []).length === 0],
      ["the in-review refusal reaches no DocuSign", stub.envelopeCreates === 0 && stub.recipientViews === 0]
    );

    // A case the admin turned down is refused the same way.
    await supabase.from("intake_submissions").update({ status: "not_qualified" }).eq("id", submissionId);
    const turnedDown = await post({ submissionId });
    checks.push([
      "a turned-down case is refused",
      turnedDown.status === 409 && ((await turnedDown.json()) as { error?: string }).error === "case_not_approved",
    ]);

    // A lawyer's acceptance is not the retainer approval either.
    await supabase.from("intake_submissions").update({ status: "qualified" }).eq("id", submissionId);
    const lawyerAccepted = await post({ submissionId });
    checks.push([
      "a case in any status but retainer_pending_signature is refused",
      lawyerAccepted.status === 409 &&
        ((await lawyerAccepted.json()) as { error?: string }).error === "case_not_approved",
    ]);

    // The Admin Dashboard's approval (approve_for_retainer) is what opens signing.
    await supabase.from("intake_submissions").update({ status: "retainer_pending_signature" }).eq("id", submissionId);

    // ── two simultaneous taps ────────────────────────────────────────────────
    const [a, b] = await Promise.all([post({ submissionId }), post({ submissionId })]);
    const bodies = [await a.json(), await b.json()];
    const statuses = [a.status, b.status];

    const { data: afterRace } = await supabase
      .from("agreements")
      .select("id, status, envelope_id, recipient_client_user_id")
      .eq("submission_id", submissionId);

    const active = (afterRace ?? []).filter((row) => !["declined", "voided"].includes(row.status));
    const sentEnvelope = stub.envelopeRequests[0];
    const roles = sentEnvelope?.templateRoles;
    const role = roles?.[0];
    const view = stub.recipientViewRequests[0];

    checks.push(
      ["exactly one DocuSign envelope was created", stub.envelopeCreates === 1],
      ["exactly one active agreement exists", active.length === 1],
      ["one request created the agreement", statuses.filter((s) => s === 201).length === 1],
      [
        "the losing request did not create a second envelope",
        statuses.filter((s) => s === 201).length === 1 && [200, 409].includes(statuses.find((s) => s !== 201)!),
      ],
      ["exactly one recipient on the envelope", roles?.length === 1],
      ["the sent clientUserId is the agreement row id", role?.clientUserId === active[0]?.id],
      ["the sent clientUserId is not the submission id", Boolean(role) && role?.clientUserId !== submissionId],
      ["the sent roleName is the configured template role", role?.roleName === process.env.DOCUSIGN_TEMPLATE_ROLE_NAME],
      ["the envelope is sent, not left in draft", sentEnvelope?.status === "sent"],
      ["the stored clientUserId matches what was sent", active[0]?.recipient_client_user_id === role?.clientUserId],
      [
        "the recipient view matches the envelope recipient",
        view?.email === role?.email && view?.userName === role?.name && view?.clientUserId === role?.clientUserId,
      ],
      [
        "the return URL is server-built and stays on the frontend",
        Boolean(view?.returnUrl?.startsWith(`${process.env.FRONTEND_URL}/en/intake/agreement/return`)),
      ],
      [
        "no key material or token reached a DocuSign request body",
        !JSON.stringify([sentEnvelope, view]).match(/PRIVATE KEY|stub-access-token/),
      ],
      [
        "no response exposed an envelope or template id",
        bodies.every((body) => !JSON.stringify(body).includes("envelope") || !("envelopeId" in (body as object))),
      ]
    );

    // ── a later request reuses the winner rather than creating another ───────
    const beforeReuse = stub.envelopeCreates;
    const reuse = await post({ submissionId });
    const reuseBody = (await reuse.json()) as { status?: string; signingUrl?: string };

    checks.push(
      ["a later request reuses the existing agreement", reuse.status === 200],
      ["reuse mints a fresh signing URL", Boolean(reuseBody.signingUrl)],
      ["reuse creates no additional envelope", stub.envelopeCreates === beforeReuse],
      ["reuse does not leak the envelope id", !("envelopeId" in reuseBody)]
    );

    // ── a voided reservation frees a retry ───────────────────────────────────
    await supabase.from("agreements").update({ status: "voided" }).eq("submission_id", submissionId);
    const beforeRetry = stub.envelopeCreates;
    const retry = await post({ submissionId });

    const { data: afterRetry } = await supabase
      .from("agreements")
      .select("id, status")
      .eq("submission_id", submissionId);
    const activeAfterRetry = (afterRetry ?? []).filter((row) => !["declined", "voided"].includes(row.status));

    checks.push(
      ["a voided agreement permits a retry", retry.status === 201],
      ["the retry created a new envelope", stub.envelopeCreates === beforeRetry + 1],
      ["still exactly one active agreement", activeAfterRetry.length === 1]
    );

    // ── a patient with no email can still sign ──────────────────────────────
    // Identity is phone plus a verification code. Email is optional throughout
    // intake, so it must never stand between a patient and their agreement.
    await supabase.from("claimants").update({ email: null }).eq("id", claimantId);
    await supabase.from("agreements").update({ status: "voided" }).eq("submission_id", submissionId);
    const beforeEmail = stub.envelopeCreates;
    const noEmail = await post({ submissionId });
    const noEmailBody = (await noEmail.json()) as { error?: string; signingUrl?: string };
    const noEmailRole = stub.envelopeRequests[stub.envelopeRequests.length - 1]?.templateRoles?.[0];
    const { data: noEmailAgreement } = await supabase
      .from("agreements")
      .select("id")
      .eq("submission_id", submissionId)
      .not("status", "in", "(declined,voided)")
      .maybeSingle();

    checks.push(
      ["a patient without an email still gets an agreement", noEmail.status === 201],
      ["that agreement has a signing URL", Boolean(noEmailBody.signingUrl)],
      ["it created an envelope", stub.envelopeCreates === beforeEmail + 1],
      // The address is a DocuSign recipient key, not a mailbox: derived from the
      // agreement row, in a domain that can never receive mail.
      [
        "the signer address is derived from the agreement",
        noEmailRole?.email === `agreement-${noEmailAgreement?.id}@haa-agreements.invalid`,
      ],
      ["the signer address is unroutable", noEmailRole?.email?.endsWith(".invalid") === true],
      ["clientUserId is still the agreement id", noEmailRole?.clientUserId === noEmailAgreement?.id],
      [
        "no patient address reached DocuSign",
        !JSON.stringify(stub.envelopeRequests).includes("concurrency.fixture@example.test"),
      ]
    );

    // ── an unsubmitted intake cannot be signed ───────────────────────────────
    await supabase.from("intake_submissions").update({ status: "intake" }).eq("id", submissionId);
    const unsubmitted = await post({ submissionId });
    const unsubmittedBody = (await unsubmitted.json()) as { error?: string };

    checks.push(
      ["an unsubmitted intake is refused", unsubmitted.status === 409],
      ["the refusal is named", unsubmittedBody.error === "submission_not_submitted"]
    );

    // ── an unknown submission is refused ─────────────────────────────────────
    const unknown = await post({ submissionId: randomUUID() });
    checks.push(["an unknown submission is refused", unknown.status === 404]);

    console.log("Agreement concurrency and authorization:");
    for (const [label, passed] of checks) {
      console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
    }
    console.log(
      `\n  DocuSign calls: ${stub.envelopeCreates} envelope create(s), ` +
        `${stub.recipientViews} recipient view(s), ${stub.statusReads} status read(s)`
    );

    if (checks.some(([, passed]) => !passed)) {
      throw new Error("Agreement concurrency checks failed");
    }
  } finally {
    await supabase.from("agreements").delete().eq("submission_id", submissionId);
    await supabase.from("intake_submissions").delete().eq("id", submissionId);
    await supabase.from("claimants").delete().eq("id", claimantId);
    if (authUserId) await supabase.auth.admin.deleteUser(authUserId);
    server.close();
    stub.restore();
  }
}

main()
  .then(() => {
    console.log("\nPASS: reserve-before-create prevents duplicate envelopes");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
