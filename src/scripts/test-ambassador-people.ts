import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// GET /ambassadors/people returns the patients one ambassador referred, and
// nothing else. The referral set is the authorization fact, so every way of
// failing to establish it has to answer with an empty list rather than a wider
// one. These run against the real endpoint and the real database, with the
// referral provider stubbed so the lead set can be dictated per case.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

/** What the stubbed provider answers next, keyed by the link it is asked about. */
let stubbedLeads: { events: unknown[]; status?: number; throws?: boolean } = { events: [] };
let providerCalls = 0;
let lastProviderQuery = "";

function stubReferralProvider(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.dub.co/")) return realFetch(input, init);

    providerCalls += 1;
    lastProviderQuery = url;
    if (stubbedLeads.throws) throw new Error("provider unreachable");
    const status = stubbedLeads.status ?? 200;
    return new Response(JSON.stringify(status === 200 ? stubbedLeads.events : { error: "boom" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

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
  process.env.DUB_API_KEY = "stub-referral-token";
  delete process.env.NODE_ENV;

  stubReferralProvider();

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const phones = new Set<string>();
  const userIds = new Set<string>();
  const newPhone = () => {
    const value = `+1555${randomInt(1_000_000, 9_999_999)}`;
    phones.add(value);
    return value;
  };

  const login = async (phone: string): Promise<{ token: string; userId: string }> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (response.ok) {
        const body = (await response.json()) as { accessToken: string; userId?: string };
        const { data } = await supabase.auth.getUser(body.accessToken);
        const userId = data.user?.id ?? body.userId ?? "";
        userIds.add(userId);
        return { token: body.accessToken, userId };
      }
      if (response.status !== 502 || attempt === 4) throw new Error(`login failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  /** A patient with a real submission, so there is something to be referred. */
  const newPatient = async (firstName: string) => {
    const phone = newPhone();
    const { token } = await login(phone);
    const response = await fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        locale: "en",
        claimant: { firstName, lastName: "Referred", mobile: phone },
        accident: { incidentType: "car", incidentLocation: "Austin, TX", incidentDate: "2026-09-18" },
      }),
    });
    const body = (await response.json()) as { submissionId?: string };
    return { submissionId: body.submissionId ?? "", phone, firstName };
  };

  /** An ambassador account with a provider link id of its own. */
  const newAmbassador = async (linkId: string) => {
    const phone = newPhone();
    const { token, userId } = await login(phone);
    await supabase.from("profiles").upsert({ user_id: userId, email: `${linkId}@example.invalid` });
    await supabase.from("ambassador_profiles").upsert({ user_id: userId, provider_link_id: linkId });
    return { token, userId, phone };
  };

  const people = async (token: string) => {
    const response = await fetch(`${base}/ambassadors/people`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { people?: { submissionId: string; name: string }[] };
    return { status: response.status, people: body.people ?? [] };
  };

  const leadEvent = (submissionId: string, createdAt = "2026-09-20T10:00:00Z") => ({
    customerExternalId: submissionId,
    timestamp: createdAt,
  });

  try {
    const patientA = await newPatient("Ada");
    const patientB = await newPatient("Bo");
    const ambassadorOne = await newAmbassador(`link_${randomUUID().slice(0, 8)}`);
    const ambassadorTwo = await newAmbassador(`link_${randomUUID().slice(0, 8)}`);

    // ── the ambassador sees the patient they referred ────────────────────────
    stubbedLeads = { events: [leadEvent(patientA.submissionId)] };
    const own = await people(ambassadorOne.token);
    record("an ambassador receives the patient they referred", own.status === 200 && own.people.length === 1);
    record("and it is the right one", own.people[0]?.submissionId === patientA.submissionId);
    record("with the patient's name", own.people[0]?.name === "Ada Referred");

    // ── and only that patient ────────────────────────────────────────────────
    record(
      "a patient they did not refer is absent",
      !own.people.some((person) => person.submissionId === patientB.submissionId)
    );

    // ── another ambassador's referrals are not theirs ────────────────────────
    stubbedLeads = { events: [leadEvent(patientB.submissionId)] };
    const other = await people(ambassadorTwo.token);
    record(
      "a second ambassador receives only their own referral",
      other.people.length === 1 && other.people[0]?.submissionId === patientB.submissionId
    );
    record(
      "and never the first ambassador's",
      !other.people.some((person) => person.submissionId === patientA.submissionId)
    );

    // ── each of the ways of not knowing ──────────────────────────────────────
    stubbedLeads = { events: [] };
    record("an ambassador with no leads receives none", (await people(ambassadorOne.token)).people.length === 0);

    stubbedLeads = { events: [], status: 500 };
    record("a provider error receives none", (await people(ambassadorOne.token)).people.length === 0);

    stubbedLeads = { events: [], throws: true };
    record("an unreachable provider receives none", (await people(ambassadorOne.token)).people.length === 0);

    stubbedLeads = { events: [leadEvent(patientA.submissionId)] };
    const savedKey = process.env.DUB_API_KEY;
    delete process.env.DUB_API_KEY;
    const unconfigured = await people(ambassadorOne.token);
    process.env.DUB_API_KEY = savedKey;
    record("an unconfigured provider receives none", unconfigured.people.length === 0);

    // ── a lead naming something that is not a submission ─────────────────────
    // The id decides which patient is shown, so a value that is not the shape
    // of one is discarded before it reaches a query. The status is asserted
    // too: letting it through surfaces as a 500 from the database rather than
    // as a refusal, and an empty list alone cannot tell those apart.
    stubbedLeads = { events: [{ customerExternalId: "not-a-uuid", timestamp: "2026-09-20T10:00:00Z" }] };
    const unusable = await people(ambassadorOne.token);
    record(
      "a lead with an unusable external id receives none",
      unusable.status === 200 && unusable.people.length === 0
    );

    // ── a forged lead for a submission that does not exist ───────────────────
    stubbedLeads = { events: [leadEvent(randomUUID())] };
    record(
      "a lead naming an unknown submission receives none",
      (await people(ambassadorOne.token)).people.length === 0
    );

    // ── an ambassador whose referral link cannot be resolved ─────────────────
    // The provider would happily answer about some other link; without an
    // identity of their own there is nothing to ask about, and the list must
    // stay empty rather than fall through to whatever comes back.
    const linkless = await newAmbassador("linkless");
    await supabase
      .from("ambassador_profiles")
      .update({
        provider_link_id: null,
        short_link: null,
        referral_link_key: null,
        username: null,
        username_display: null,
      })
      .eq("user_id", linkless.userId);
    const savedDomain = process.env.DUB_AMBASSADOR_LINK_DOMAIN;
    delete process.env.DUB_AMBASSADOR_LINK_DOMAIN;
    providerCalls = 0;
    stubbedLeads = { events: [leadEvent(patientA.submissionId)] };
    const unresolvable = await people(linkless.token);
    if (savedDomain) process.env.DUB_AMBASSADOR_LINK_DOMAIN = savedDomain;
    record(
      "an ambassador with no resolvable link receives none",
      unresolvable.status === 200 && unresolvable.people.length === 0
    );
    record("and the provider is not asked at all", providerCalls === 0);

    // ── a caller who is not an ambassador at all ─────────────────────────────
    const { token: patientToken } = await login(newPhone());
    stubbedLeads = { events: [leadEvent(patientA.submissionId)] };
    const asPatient = await people(patientToken);
    record("a caller with no ambassador row receives none", asPatient.status === 200 && asPatient.people.length === 0);

    // ── no session at all ────────────────────────────────────────────────────
    const anonymous = await fetch(`${base}/ambassadors/people`);
    record("an unauthenticated caller is refused", anonymous.status === 401);

    // ── the provider is asked only about this ambassador's own link ──────────
    providerCalls = 0;
    stubbedLeads = { events: [leadEvent(patientA.submissionId)] };
    await people(ambassadorOne.token);
    record("the provider is asked once", providerCalls === 1);
    record("and only about this ambassador's link", lastProviderQuery.includes("linkId="));

    // ── pagination stops rather than looping ─────────────────────────────────
    const fullPage = Array.from({ length: 100 }, () => leadEvent(randomUUID()));
    providerCalls = 0;
    stubbedLeads = { events: fullPage };
    await people(ambassadorOne.token);
    record("a full page is followed, and paging is bounded", providerCalls > 1 && providerCalls <= 10);
  } finally {
    server.close();

    for (const phone of phones) {
      const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
      if (claimant) {
        const { data: submissions } = await supabase
          .from("intake_submissions")
          .select("id")
          .eq("claimant_id", claimant.id);
        for (const submission of submissions ?? []) {
          await supabase.from("accidents").delete().eq("submission_id", submission.id);
          await supabase.from("intake_submissions").delete().eq("id", submission.id);
        }
        await supabase.from("claimants").delete().eq("id", claimant.id);
      }
    }
    for (const userId of userIds) {
      await supabase.from("ambassador_profiles").delete().eq("user_id", userId);
      await supabase.from("user_roles").delete().eq("user_id", userId);
      await supabase.from("profiles").delete().eq("user_id", userId);
      await supabase.auth.admin.deleteUser(userId).catch(() => undefined);
    }

    let leftovers = 0;
    for (const phone of phones) {
      const { data } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
      if (data) leftovers += 1;
    }
    record("every record created by this test was removed", leftovers === 0);
  }

  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) {
    console.error(`FAIL: ${failed} ambassador people check(s) failed`);
    process.exit(1);
  }
  console.log("PASS: an ambassador sees the patients they referred, and only those");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
