import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// What GET /patient/dashboard reports about a case's lawyer and doctor, through
// the real route, database and session: the provider state is read from the
// caller's own cases only, a lawyer match is a lawyer's accepted review link and
// nothing else, and no case is matched with a doctor while nothing records one.
//
// Writes rows marked with TEST_MARKER and removes them afterwards. Runs only
// against the project TEST_SUPABASE_PROJECT_REF names, or "local" for a Supabase
// CLI stack on a loopback address.

const TEST_MARKER = "DashboardProvidersSuite";

type Providers = { lawyer?: { matched?: unknown }; doctor?: { matched?: unknown } };
type DashboardCase = { submissionId: string; providers?: Providers };

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

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const checks: [string, boolean][] = [];
  const record = (label: string, passed: boolean) => checks.push([label, passed]);
  const userIds: string[] = [];

  const login = async (phone: string): Promise<{ token: string; userId: string }> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const r = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (r.ok) {
        const { accessToken } = (await r.json()) as { accessToken: string };
        const { data } = await supabase.auth.getUser(accessToken);
        if (data.user) userIds.push(data.user.id);
        return { token: accessToken, userId: data.user?.id ?? "" };
      }
      if (r.status !== 502 || attempt === 4) throw new Error(`login failed: ${r.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  const patient = async (label: string) => {
    const phone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const session = await login(phone);
    const { data: claimant, error } = await supabase
      .from("claimants")
      .insert({ user_id: session.userId, first_name: label, last_name: TEST_MARKER, mobile: phone })
      .select("id")
      .single();
    if (error || !claimant) throw new Error(`claimant insert failed: ${error?.message}`);
    return { ...session, claimantId: claimant.id as string };
  };

  const caseFor = async (claimantId: string, status: string) => {
    const id = randomUUID();
    const { error } = await supabase
      .from("intake_submissions")
      .insert({ id, claimant_id: claimantId, status, locale: "en", submitted_at: new Date().toISOString() });
    if (error) throw new Error(`submission insert failed: ${error.message}`);
    await supabase
      .from("accidents")
      .insert({ submission_id: id, incident_type: "car", incident_location: "Tampa, FL" });
    return id;
  };

  const assignment = async (submissionId: string, state: Record<string, unknown>) => {
    const { error } = await supabase.from("review_assignments").insert({
      submission_id: submissionId,
      assigned_by_user_id: randomUUID(),
      assignment_mode: "invite_link",
      review_link_token_hash: randomUUID().replace(/-/g, ""),
      expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      ...state,
    });
    if (error) throw new Error(`assignment insert failed: ${error.message}`);
  };

  const dashboard = async (token: string | null) => {
    const r = await fetch(`${base}/patient/dashboard`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = (await r.json().catch(() => ({}))) as { cases?: DashboardCase[] };
    return { status: r.status, cases: json.cases ?? [] };
  };

  const now = () => new Date().toISOString();

  try {
    const A = await patient("ProvidersA");
    const B = await patient("ProvidersB");

    const cases = {
      submitted: await caseFor(A.claimantId, "submitted"),
      passedPending: await caseFor(A.claimantId, "attorney"),
      accepted: await caseFor(A.claimantId, "qualified"),
      acceptedRevoked: await caseFor(A.claimantId, "qualified"),
      lawyerRejected: await caseFor(A.claimantId, "not_qualified"),
      acceptedThenClosed: await caseFor(A.claimantId, "not_qualified"),
      adminQualifiedOnly: await caseFor(A.claimantId, "qualified"),
      acceptedLinkExpired: await caseFor(A.claimantId, "qualified"),
      doctorStatus: await caseFor(A.claimantId, "doctor"),
    };
    await assignment(cases.passedPending, { status: "pending" });
    await assignment(cases.accepted, { status: "accepted", accepted_at: now() });
    await assignment(cases.acceptedRevoked, { status: "accepted", accepted_at: now(), revoked_at: now() });
    await assignment(cases.lawyerRejected, { status: "rejected", rejected_at: now() });
    await assignment(cases.acceptedThenClosed, { status: "accepted", accepted_at: now() });
    await assignment(cases.acceptedLinkExpired, {
      status: "accepted",
      accepted_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const bCase = await caseFor(B.claimantId, "qualified");
    await assignment(bCase, { status: "accepted", accepted_at: now() });

    const a = await dashboard(A.token);
    const of = (id: string) => a.cases.find((c) => c.submissionId === id)?.providers;
    const lawyer = (id: string) => of(id)?.lawyer?.matched;
    const doctor = (id: string) => of(id)?.doctor?.matched;

    record("A's dashboard answers 200 with A's nine cases", a.status === 200 && a.cases.length === 9);
    record(
      "every case carries providers.lawyer.matched and providers.doctor.matched as booleans",
      a.cases.every(
        (c) => typeof c.providers?.lawyer?.matched === "boolean" && typeof c.providers?.doctor?.matched === "boolean"
      )
    );
    record("submitted, never passed: no lawyer", lawyer(cases.submitted) === false);
    record("passed to a lawyer who has not decided: no lawyer", lawyer(cases.passedPending) === false);
    record("accepted by the lawyer: lawyer matched", lawyer(cases.accepted) === true);
    record("accepted, then revoked: no lawyer", lawyer(cases.acceptedRevoked) === false);
    record("rejected by the lawyer: no lawyer", lawyer(cases.lawyerRejected) === false);
    record("accepted, then closed not_qualified: no lawyer", lawyer(cases.acceptedThenClosed) === false);
    record("qualified by the admin with no lawyer acceptance: no lawyer", lawyer(cases.adminQualifiedOnly) === false);
    record("accepted, link expired since: still matched", lawyer(cases.acceptedLinkExpired) === true);
    record(
      "no case has a doctor — nothing records one",
      a.cases.every((c) => c.providers?.doctor?.matched === false)
    );
    record("status 'doctor' alone does not make a doctor match", doctor(cases.doctorStatus) === false);
    record("B's case is not on A's dashboard", !a.cases.some((c) => c.submissionId === bCase));

    const b = await dashboard(B.token);
    record(
      "B sees only B's case, lawyer matched from B's own acceptance",
      b.status === 200 &&
        b.cases.length === 1 &&
        b.cases[0]?.submissionId === bCase &&
        b.cases[0]?.providers?.lawyer?.matched === true
    );
    record("no session: 401 and no providers", (await dashboard(null)).status === 401);
  } catch (error) {
    record(`suite completed (${(error as Error).message})`, false);
  } finally {
    const { data: claimants } = await supabase.from("claimants").select("id").eq("last_name", TEST_MARKER);
    for (const c of claimants ?? []) await supabase.from("intake_submissions").delete().eq("claimant_id", c.id);
    await supabase.from("claimants").delete().eq("last_name", TEST_MARKER);
    for (const id of userIds) await supabase.auth.admin.deleteUser(id);
    server.close();
  }

  const failed = checks.filter(([, passed]) => !passed);
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) throw new Error(`${failed.length} dashboard provider check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: the dashboard reports each provider from the caller's own data");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
