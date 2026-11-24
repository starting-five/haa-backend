import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt } from "crypto";
import type { AddressInfo } from "net";

// The case is opened when the number is verified, before the patient has said
// anything about the crash, and the accident arrives on a second call from the
// location screen. This proves both halves against the real endpoint and the
// real database: the first call creates a submission and no accident, the
// second attaches one, and a third updates it rather than adding another.
//
// The one-call shape every earlier caller used still has to work unchanged.

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

  const start = (token: string, body: Record<string, unknown>) =>
    fetch(`${base}/intake/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const claimantOnly = (mobile: string) => ({
    locale: "en",
    claimant: { firstName: "Reva", lastName: "Lin", mobile },
  });

  const accidentFor = (location: string) => ({
    incidentType: "car",
    incidentLocation: location,
    incidentDate: "2026-09-18",
  });

  const accidentRows = async (submissionId: string) => {
    const { data } = await supabase
      .from("accidents")
      .select("id, incident_type, incident_location, incident_date")
      .eq("submission_id", submissionId);
    return data ?? [];
  };

  try {
    // ── the two-call flow ────────────────────────────────────────────────────
    const phone = newPhone();
    const token = await login(phone);

    const opened = await start(token, claimantOnly(phone));
    const openedBody = (await opened.json()) as { existing: boolean; submissionId?: string };
    record("a case opens with the claimant alone", opened.status === 201 && Boolean(openedBody.submissionId));

    const submissionId = openedBody.submissionId ?? "";
    record("no accident is invented for it", (await accidentRows(submissionId)).length === 0);

    const attached = await start(token, { ...claimantOnly(phone), accident: accidentFor("Austin, TX") });
    const attachedBody = (await attached.json()) as { existing: boolean; submissionId?: string };
    record("the accident attaches to the same case", attachedBody.submissionId === submissionId);

    const afterAttach = await accidentRows(submissionId);
    record("exactly one accident row exists", afterAttach.length === 1);
    record("it holds what was sent", afterAttach[0]?.incident_location === "Austin, TX");

    // ── a correction, not a duplicate ────────────────────────────────────────
    await start(token, { ...claimantOnly(phone), accident: accidentFor("Dallas, TX") });
    const afterCorrection = await accidentRows(submissionId);
    record("a corrected answer updates the row", afterCorrection.length === 1);
    record("and the correction is what is stored", afterCorrection[0]?.incident_location === "Dallas, TX");
    record("the row keeps its identity", afterCorrection[0]?.id === afterAttach[0]?.id);

    // ── the shape every earlier caller used ──────────────────────────────────
    const legacyPhone = newPhone();
    const legacyToken = await login(legacyPhone);
    const legacy = await start(legacyToken, {
      ...claimantOnly(legacyPhone),
      accident: accidentFor("San Diego, CA"),
    });
    const legacyBody = (await legacy.json()) as { submissionId?: string };
    const legacyRows = await accidentRows(legacyBody.submissionId ?? "");
    record("one call with everything still works", legacy.status === 201 && legacyRows.length === 1);
    record("and records the accident it was given", legacyRows[0]?.incident_location === "San Diego, CA");

    // ── a half-answered accident is not an accident ─────────────────────────
    // The frontend once filled the gaps with "other" somewhere "Unknown" on the
    // day the patient verified, so the backend would accept the call. A row
    // like that is not missing data, it is wrong data, and nothing downstream
    // can tell it from an answer. A partial accident is therefore treated as
    // none and nothing is written.
    const partialPhone = newPhone();
    const partialToken = await login(partialPhone);
    const partial = await start(partialToken, {
      ...claimantOnly(partialPhone),
      accident: { incidentType: "other", incidentLocation: "", incidentDate: new Date().toISOString().slice(0, 10) },
    } as unknown as Parameters<typeof start>[1]);
    const partialBody = (await partial.json()) as { submissionId?: string };
    record("a case opens even when the accident is half-answered", partial.status === 201);
    record(
      "and no half-answered accident is written",
      (await accidentRows(partialBody.submissionId ?? "")).length === 0
    );

    // ── the claimant is still required ───────────────────────────────────────
    const missing = await start(token, { locale: "en", claimant: { firstName: "No", lastName: "Phone" } });
    record("a case still cannot open without a mobile", missing.status === 400);
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

  console.log("Opening a case before the accident is known:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: a case opens at verification and the accident attaches to it afterwards");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
