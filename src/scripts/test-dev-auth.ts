import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt } from "crypto";
import type { AddressInfo } from "net";

// Exercises the development authentication bridge against the real project:
// real auth.users rows, real Supabase sessions, real requireAuth verification.
// Every identity it creates is deleted afterwards.
//
// The bridge is not authentication, so these tests do not claim it is. What
// they prove is that the server decides, that one phone maps to exactly one
// identity, and that the session it hands back is an ordinary Supabase session
// the rest of the stack already understands.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) {
    throw new Error(
      "TEST_SUPABASE_PROJECT_REF is required. Set it to the ref of a Supabase project " +
        "you own and are willing to have identities created in."
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

  const { isDevOtpBridgeEnabled, assertDevBridgeNotInProduction, normalizePhone, resolveIdentity } =
    await import("../lib/dev-auth");
  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");

  // ── guards that need no server ────────────────────────────────────────────
  record("bridge enabled when opted in outside production", isDevOtpBridgeEnabled());
  record(
    "bridge disabled without the opt-in",
    !isDevOtpBridgeEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv)
  );
  record(
    "bridge disabled in production even when opted in",
    !isDevOtpBridgeEnabled({ DEV_OTP_BRIDGE: "enabled", NODE_ENV: "production" } as NodeJS.ProcessEnv)
  );

  let bootGuardThrew = false;
  try {
    assertDevBridgeNotInProduction({ DEV_OTP_BRIDGE: "enabled", NODE_ENV: "production" } as NodeJS.ProcessEnv);
  } catch {
    bootGuardThrew = true;
  }
  record("production boot guard fails closed", bootGuardThrew);

  record("normalizePhone accepts E.164", normalizePhone("+15550100123") === "+15550100123");
  record("normalizePhone strips separators", normalizePhone("+1 (555) 010-0123") === "+15550100123");
  record("normalizePhone rejects a bare national number", normalizePhone("5550100123") === null);
  record("normalizePhone rejects letters", normalizePhone("+1555ABC0123") === null);
  record("normalizePhone rejects a non-string", normalizePhone(12345 as unknown) === null);

  // Scoped to its own identities: other patients may legitimately exist in this
  // project once intake binds real ones, so nothing here reads or removes a row
  // it did not create.
  const findByPhone = async (e164: string) => {
    const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    return (data.users ?? []).filter((user) => user.phone === e164.replace("+", ""));
  };

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/intake/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Supabase burst-limits token verification. That is a property of the service,
  // not of the code under test, so a login that is rate-limited is retried here
  // rather than being allowed to make the suite flaky. Nothing else is retried:
  // a rejected code or a forked identity still fails immediately.
  const login = async (body: unknown): Promise<Response> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await post(body);
      if (response.status !== 502 || attempt === 4) return response;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  // Random rather than time-derived: timestamp slices collide across runs, which
  // silently turns a first-time verification into a returning one.
  const testPhones = new Set<string>();
  const testPhone = () => {
    const value = `+1555${randomInt(1_000_000, 9_999_999)}`;
    testPhones.add(value);
    return value;
  };
  const phone = testPhone();
  const createdUserIds = new Set<string>();

  try {
    // ── rejection paths ─────────────────────────────────────────────────────
    record("wrong code is rejected", (await post({ phone, code: "000000" })).status === 401);
    record("missing code is rejected", (await post({ phone })).status === 400);
    record("missing phone is rejected", (await post({ code: "111111" })).status === 400);
    record("malformed phone is rejected", (await post({ phone: "not-a-phone", code: "111111" })).status === 400);
    record("empty body is rejected", (await post({})).status === 400);

    record("no identity is created by a rejected request", (await findByPhone(phone)).length === 0);

    // ── the happy path ──────────────────────────────────────────────────────
    const first = await login({ phone, code: "111111" });
    const session = (await first.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
    record("correct code returns 200", first.status === 200);
    record("response carries an access token", Boolean(session.accessToken));
    record("response carries a refresh token", Boolean(session.refreshToken));
    record("response carries an expiry", typeof session.expiresIn === "number" && session.expiresIn > 0);
    record(
      "response carries nothing else",
      Object.keys(session).sort().join(",") === "accessToken,expiresIn,refreshToken"
    );

    const claims = JSON.parse(Buffer.from(session.accessToken!.split(".")[1]!, "base64url").toString());
    const { data: verified } = await supabase.auth.getUser(session.accessToken!);
    if (verified.user) createdUserIds.add(verified.user.id);

    record("requireAuth accepts the token", Boolean(verified.user));
    record("JWT sub is the auth.users id", claims.sub === verified.user?.id);
    record("JWT role is authenticated", claims.role === "authenticated");
    record("JWT carries the phone, not the bootstrap address", claims.phone === phone.replace("+", ""));
    record("the identity is phone-primary", verified.user?.phone === phone.replace("+", ""));

    // ── the session behaves like any other Supabase session ─────────────────
    const refreshed = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    record("session refreshes", refreshed.status === 200);

    const loggedOut = await fetch(`${process.env.SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${session.accessToken}` },
    });
    record("session signs out", loggedOut.status === 204 || loggedOut.status === 200);

    // ── the same phone must never produce a second identity ─────────────────
    const second = await login({ phone, code: "111111" });
    const secondSession = (await second.json()) as { accessToken: string };
    const { data: secondUser } = await supabase.auth.getUser(secondSession.accessToken);
    record("a repeat verification reuses the same identity", secondUser.user?.id === verified.user?.id);

    // ── concurrent first-time identity resolution for one phone ─────────────
    // Tested at the library boundary: Supabase burst-limits token verification,
    // so racing two full logins measures its quota rather than our correctness.
    // The property that matters is that a race never forks identity.
    const racePhone = testPhone();
    const racedIds = await Promise.all([resolveIdentity(racePhone), resolveIdentity(racePhone)]);
    for (const id of racedIds) createdUserIds.add(id);

    record("concurrent identity resolution returns the same id", new Set(racedIds).size === 1);

    record("exactly one auth.users row exists for the raced phone", (await findByPhone(racePhone)).length === 1);

    // ── a different phone is a different identity, and nothing the browser
    //    sends can change which one it gets ──────────────────────────────────
    // The expected id is resolved directly so this needs only one login: token
    // verification is burst-limited, and an extra call here would measure that
    // instead of the property under test.
    const otherPhone = testPhone();
    const expectedOtherId = await resolveIdentity(otherPhone);
    createdUserIds.add(expectedOtherId);
    record("a different phone yields a different identity", expectedOtherId !== verified.user?.id);

    const forged = await login({
      phone: otherPhone,
      code: "111111",
      user_id: verified.user?.id,
      claimantId: "attacker-supplied",
      submissionId: "attacker-supplied",
      email: `dev-${verified.user?.id}@haa-dev.invalid`,
    });
    const forgedSession = (await forged.json()) as { accessToken?: string };
    const { data: forgedUser } = forgedSession.accessToken
      ? await supabase.auth.getUser(forgedSession.accessToken)
      : { data: { user: null } };
    record(
      "supplying another user_id, claimantId, submissionId or email does not change the identity",
      forged.status === 200 && forgedUser.user?.id === expectedOtherId
    );
  } finally {
    server.close();
    // Only this test's identities. Sweeping everything would delete patients
    // that legitimately exist once intake starts binding real ones.
    for (const id of createdUserIds) await supabase.auth.admin.deleteUser(id);
    const leftovers = (await Promise.all([...testPhones].map(findByPhone))).flat();
    record("every identity created by this test was removed", leftovers.length === 0);
  }

  console.log("Development auth bridge:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} development auth check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: the server decides, one phone is one identity, the session is a real one");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
