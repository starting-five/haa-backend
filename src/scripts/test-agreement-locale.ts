import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// Proves agreement selection and reuse are locale-aware, against the real route,
// the real database and the real unique index. DocuSign is stubbed so the
// template id each envelope is created from is captured rather than sent, and no
// envelope reaches a real account.
//
// The two templates are given distinct stub ids, so "the Spanish request used
// the Spanish template" is an observation of what the route actually sent. The
// regression this guards: a previously created EN agreement must never be
// returned for an ES request, and vice versa, while a same-language re-request
// still reuses its envelope rather than creating a second one.
//
// Writes rows, so it refuses to run unless SUPABASE_URL matches the project named
// in TEST_SUPABASE_PROJECT_REF. Every row it writes is removed afterwards.

const EN_TEMPLATE = "stub-template-en";
const ES_TEMPLATE = "stub-template-es";

interface EnvelopeRequest {
  templateId?: string;
}

interface DocusignStub {
  envelopeCreates: number;
  recipientViews: number;
  envelopeRequests: EnvelopeRequest[];
  restore: () => void;
}

/** Intercepts DocuSign traffic and lets Supabase through, counting every create. */
function stubDocusign(): DocusignStub {
  const original = globalThis.fetch;
  const stub: DocusignStub = {
    envelopeCreates: 0,
    recipientViews: 0,
    envelopeRequests: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/oauth/token")) return json({ access_token: "stub-access-token", expires_in: 3600 });
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
      return json({ url: "https://demo.docusign.net/signing/stub-view" });
    }
    if (url.endsWith("/envelopes") && method === "POST") {
      stub.envelopeCreates += 1;
      stub.envelopeRequests.push(JSON.parse(String(init?.body ?? "{}")) as EnvelopeRequest);
      return json({ envelopeId: `stub-envelope-${stub.envelopeCreates}-${randomUUID()}` });
    }
    // Any other /envelopes/... call (status read, or the best-effort signing-date
    // refresh on reuse) — a shape that makes the refresh a harmless no-op.
    if (url.includes("/envelopes/")) return json({ status: "sent" });
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

  // Two distinct stub templates, so the assertions can tell EN from ES.
  process.env.DOCUSIGN_TEMPLATE_ID_EN = EN_TEMPLATE;
  process.env.DOCUSIGN_TEMPLATE_ID_ES = ES_TEMPLATE;
  process.env.DOCUSIGN_TEMPLATE_ROLE_NAME ||= "Patient";
  process.env.FRONTEND_URL ||= "http://localhost:3000";
  process.env.DEV_OTP_BRIDGE = "enabled";
  delete process.env.NODE_ENV;

  const stub = stubDocusign();

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const { resetTokenCache } = await import("../lib/docusign");
  resetTokenCache();

  const claimantId = randomUUID();
  const submissionId = randomUUID();
  const fixturePhone = `+1555${randomInt(1_000_000, 9_999_999)}`;
  let accessToken = "";
  let authUserId = "";

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const postAgreement = (body: unknown) =>
    globalThis.fetch(`${base}/intake/agreement`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });

  const activeAgreement = async () => {
    const { data } = await supabase
      .from("agreements")
      .select("id, status, locale, envelope_id")
      .eq("submission_id", submissionId)
      .not("status", "in", "(declined,voided)")
      .maybeSingle();
    return data;
  };
  const lastTemplate = () => stub.envelopeRequests[stub.envelopeRequests.length - 1]?.templateId;

  const checks: [string, boolean][] = [];

  try {
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
      first_name: "Locale",
      last_name: "Fixture",
      mobile: fixturePhone,
      email: "locale.fixture@example.test",
    });
    // Seeded English deliberately, to prove the request locale — not the stored
    // one — is what selects the template. Accepted by the admin ('qualified'),
    // because only a case approved for the retainer may open a signing session.
    await supabase.from("intake_submissions").insert({
      id: submissionId,
      claimant_id: claimantId,
      status: "retainer_pending_signature",
      locale: "en",
    });
    await supabase.from("accidents").insert({
      submission_id: submissionId,
      incident_type: "car",
      incident_location: "Orlando, FL",
      incident_date: "2025-01-15",
    });

    // 1. English request -> English template.
    const en1 = await postAgreement({ submissionId, locale: "en" });
    const afterEn1 = await activeAgreement();
    checks.push(
      ["en request creates an envelope from the EN template", en1.status === 201 && lastTemplate() === EN_TEMPLATE],
      ["the active agreement is recorded as en", afterEn1?.locale === "en"],
      ["one envelope so far", stub.envelopeCreates === 1]
    );

    // 2. Switch to Spanish -> ES template, EN agreement superseded, not reused.
    const es1 = await postAgreement({ submissionId, locale: "es" });
    const afterEs1 = await activeAgreement();
    const { data: voidedRows } = await supabase
      .from("agreements")
      .select("id, error_code")
      .eq("submission_id", submissionId)
      .eq("status", "voided");
    checks.push(
      ["es request creates an envelope from the ES template", es1.status === 201 && lastTemplate() === ES_TEMPLATE],
      ["a second envelope was created (EN was not reused for ES)", stub.envelopeCreates === 2],
      ["the active agreement is now es", afterEs1?.locale === "es"],
      ["the EN agreement was superseded (voided)", (voidedRows ?? []).some((r) => r.error_code === "locale_superseded")]
    );

    // 3. Same language again -> reuse, no new envelope.
    const beforeReuse = stub.envelopeCreates;
    const es2 = await postAgreement({ submissionId, locale: "es" });
    checks.push(
      ["a same-locale re-request reuses the envelope", es2.status === 200],
      ["no second ES envelope is created on reuse", stub.envelopeCreates === beforeReuse]
    );

    // 4. Switch back to English -> EN template, ES superseded.
    const en2 = await postAgreement({ submissionId, locale: "en" });
    const afterEn2 = await activeAgreement();
    checks.push(
      ["switching back to en uses the EN template again", en2.status === 201 && lastTemplate() === EN_TEMPLATE],
      ["the active agreement is en again", afterEn2?.locale === "en"],
      ["ES was not reused for the EN request", stub.envelopeCreates === 3]
    );

    // 5. Unknown / missing locale fails closed, and creates nothing.
    const createsBeforeBadInput = stub.envelopeCreates;
    const bogus = await postAgreement({ submissionId, locale: "fr" });
    const missing = await postAgreement({ submissionId });
    checks.push(
      ["an unsupported locale is rejected", bogus.status === 400],
      ["a missing locale is rejected", missing.status === 400],
      ["a rejected locale creates no envelope", stub.envelopeCreates === createsBeforeBadInput]
    );

    const passed = checks.filter(([, ok]) => ok).length;
    console.log(`\nLocale-aware agreement selection: ${passed}/${checks.length}`);
    for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (passed !== checks.length) throw new Error("locale-aware agreement checks failed");
  } finally {
    stub.restore();
    await supabase.from("agreements").delete().eq("submission_id", submissionId);
    await supabase.from("accidents").delete().eq("submission_id", submissionId);
    await supabase.from("intake_submissions").delete().eq("id", submissionId);
    await supabase.from("claimants").delete().eq("id", claimantId);
    if (authUserId) {
      try {
        await supabase.auth.admin.deleteUser(authUserId);
      } catch {
        // best effort — the fixture user is disposable
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(`\nLocale agreement test failed: ${(error as Error).message}`);
  process.exit(1);
});
