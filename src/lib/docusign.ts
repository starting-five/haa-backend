import { createSign } from "crypto";

// DocuSign JWT Grant authentication.
//
// Unlike lib/supabase.ts this deliberately does not throw at import time. No
// environment has DocuSign credentials yet and no route depends on it, so a
// boot-time throw would stop every existing deployment from starting.
// Configuration is validated on first use instead.
//
// Implemented against the REST endpoints with Node's own crypto and fetch so
// that adopting the official SDK later stays a contained change to this file.

const REQUIRED_VARS = [
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_API_ACCOUNT_ID",
  "DOCUSIGN_RSA_PRIVATE_KEY",
  "DOCUSIGN_OAUTH_HOST",
] as const;

// Requested together because DocuSign requires impersonation for JWT Grant and
// signature for the eSignature API. Consent is granted once, out of band.
const SCOPES = "signature impersonation";

// The assertion is short-lived; DocuSign rejects anything longer than an hour.
const ASSERTION_TTL_SECONDS = 3600;

// DocuSign rejects an assertion issued in its own future. A host clock running
// a few seconds fast is enough to trigger that, so issue slightly in the past.
const ASSERTION_CLOCK_SKEW_SECONDS = 10;

// Refresh early so a token can never expire mid-request.
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

export interface DocusignConfig {
  integrationKey: string;
  userId: string;
  accountId: string;
  privateKey: string;
  /** OAuth host, e.g. account-d.docusign.com for Sandbox. */
  oauthHost: string;
}

export interface DocusignAccount {
  accountId: string;
  accountName: string;
  /** API base returned by DocuSign; all eSignature calls must use this. */
  baseUri: string;
  userId: string;
  userName: string;
  email: string;
}

/** One entry of the accounts array in a DocuSign userinfo response. */
export interface UserinfoAccount {
  account_id: string;
  account_name: string;
  base_uri: string;
  is_default: boolean;
}

interface CachedToken {
  /** Configuration this token was minted for; a different one must not reuse it. */
  configKey: string;
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let inFlight: { configKey: string; promise: Promise<string> } | null = null;

export function isDocusignConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED_VARS.every((name) => Boolean(env[name]?.trim()));
}

/**
 * Private keys arrive from .env files and secret stores with their newlines
 * escaped, which openssl will not parse. Restore them before use.
 */
function normalizePrivateKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/**
 * A multi-line PEM pasted into a .env file without surrounding quotes is
 * truncated at the first newline, which surfaces from openssl as an opaque
 * DECODER error much later. Check the shape here so the cause is obvious.
 */
function assertUsablePrivateKey(key: string): void {
  const trimmed = key.trim();
  const hasHeader = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed);
  const hasFooter = /-----END [A-Z ]*PRIVATE KEY-----$/.test(trimmed);

  if (!hasHeader || !hasFooter) {
    throw new Error(
      "DOCUSIGN_RSA_PRIVATE_KEY is not a complete PEM key " +
        `(${trimmed.length} characters, header: ${hasHeader}, footer: ${hasFooter}). ` +
        "A multi-line PEM in a .env file must be wrapped in double quotes, or " +
        "stored on one line with \\n escapes."
    );
  }
}

export function loadDocusignConfig(env: NodeJS.ProcessEnv = process.env): DocusignConfig {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    // Names only — never the values.
    throw new Error(`Missing DocuSign env vars: ${missing.join(", ")}`);
  }

  const privateKey = normalizePrivateKey(env.DOCUSIGN_RSA_PRIVATE_KEY!);
  assertUsablePrivateKey(privateKey);

  return {
    integrationKey: env.DOCUSIGN_INTEGRATION_KEY!.trim(),
    userId: env.DOCUSIGN_USER_ID!.trim(),
    accountId: env.DOCUSIGN_API_ACCOUNT_ID!.trim(),
    privateKey: privateKey,
    oauthHost: env
      .DOCUSIGN_OAUTH_HOST!.trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
  };
}

/**
 * Identifies the configuration a token belongs to. The private key is not part
 * of it — these three already determine which account a token can reach, and
 * key material has no business in a cache key.
 */
function configIdentity(config: DocusignConfig): string {
  return `${config.integrationKey} ${config.userId} ${config.oauthHost}`;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Builds the RS256 assertion DocuSign exchanges for an access token. `aud` is
 * the OAuth host without a scheme, which is what DocuSign expects.
 */
export function createAssertion(config: DocusignConfig, issuedAt: number = Math.floor(Date.now() / 1000)): string {
  const iat = issuedAt - ASSERTION_CLOCK_SKEW_SECONDS;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: config.integrationKey,
      sub: config.userId,
      aud: config.oauthHost,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
      scope: SCOPES,
    })
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();

  return `${header}.${payload}.${base64Url(signer.sign(config.privateKey))}`;
}

async function requestAccessToken(config: DocusignConfig, issuedAt: number): Promise<string> {
  const response = await fetch(`https://${config.oauthHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createAssertion(config, issuedAt),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!response.ok || !body.access_token) {
    // consent_required means an administrator has not yet granted the
    // impersonation consent this integration needs.
    throw new Error(`DocuSign token request failed (${response.status}): ${body.error ?? "unknown_error"}`);
  }

  cachedToken = {
    configKey: configIdentity(config),
    accessToken: body.access_token,
    expiresAt: issuedAt + (body.expires_in ?? ASSERTION_TTL_SECONDS),
  };

  return body.access_token;
}

/**
 * Returns a cached access token, minting a new one when the cache is empty or
 * close to expiry. DocuSign rate-limits token requests, so concurrent callers
 * share one in-flight request rather than each minting their own.
 */
export async function getAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = loadDocusignConfig(env);
  const configKey = configIdentity(config);
  const now = Math.floor(Date.now() / 1000);

  if (
    cachedToken &&
    cachedToken.configKey === configKey &&
    cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > now
  ) {
    return cachedToken.accessToken;
  }

  if (inFlight && inFlight.configKey === configKey) {
    return inFlight.promise;
  }

  const promise = requestAccessToken(config, now);
  inFlight = { configKey, promise };

  try {
    return await promise;
  } finally {
    // Only clear the entry this call created; a later refresh may own it now.
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/**
 * Resolves the account named by DOCUSIGN_API_ACCOUNT_ID. There is deliberately
 * no fallback to the user's default account: a mistyped or stale account ID
 * would otherwise send real envelopes from whichever account DocuSign happened
 * to mark default, which is silent and unrecoverable once a document is signed.
 */
export function selectAccount(accounts: UserinfoAccount[], configuredAccountId: string): UserinfoAccount {
  const match = accounts.find((candidate) => candidate.account_id === configuredAccountId);

  if (!match) {
    // Counts only — never the configured or returned identifiers.
    throw new Error(
      `DOCUSIGN_API_ACCOUNT_ID matches none of the ${accounts.length} account(s) on the ` +
        "authenticated DocuSign user. The default account is not used as a fallback."
    );
  }

  return match;
}

/**
 * Resolves the account and its API base URI. DocuSign requires the base URI
 * from this call to be used for every subsequent eSignature request rather
 * than a hardcoded host.
 */
export async function getUserInfo(env: NodeJS.ProcessEnv = process.env): Promise<DocusignAccount> {
  const config = loadDocusignConfig(env);
  const token = await getAccessToken(env);

  const response = await fetch(`https://${config.oauthHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`DocuSign userinfo request failed (${response.status})`);
  }

  const body = (await response.json()) as {
    sub: string;
    name: string;
    email: string;
    accounts: UserinfoAccount[];
  };

  const account = selectAccount(body.accounts ?? [], config.accountId);

  return {
    accountId: account.account_id,
    accountName: account.account_name,
    baseUri: account.base_uri,
    userId: body.sub,
    userName: body.name,
    email: body.email,
  };
}

// ── eSignature operations ────────────────────────────────────────────────────

// Not part of REQUIRED_VARS: authentication works without them, and only
// envelope creation needs them. Validating here keeps a missing template a
// clear configuration error at the point of use rather than a boot failure.
//
// One template per language, each behind its own variable so a missing one is
// an obvious configuration error and a locale can never be served the other
// language's retainer. Both templates share the same signer role.
const TEMPLATE_ID_VARS = {
  en: "DOCUSIGN_TEMPLATE_ID_EN",
  es: "DOCUSIGN_TEMPLATE_ID_ES",
} as const;
const TEMPLATE_ROLE_VAR = "DOCUSIGN_TEMPLATE_ROLE_NAME";

/** The retainer languages that have a template. Anything else is refused, never guessed. */
export type AgreementLocale = keyof typeof TEMPLATE_ID_VARS;

export function isAgreementLocale(locale: string): locale is AgreementLocale {
  return locale === "en" || locale === "es";
}

export interface DocusignTemplateConfig {
  templateId: string;
  /** Must match a signer role on the template exactly, or DocuSign rejects the envelope. */
  roleName: string;
}

/** A text tab the sender fills. Where the template locks it, the signer sees it but cannot edit it. */
export interface AgreementTextTab {
  tabLabel: string;
  value: string;
}

/** The one recipient of a patient-only envelope. */
export interface EnvelopeSigner {
  email: string;
  name: string;
  /** The agreements row id. Never the submission id — that is a flow identifier. */
  clientUserId: string;
}

/** Envelope statuses the agreements table accepts; 006 fixes the set. */
const PERSISTABLE_STATUSES = ["created", "sent", "delivered", "completed", "declined", "voided"];

export function loadTemplateConfig(locale: string, env: NodeJS.ProcessEnv = process.env): DocusignTemplateConfig {
  if (!isAgreementLocale(locale)) {
    // No default language: sending the wrong-language retainer is worse than
    // failing, so an unexpected locale is refused rather than resolved to one.
    throw new Error(`Unsupported agreement locale: ${locale}`);
  }

  const idVar = TEMPLATE_ID_VARS[locale];
  const templateId = env[idVar]?.trim();
  const roleName = env[TEMPLATE_ROLE_VAR]?.trim();

  const missing: string[] = [];
  if (!templateId) missing.push(idVar);
  if (!roleName) missing.push(TEMPLATE_ROLE_VAR);
  if (missing.length > 0) {
    // Names only — a template id is not a secret, but it has no place in a log.
    throw new Error(`Missing DocuSign template configuration: ${missing.join(", ")}`);
  }

  return { templateId: templateId!, roleName: roleName! };
}

/**
 * Patient-only envelope: exactly one template role, no attorney, no
 * counter-signature, no routing order. `clientUserId` is what makes the
 * recipient embedded rather than emailed.
 */
export function buildEnvelopeRequest(
  template: DocusignTemplateConfig,
  signer: EnvelopeSigner,
  textTabs: AgreementTextTab[] = []
) {
  return {
    templateId: template.templateId,
    status: "sent",
    templateRoles: [
      {
        email: signer.email,
        name: signer.name,
        roleName: template.roleName,
        clientUserId: signer.clientUserId,
        // Values matched to the template's data labels; the name, signatures and
        // date-signed remain the template's own tabs. Omitted entirely when
        // there is nothing to prefill, so the request shape is otherwise unchanged.
        ...(textTabs.length > 0 ? { tabs: { textTabs } } : {}),
      },
    ],
  };
}

/**
 * Where the signing session may be framed, and which DocuSign app is allowed
 * to post messages to the page that frames it. Without these DocuSign answers
 * the ceremony with a frame-ancestors policy of "none" and the browser refuses
 * to show it inside the application.
 */
export interface EmbeddedSigningOrigins {
  frameAncestors: string[];
  messageOrigins: string[];
}

/**
 * The app that serves the ceremony for this environment: the demo app for the
 * Sandbox OAuth host, the production app otherwise. DocuSign requires it in
 * frameAncestors and as the only messageOrigins entry.
 */
export function signingAppOrigin(oauthHost: string): string {
  return /(^|\.)account-d\.docusign\.com$/.test(oauthHost)
    ? "https://apps-d.docusign.com"
    : "https://apps.docusign.com";
}

/** The application's own origin plus the DocuSign app; nothing else may frame a signing session. */
export function buildEmbeddedSigningOrigins(frontendUrl: string, oauthHost: string): EmbeddedSigningOrigins {
  const app = signingAppOrigin(oauthHost);
  return { frameAncestors: [new URL(frontendUrl).origin, app], messageOrigins: [app] };
}

/**
 * What the browser needs to mount the ceremony with DocuSign's embedding
 * library: the library for this environment and the integration key it is
 * loaded with. The key is the public OAuth client id of the integration — it
 * identifies the application to DocuSign and is not a credential — and it is
 * handed only to a patient who has just been authorised to sign.
 */
export interface EmbeddedSigningClient {
  scriptUrl: string;
  integrationKey: string;
}

export function buildEmbeddedSigningClient(oauthHost: string, integrationKey: string): EmbeddedSigningClient {
  const demo = signingAppOrigin(oauthHost) === "https://apps-d.docusign.com";
  return {
    scriptUrl: demo ? "https://js-d.docusign.com/bundle.js" : "https://js.docusign.com/bundle.js",
    integrationKey,
  };
}

/**
 * The email, name and clientUserId must be byte-identical to the ones the
 * envelope was created with; DocuSign matches the recipient on all three and
 * returns UNKNOWN_ENVELOPE_RECIPIENT otherwise.
 */
export function buildRecipientViewRequest(
  signer: EnvelopeSigner,
  returnUrl: string,
  embedding?: EmbeddedSigningOrigins
) {
  return {
    returnUrl,
    // The host application is responsible for identifying the signer before
    // this point. See lib/patient-identity.ts for what that means today.
    authenticationMethod: "none",
    email: signer.email,
    userName: signer.name,
    clientUserId: signer.clientUserId,
    ...(embedding ? { frameAncestors: embedding.frameAncestors, messageOrigins: embedding.messageOrigins } : {}),
  };
}

/** Ignores statuses the agreements CHECK constraint would reject. */
export function normalizeEnvelopeStatus(raw: unknown): string | null {
  return typeof raw === "string" && PERSISTABLE_STATUSES.includes(raw) ? raw : null;
}

/**
 * A refusal from the eSignature API, carrying DocuSign's own error code and
 * message. Both are diagnostic strings with no envelope, account or patient
 * identifiers in them, so they are safe to log and to act on.
 */
export class DocusignRequestError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly detail: string;

  constructor(status: number, errorCode: string, detail: string) {
    super(`DocuSign request failed (${status}): ${errorCode}${detail ? ` — ${detail}` : ""}`);
    this.name = "DocusignRequestError";
    this.status = status;
    this.errorCode = errorCode;
    this.detail = detail;
  }
}

/**
 * Codes DocuSign returns when the account, not the request, is the problem:
 * the demo plan's cumulative recipient cap and the API call-rate limits. None
 * of these is fixed by retrying the same request, and none means the envelope
 * or the patient is wrong, so callers report them as capacity rather than as a
 * failure of the signing flow.
 */
const ACCOUNT_CAPACITY_CODES = [
  "RECIPIENT_LIMIT_EXCEEDED",
  "ENVELOPE_LIMIT_EXCEEDED",
  "HOURLY_APIINVOCATION_LIMIT_EXCEEDED",
  "BURST_APIINVOCATION_LIMIT_EXCEEDED",
] as const;

export function isAccountCapacityError(error: unknown): error is DocusignRequestError {
  return (
    error instanceof DocusignRequestError &&
    (ACCOUNT_CAPACITY_CODES as readonly string[]).includes(error.errorCode)
  );
}

async function eSignatureRequest(
  path: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv
): Promise<Record<string, unknown>> {
  const account = await getUserInfo(env);
  const token = await getAccessToken(env);

  const response = await fetch(`${account.baseUri}/restapi/v2.1/accounts/${account.accountId}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // DocuSign error codes and messages are diagnostic and carry no identifiers.
    throw new DocusignRequestError(
      response.status,
      typeof body.errorCode === "string" && body.errorCode ? body.errorCode : "unknown_error",
      typeof body.message === "string" ? body.message : ""
    );
  }

  return body;
}

/** Returns the new envelope id. The template is chosen by the patient's locale. */
export async function createEnvelopeFromTemplate(
  signer: EnvelopeSigner,
  locale: string,
  textTabs: AgreementTextTab[] = [],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const template = loadTemplateConfig(locale, env);
  const body = await eSignatureRequest(
    "/envelopes",
    { method: "POST", body: JSON.stringify(buildEnvelopeRequest(template, signer, textTabs)) },
    env
  );

  if (typeof body.envelopeId !== "string" || !body.envelopeId) {
    throw new Error("DocuSign envelope creation returned no envelope id");
  }

  return body.envelopeId;
}

/**
 * Re-stamps text tabs on an envelope that already exists, matching each by its
 * data label and updating it by id. The reuse path uses it so a patient who
 * returns on a later day signs a document dated that day, not the day the
 * envelope was first created; a freshly created envelope already carries them.
 *
 * The envelope has a single patient signer. Same-labelled tabs are all updated,
 * so the two date-of-loss tabs stay in step. A no-op when there is nothing to set.
 */
export async function refreshEnvelopeTextTabs(
  envelopeId: string,
  textTabs: AgreementTextTab[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (textTabs.length === 0) return;

  const recipients = await eSignatureRequest(
    `/envelopes/${encodeURIComponent(envelopeId)}/recipients`,
    { method: "GET" },
    env
  );
  const signers = Array.isArray(recipients.signers) ? (recipients.signers as Array<Record<string, unknown>>) : [];
  const recipientId = typeof signers[0]?.recipientId === "string" ? signers[0].recipientId : null;
  if (!recipientId) {
    throw new Error("DocuSign envelope has no signer to refresh tabs for");
  }

  const tabsPath = `/envelopes/${encodeURIComponent(envelopeId)}/recipients/${encodeURIComponent(recipientId)}/tabs`;
  const existing = await eSignatureRequest(tabsPath, { method: "GET" }, env);
  const existingText = Array.isArray(existing.textTabs) ? (existing.textTabs as Array<Record<string, unknown>>) : [];

  const valueByLabel = new Map(textTabs.map((tab) => [tab.tabLabel, tab.value]));
  const updates = existingText
    .filter((tab) => typeof tab.tabId === "string" && valueByLabel.has(String(tab.tabLabel)))
    .map((tab) => ({ tabId: tab.tabId as string, value: valueByLabel.get(String(tab.tabLabel))!, locked: "true" }));

  if (updates.length === 0) return;

  await eSignatureRequest(tabsPath, { method: "PUT", body: JSON.stringify({ textTabs: updates }) }, env);
}

/** Returns a single-use, short-lived signing URL. Never log or cache it. */
export async function createRecipientView(
  envelopeId: string,
  signer: EnvelopeSigner,
  returnUrl: string,
  embedding?: EmbeddedSigningOrigins,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const body = await eSignatureRequest(
    `/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`,
    { method: "POST", body: JSON.stringify(buildRecipientViewRequest(signer, returnUrl, embedding)) },
    env
  );

  if (typeof body.url !== "string" || !body.url) {
    throw new Error("DocuSign recipient view returned no URL");
  }

  return body.url;
}

/**
 * The completed envelope as a single PDF, fetched with the application's own
 * DocuSign credentials.
 *
 * `documents/combined` is DocuSign's endpoint for the finished artefact — the
 * signed pages plus the certificate of completion. It returns PDF bytes rather
 * than JSON, so it cannot go through eSignatureRequest, and it is deliberately
 * server-side only: the bytes are a legal record and the browser never receives
 * a DocuSign URL or token to fetch them with.
 */
export async function downloadSignedDocument(
  envelopeId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Uint8Array> {
  const account = await getUserInfo(env);
  const token = await getAccessToken(env);

  const response = await fetch(
    `${account.baseUri}/restapi/v2.1/accounts/${account.accountId}/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`,
    { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" } }
  );

  if (!response.ok) {
    throw new Error(`DocuSign document download failed (${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function getEnvelopeStatus(
  envelopeId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const body = await eSignatureRequest(`/envelopes/${encodeURIComponent(envelopeId)}`, { method: "GET" }, env);

  return normalizeEnvelopeStatus(body.status);
}

/** Test seam — module state that would otherwise leak between cases. */
export function resetTokenCache(): void {
  cachedToken = null;
  inFlight = null;
}
