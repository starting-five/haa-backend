import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt } from "crypto";
import type { AddressInfo } from "net";

// Proves the duplicate-registration gate in front of the new-patient flow.
//
// Three things are checked, against the real endpoints and a real database:
// that a registered number is recognised however it is typed, that the answer
// carries nothing but the answer, and that a caller who ignores the gate still
// cannot register the same patient twice.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) {
    throw new Error(
      "TEST_SUPABASE_PROJECT_REF is required. Set it to the ref of a Supabase project " +
        "you own and are willing to have identities and claimants created in."
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

  process.env.DEV_OTP_BRIDGE = "enabled";
  delete process.env.NODE_ENV;

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const phones = new Set<string>();
  const newPhone = () => {
    const value = `+1555${randomInt(1_000_000, 9_999_999)}`;
    phones.add(value);
    return value;
  };

  const status = (body: unknown) =>
    fetch(`${base}/intake/registration-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const statusOf = async (phone: unknown): Promise<string | undefined> => {
    const response = await status({ phone });
    return ((await response.json()) as { status?: string }).status;
  };

  const login = async (phone: string): Promise<string> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (response.ok) return ((await response.json()) as { accessToken: string }).accessToken;
      // Supabase burst-limits token verification; that is its quota, not our logic.
      if (response.status !== 502 || attempt === 4) throw new Error(`login failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  const intake = (mobile: string) => ({
    locale: "en",
    claimant: { firstName: "Gate", lastName: "Tester", mobile },
    accident: { incidentType: "car", incidentLocation: "San Diego, CA", incidentDate: "2026-09-05" },
  });

  const start = (token: string, mobile: string) =>
    fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(intake(mobile)),
    });

  const submissionsFor = async (mobile: string): Promise<string[]> => {
    const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", mobile).maybeSingle();
    if (!claimant) return [];
    const { data } = await supabase.from("intake_submissions").select("id").eq("claimant_id", claimant.id);
    return (data ?? []).map((row) => row.id as string);
  };

  const unknownPhone = newPhone();
  const registeredPhone = newPhone();
  const abandonedPhone = newPhone();
  const racePhone = newPhone();
  const forcedPhone = newPhone();

  try {
    // ── a number nobody has used ────────────────────────────────────────────
    const unknownResponse = await status({ phone: unknownPhone });
    record("an unknown number answers 200", unknownResponse.status === 200);
    record("an unknown number is new", ((await unknownResponse.json()) as { status: string }).status === "new");

    const { data: createdByCheck } = await supabase.from("claimants").select("id").eq("mobile", unknownPhone);
    record("checking a number creates no claimant", (createdByCheck ?? []).length === 0);

    // ── a registered patient ────────────────────────────────────────────────
    const registeredToken = await login(registeredPhone);
    const registeredStart = await start(registeredToken, registeredPhone);
    const { submissionId } = (await registeredStart.json()) as { submissionId: string };
    await supabase.from("intake_submissions").update({ status: "submitted" }).eq("id", submissionId);

    record("a registered patient is existing", (await statusOf(registeredPhone)) === "existing");

    // ── formatting must not decide the answer ───────────────────────────────
    const digits = registeredPhone.slice(2);
    const variants = [
      registeredPhone,
      `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
      `+1 ${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`,
      `+1${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
    ];
    const variantAnswers = await Promise.all(variants.map(statusOf));
    record(
      "every way of typing a registered number answers existing",
      variantAnswers.every((answer) => answer === "existing")
    );

    // ── the answer carries nothing else ─────────────────────────────────────
    const bodyKeys = Object.keys((await (await status({ phone: registeredPhone })).json()) as object);
    record("the response is only a status", bodyKeys.length === 1 && bodyKeys[0] === "status");

    // ── a case that has moved on is still a registration ────────────────────
    // The Admin Dashboard's acceptance moves a case to 'qualified', and that
    // patient has to be able to sign in to reach their agreement. Every later
    // stage the dashboard shows answers the same.
    for (const later of ["retainer_pending_signature", "signed", "attorney", "qualified", "not_qualified", "doctor"]) {
      await supabase.from("intake_submissions").update({ status: later }).eq("id", submissionId);
      record(`a patient whose case is ${later} is existing`, (await statusOf(registeredPhone)) === "existing");
    }
    await supabase.from("intake_submissions").update({ status: "submitted" }).eq("id", submissionId);

    // ── an abandoned intake is not a registration ───────────────────────────
    // The claimant exists but has never submitted, so signing in would show
    // them nothing. Sending them to login would strand them.
    const abandonedToken = await login(abandonedPhone);
    await start(abandonedToken, abandonedPhone);
    record("an unsubmitted intake is still new", (await statusOf(abandonedPhone)) === "new");

    // ── malformed input is refused, not guessed ─────────────────────────────
    record("a missing phone is refused", (await status({})).status === 400);
    record("a national-format number is refused", (await status({ phone: "4075551234" })).status === 400);
    record("a short number is refused", (await status({ phone: "+1407555" })).status === 400);
    record("a non-string phone is refused", (await status({ phone: 14075551234 })).status === 400);

    // ── ignoring the gate still cannot register twice ───────────────────────
    // The gate is advisory; /intake/start is the guarantee. Starting again before
    // submitting resumes the same submission, and a patient with a submitted case
    // is answered existing; neither gets a second one.
    const forcedToken = await login(forcedPhone);
    const firstStart = await start(forcedToken, forcedPhone);
    const { submissionId: forcedSubmissionId } = (await firstStart.json()) as { submissionId?: string };
    const secondStart = await start(forcedToken, forcedPhone);
    const secondBody = (await secondStart.json()) as { existing?: boolean; submissionId?: string };
    record("a first start creates the submission", firstStart.status === 201);
    record(
      "a second start resumes that submission",
      secondStart.status === 200 && secondBody.existing === false && secondBody.submissionId === forcedSubmissionId
    );
    record("a second start creates no second submission", (await submissionsFor(forcedPhone)).length === 1);

    const registeredAgain = await start(registeredToken, registeredPhone);
    const registeredAgainBody = (await registeredAgain.json()) as { existing?: boolean };
    record(
      "a registered patient starting again is answered existing",
      registeredAgain.status === 200 && registeredAgainBody.existing === true
    );
    record("a registered patient gets no second submission", (await submissionsFor(registeredPhone)).length === 1);

    // ── two registrations at once ───────────────────────────────────────────
    const raceToken = await login(racePhone);
    const raced = await Promise.all([start(raceToken, racePhone), start(raceToken, racePhone)]);
    const { data: racedClaimants } = await supabase.from("claimants").select("id").eq("mobile", racePhone);
    record(
      "concurrent registrations both answer",
      raced.every((response) => response.status === 200 || response.status === 201)
    );
    record("concurrent registrations create exactly one claimant", (racedClaimants ?? []).length === 1);
    record("concurrent registrations create exactly one submission", (await submissionsFor(racePhone)).length === 1);
  } finally {
    server.close();

    // Remove only what this run created, in dependency order.
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
    record("every record created by this test was removed", leftovers === 0);
  }

  console.log("Registration status gate:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} registration status check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: an existing patient is stopped at the door, and cannot be registered twice");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
