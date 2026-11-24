import { supabase } from "./supabase";

// DEVELOPMENT-ONLY AUTHENTICATION ADAPTER. THIS IS NOT PRODUCTION SECURITY.
//
// The intake flow has no SMS provider, so patients cannot complete a real phone
// OTP and therefore cannot obtain a Supabase session. Without a session there is
// no identity to bind ownership to, and every /intake route is open to anyone
// holding a submission id.
//
// This module bridges the gap for the personal test environment only. It
// verifies the development OTP server-side and mints a genuine Supabase session
// for a phone-primary auth.users identity, so the ownership architecture can be
// built and tested for real.
//
// What it does NOT do is authenticate anybody. The development code is a
// constant, so any caller can claim any phone number and therefore any patient.
// It makes the resulting forgery *authenticated*, which is exactly what makes
// the ownership work testable — and exactly why this must never run anywhere
// holding real patient data.
//
// When Twilio lands, only verifyDevOtp is replaced by a real
// verifyOtp({ phone, token, type: "sms" }). auth.users.id, claimants.user_id and
// every ownership assertion built on them stay as they are.

const DEV_OTP_CODE = "111111";

// .invalid is reserved by RFC 2606 and can never resolve, so no mail can ever
// be delivered to these addresses. The address exists only because Supabase has
// no way to issue a session for a phone-only user while the phone provider is
// disabled — every other route was tried and refused. It is a session-bootstrap
// channel and is never an identity: authorization reads auth.users.id, and the
// phone remains the canonical identifier and is present in the JWT.
const SYNTHETIC_EMAIL_DOMAIN = "haa-dev.invalid";

/**
 * Attempts at generating and redeeming a magic link. Only a token invalidated by
 * a concurrent login is worth retrying; Supabase rate-limits this endpoint, so
 * retrying anything else — a rate limit above all — makes the problem worse.
 */
const SESSION_MINT_ATTEMPTS = 3;
const SESSION_MINT_RETRY_MS = 250;

/** Pages scanned when resolving a phone to an existing identity. Dev-only, tiny. */
const USER_SCAN_PAGE_SIZE = 200;

export interface DevSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * The bridge exists only when both conditions hold. NODE_ENV alone is not
 * enough — it is easy to set by accident — so an explicit opt-in is required
 * as well, and the route is never mounted unless this returns true.
 */
export function isDevOtpBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_OTP_BRIDGE === "enabled" && env.NODE_ENV !== "production";
}

/**
 * Fails the process rather than quietly ignoring a dangerous combination.
 * Called at import time, so a production deployment that sets the flag dies at
 * boot instead of serving a forgeable login.
 */
export function assertDevBridgeNotInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DEV_OTP_BRIDGE === "enabled" && env.NODE_ENV === "production") {
    throw new Error(
      "DEV_OTP_BRIDGE is enabled while NODE_ENV=production. The development OTP " +
        "bridge accepts a constant code and is not authentication; it must never " +
        "run in production. Unset DEV_OTP_BRIDGE."
    );
  }
}

assertDevBridgeNotInProduction();

// Re-exported so the bridge's own callers are unaffected by the move. The
// implementation is shared with the production routes in lib/phone.
export { normalizePhone } from "./phone";

/** Server-side, so the browser can never assert that verification succeeded. */
export function verifyDevOtp(code: unknown): boolean {
  return typeof code === "string" && code === DEV_OTP_CODE;
}

/** auth.users stores the number without the leading plus. */
function phoneMatches(userPhone: string | undefined, e164: string): boolean {
  return Boolean(userPhone) && userPhone === e164.replace(/^\+/, "");
}

async function findUserIdByPhone(e164: string): Promise<string | null> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USER_SCAN_PAGE_SIZE });
    if (error) throw new Error(`Failed to list auth users: ${error.message}`);

    const match = data.users.find((user) => phoneMatches(user.phone, e164));
    if (match) return match.id;
    if (data.users.length < USER_SCAN_PAGE_SIZE) return null;
  }
}

/**
 * Resolves the phone to exactly one auth.users id, creating it the first time.
 * Exported so the race can be tested where it happens, rather than through the
 * HTTP layer where Supabase's burst limit on token verification would obscure
 * the result.
 *
 * Two simultaneous first-time verifications both find nothing and both attempt
 * to create; auth.users.phone is unique, so one wins and the loser re-reads the
 * winner's row. The phone is the only key — nothing the browser sends is used
 * to choose an identity.
 */
export async function resolveIdentity(e164: string): Promise<string> {
  const existing = await findUserIdByPhone(e164);
  if (existing) return existing;

  const { data, error } = await supabase.auth.admin.createUser({
    phone: e164,
    phone_confirm: true,
  });

  if (error) {
    // Lost the race, or the number was registered between the scan and here.
    const winner = await findUserIdByPhone(e164);
    if (winner) return winner;
    throw new Error(`Failed to establish identity: ${error.message}`);
  }

  return data.user.id;
}

/**
 * Mints a real Supabase session for the identity behind this phone.
 *
 * The session is issued by Supabase, not by this application — a normal access
 * and refresh token pair that requireAuth verifies like any other. The magic
 * link is generated and redeemed entirely server-side and is single-use, so no
 * reusable credential is created and no password is ever stored.
 */
export async function establishDevSession(e164: string): Promise<DevSession> {
  const userId = await resolveIdentity(e164);
  const email = `dev-${userId}@${SYNTHETIC_EMAIL_DOMAIN}`;

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (updateError) throw new Error(`Failed to prepare session channel: ${updateError.message}`);

  // Generating a link invalidates the previous one for the same address, so two
  // simultaneous logins for one phone can leave the earlier request holding a
  // token that is already dead. Generating and redeeming is one retryable unit:
  // the identity is settled by now, the token is single-use, and a fresh pair
  // costs nothing.
  let lastFailure = "unknown_error";

  for (let attempt = 1; attempt <= SESSION_MINT_ATTEMPTS; attempt += 1) {
    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError) throw new Error(`Failed to generate session token: ${linkError.message}`);

    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", token_hash: link.properties.hashed_token }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_code?: string;
    };

    if (response.ok && body.access_token && body.refresh_token) {
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: body.expires_in ?? 3600,
      };
    }

    // Codes only. The response carries tokens; none of it belongs in a log.
    lastFailure = body.error_code ?? `http_${response.status}`;

    // A token invalidated by a concurrent login for the same phone is the one
    // recoverable case. Anything else — a rate limit especially — is returned
    // as-is rather than retried into a worse one.
    if (lastFailure !== "otp_expired") break;

    if (attempt < SESSION_MINT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_MINT_RETRY_MS));
    }
  }

  throw new Error(`Failed to redeem session token: ${lastFailure}`);
}
