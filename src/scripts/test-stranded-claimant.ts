import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt } from "crypto";
import type { AddressInfo } from "net";

// A first start that creates the claimant and then fails to open the case leaves
// a claimant with no submission. /intake/start used to answer that claimant
// `existing`, the frontend took them for a returning patient and sent them to
// attorney matching with no case behind it, and every retry did the same — a
// patient who could never open a case. On 2026-09-24 four of them were left on
// the personal test project by a backend that wrote a status the database no
// longer accepted.
//
// This proves, against the real endpoint and the real database, that such a
// claimant is given a case; that concurrent starts for one patient end with one
// case, not several; and that a returning patient is still answered `existing`.

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

  const start = async (token: string, mobile: string, firstName = "Reva") => {
    const response = await fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ locale: "en", claimant: { firstName, lastName: "Lin", mobile } }),
    });
    return { status: response.status, body: (await response.json()) as { existing?: boolean; submissionId?: string } };
  };

  const claimantFor = async (mobile: string) => {
    const { data } = await supabase.from("claimants").select("id, first_name").eq("mobile", mobile).maybeSingle();
    return data;
  };
  const submissionsFor = async (claimantId: string) => {
    const { data } = await supabase.from("intake_submissions").select("id, status").eq("claimant_id", claimantId);
    return data ?? [];
  };

  // Leaves a claimant exactly as the failed first start did: the row exists, the
  // case does not.
  const strand = async (phone: string, token: string) => {
    await start(token, phone);
    const claimant = await claimantFor(phone);
    assert(claimant, "setup: the first start should have created a claimant");
    await supabase.from("intake_submissions").delete().eq("claimant_id", claimant.id);
    assert((await submissionsFor(claimant.id)).length === 0, "setup: the claimant should hold no submission");
    return claimant.id;
  };

  try {
    // ── a claimant left without a case gets one ─────────────────────────────
    const strandedPhone = newPhone();
    const strandedToken = await login(strandedPhone);
    const strandedId = await strand(strandedPhone, strandedToken);

    const reopened = await start(strandedToken, strandedPhone, "Revathi");
    record("a claimant with no case is not answered existing", reopened.body.existing === false);
    record("it is given a case", reopened.status === 201 && Boolean(reopened.body.submissionId));
    const afterReopen = await submissionsFor(strandedId);
    record(
      "exactly one open case exists for it",
      afterReopen.length === 1 &&
        afterReopen[0]?.status === "intake" &&
        afterReopen[0]?.id === reopened.body.submissionId
    );
    record("the name typed this time is the one kept", (await claimantFor(strandedPhone))?.first_name === "Revathi");

    const again = await start(strandedToken, strandedPhone, "Revathi");
    record("starting again resumes that case", again.body.submissionId === reopened.body.submissionId);
    record("and opens no second one", (await submissionsFor(strandedId)).length === 1);

    // ── concurrent starts for a claimant without a case ─────────────────────
    const racePhone = newPhone();
    const raceToken = await login(racePhone);
    const raceId = await strand(racePhone, raceToken);

    const racing = await Promise.all(Array.from({ length: 5 }, () => start(raceToken, racePhone)));
    const raceIds = new Set(racing.map((result) => result.body.submissionId));
    record(
      "five concurrent starts all succeed",
      racing.every((result) => result.status === 200 || result.status === 201)
    );
    record("they all name the same case", raceIds.size === 1 && !raceIds.has(undefined));
    record("exactly one case is opened", (await submissionsFor(raceId)).length === 1);

    // ── concurrent first starts for a brand-new patient ─────────────────────
    const freshPhone = newPhone();
    const freshToken = await login(freshPhone);
    const fresh = await Promise.all(Array.from({ length: 5 }, () => start(freshToken, freshPhone)));
    const freshIds = new Set(fresh.map((result) => result.body.submissionId));
    const freshClaimant = await claimantFor(freshPhone);
    record(
      "concurrent first starts all succeed",
      fresh.every((result) => result.status === 200 || result.status === 201)
    );
    record("and share one case", freshIds.size === 1 && !freshIds.has(undefined));
    record(
      "one claimant, one case",
      Boolean(freshClaimant) && (await submissionsFor(freshClaimant?.id ?? "")).length === 1
    );

    // ── a returning patient is still returning ──────────────────────────────
    const returningPhone = newPhone();
    const returningToken = await login(returningPhone);
    const opened = await start(returningToken, returningPhone);
    await supabase
      .from("intake_submissions")
      .update({ status: "submitted" })
      .eq("id", opened.body.submissionId ?? "");
    const returning = await start(returningToken, returningPhone);
    const returningClaimant = await claimantFor(returningPhone);
    record("a claimant with a submitted case is answered existing", returning.body.existing === true);
    record("and is given no second case", (await submissionsFor(returningClaimant?.id ?? "")).length === 1);

    // A case that has moved past intake without ever being `submitted` is still
    // a case: that patient is returning, not stranded.
    await supabase
      .from("intake_submissions")
      .update({ status: "attorney" })
      .eq("id", opened.body.submissionId ?? "");
    const later = await start(returningToken, returningPhone);
    record("a claimant whose case is past intake is answered existing", later.body.existing === true);
    record("and is given no second case either", (await submissionsFor(returningClaimant?.id ?? "")).length === 1);
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

  console.log("A claimant left without a case:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: a claimant without a case is given one, once, and a returning patient is still returning");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
