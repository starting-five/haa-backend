import "dotenv/config";
import { createVerify, generateKeyPairSync } from "crypto";
import {
  createAssertion,
  getAccessToken,
  getUserInfo,
  isDocusignConfigured,
  loadDocusignConfig,
  resetTokenCache,
  selectAccount,
  buildEnvelopeRequest,
  buildRecipientViewRequest,
  buildEmbeddedSigningClient,
  buildEmbeddedSigningOrigins,
  signingAppOrigin,
  loadTemplateConfig,
  DocusignRequestError,
  isAccountCapacityError,
  type DocusignConfig,
  type UserinfoAccount,
} from "../lib/docusign";
import { formatDateOfLoss, signingDateParts } from "../lib/agreement-dates";

// Verifies the DocuSign authentication chain without creating an envelope.
//
// The offline sections prove assertion construction, account selection and
// token caching using a throwaway keypair and a stubbed fetch, so they run on
// any machine. The live section only runs when credentials are present.
// Nothing here prints key material, assertions or tokens.

const REQUIRED_VARS = [
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_API_ACCOUNT_ID",
  "DOCUSIGN_RSA_PRIVATE_KEY",
  "DOCUSIGN_OAUTH_HOST",
];

function report(section: string, checks: [string, boolean][]): void {
  console.log(`\n${section}`);
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  }
  if (checks.some(([, passed]) => !passed)) {
    throw new Error(`${section} failed`);
  }
}

function reportConfig(): boolean {
  console.log("Configuration (names only):");
  for (const name of REQUIRED_VARS) {
    console.log(`  ${process.env[name]?.trim() ? "set    " : "missing"}  ${name}`);
  }
  return isDocusignConfigured();
}

/** A usable private key so loadDocusignConfig accepts the fixture environments. */
function throwawayKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

function fixtureEnv(privateKey: string, integrationKey: string): NodeJS.ProcessEnv {
  return {
    DOCUSIGN_INTEGRATION_KEY: integrationKey,
    DOCUSIGN_USER_ID: "self-test-user-id",
    DOCUSIGN_API_ACCOUNT_ID: "self-test-account-id",
    DOCUSIGN_RSA_PRIVATE_KEY: privateKey,
    DOCUSIGN_OAUTH_HOST: "account-d.docusign.com",
  } as NodeJS.ProcessEnv;
}

function verifyAssertionOffline(privateKey: string, publicKey: string): void {
  const config: DocusignConfig = {
    integrationKey: "self-test-integration-key",
    userId: "self-test-user-id",
    accountId: "self-test-account-id",
    privateKey,
    oauthHost: "account-d.docusign.com",
  };

  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = createAssertion(config, issuedAt);
  const segments = assertion.split(".");
  if (segments.length !== 3) throw new Error("Assertion is not a three-segment JWT");
  const [header, payload, signature] = segments as [string, string, string];

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  const signatureValid = verifier.verify(publicKey, Buffer.from(signature, "base64url"));

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const headerClaims = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));

  report("Offline assertion self-test (throwaway keypair):", [
    ["three JWT segments", segments.length === 3],
    ["alg is RS256", headerClaims.alg === "RS256"],
    ["signature verifies", signatureValid],
    ["iss is the integration key", claims.iss === config.integrationKey],
    ["sub is the impersonated user", claims.sub === config.userId],
    ["aud is the OAuth host", claims.aud === config.oauthHost],
    ["scope requests signature + impersonation", claims.scope === "signature impersonation"],
    ["expiry within one hour", claims.exp - claims.iat <= 3600],
    ["iat backdated for clock skew", claims.iat < issuedAt && issuedAt - claims.iat <= 60],
    ["base64url is unpadded", !assertion.includes("=") && !assertion.includes("+") && !assertion.includes("/")],
  ]);
}

function verifyKeyNormalization(): void {
  const escaped = "-----BEGIN RSA PRIVATE KEY-----\\nAAAA\\n-----END RSA PRIVATE KEY-----";
  const config = loadDocusignConfig({
    DOCUSIGN_INTEGRATION_KEY: "k",
    DOCUSIGN_USER_ID: "u",
    DOCUSIGN_API_ACCOUNT_ID: "a",
    DOCUSIGN_RSA_PRIVATE_KEY: escaped,
    DOCUSIGN_OAUTH_HOST: "https://account-d.docusign.com/",
  } as NodeJS.ProcessEnv);

  report("Private-key normalisation:", [
    ["escaped newlines restored", config.privateKey.includes("\n") && !config.privateKey.includes("\\n")],
    ["scheme stripped from OAuth host", config.oauthHost === "account-d.docusign.com"],
  ]);
}

function verifyMissingConfigIsReported(): void {
  let namesOnly = false;
  try {
    loadDocusignConfig({} as NodeJS.ProcessEnv);
  } catch (error) {
    namesOnly = REQUIRED_VARS.every((name) => (error as Error).message.includes(name));
  }
  report("Missing-configuration handling:", [["error names every missing variable", namesOnly]]);
}

const account = (id: string, isDefault: boolean): UserinfoAccount => ({
  account_id: id,
  account_name: `account-${id}`,
  base_uri: "https://demo.docusign.net",
  is_default: isDefault,
});

/**
 * The regression guard for strict account matching. A fallback to the default
 * account would send envelopes from an account nobody configured.
 */
function verifyAccountSelection(): void {
  const wanted = account("configured", false);
  const other = account("someone-elses-default", true);

  const picked = selectAccount([other, wanted], "configured");

  let threwWhenAbsent = false;
  let messageIsIdentifierFree = false;
  try {
    selectAccount([other], "configured");
  } catch (error) {
    threwWhenAbsent = true;
    const message = (error as Error).message;
    messageIsIdentifierFree =
      message.includes("DOCUSIGN_API_ACCOUNT_ID") &&
      !message.includes("configured") &&
      !message.includes("someone-elses-default");
  }

  let threwOnEmpty = false;
  try {
    selectAccount([], "configured");
  } catch {
    threwOnEmpty = true;
  }

  report("Strict account selection:", [
    ["configured account is chosen over the default", picked.account_id === wanted.account_id],
    ["absent configured account throws", threwWhenAbsent],
    ["no silent fallback to the default account", threwWhenAbsent],
    ["error names the variable, not the identifiers", messageIsIdentifierFree],
    ["empty account list throws", threwOnEmpty],
  ]);
}

interface FetchStub {
  calls: number;
  release: () => void;
  restore: () => void;
}

/** Replaces global fetch with a token endpoint that only resolves on release(). */
function stubTokenEndpoint(): FetchStub {
  const original = globalThis.fetch;
  const pending: (() => void)[] = [];
  const stub: FetchStub = {
    calls: 0,
    release: () => {
      while (pending.length) pending.shift()!();
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };

  globalThis.fetch = (async () => {
    stub.calls += 1;
    const serial = stub.calls;
    await new Promise<void>((resolve) => pending.push(resolve));
    return new Response(JSON.stringify({ access_token: `stub-${serial}`, expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return stub;
}

async function verifyTokenCaching(privateKey: string): Promise<void> {
  const envA = fixtureEnv(privateKey, "integration-key-a");
  const envB = fixtureEnv(privateKey, "integration-key-b");
  const stub = stubTokenEndpoint();

  try {
    resetTokenCache();

    // Concurrent callers must share one in-flight request.
    const concurrent = Promise.all([getAccessToken(envA), getAccessToken(envA), getAccessToken(envA)]);
    stub.release();
    const [first, second, third] = await concurrent;
    const singleFlight = stub.calls === 1 && first === second && second === third;

    // A settled token is reused for the same configuration.
    const cachedCalls = stub.calls;
    await getAccessToken(envA);
    const reusesCache = stub.calls === cachedCalls;

    // A different configuration identity must not reuse it.
    const beforeB = stub.calls;
    const promiseB = getAccessToken(envB);
    stub.release();
    const tokenB = await promiseB;
    const separateIdentity = stub.calls === beforeB + 1 && tokenB !== first;

    // resetTokenCache clears the settled token.
    resetTokenCache();
    const beforeReset = stub.calls;
    const afterReset = getAccessToken(envA);
    stub.release();
    await afterReset;
    const resetClearsToken = stub.calls === beforeReset + 1;

    // resetTokenCache also clears an unsettled in-flight request, so the next
    // caller starts a new one instead of awaiting a request nobody owns.
    resetTokenCache();
    const abandoned = getAccessToken(envA).catch(() => undefined);
    const beforeSecond = stub.calls;
    resetTokenCache();
    const replacement = getAccessToken(envA);
    const resetClearsInFlight = stub.calls === beforeSecond + 1;
    stub.release();
    await Promise.all([abandoned, replacement]);

    report("Token caching:", [
      ["concurrent callers share one token request", singleFlight],
      ["a settled token is reused", reusesCache],
      ["a different configuration mints its own token", separateIdentity],
      ["resetTokenCache clears the cached token", resetClearsToken],
      ["resetTokenCache clears the in-flight request", resetClearsInFlight],
    ]);
  } finally {
    stub.restore();
    // The live chain must never inherit a stubbed token.
    resetTokenCache();
  }
}

async function verifyLiveChain(): Promise<void> {
  console.log("\nLive Sandbox chain:");
  resetTokenCache();

  const resolved = await getUserInfo();
  const configured = loadDocusignConfig().accountId;

  console.log("  PASS  access token obtained");
  console.log("  PASS  userinfo retrieved");
  console.log(
    `  ${resolved.accountId === configured ? "PASS" : "FAIL"}  resolved account matches DOCUSIGN_API_ACCOUNT_ID`
  );
  console.log(`  account name : ${resolved.accountName}`);
  console.log(`  API base URI : ${resolved.baseUri}`);
  console.log(`  user         : ${resolved.userName}`);

  if (resolved.accountId !== configured) {
    throw new Error("Resolved DocuSign account does not match DOCUSIGN_API_ACCOUNT_ID");
  }
}

/**
 * The envelope and recipient-view request bodies, checked without a network
 * call. The signer model is patient-only, so the shape is fixed: one role, no
 * counter-signature, no routing order.
 */
function verifyEnvelopeRequests(privateKey: string): void {
  const template = { templateId: "template-under-test", roleName: "Patient" };
  const agreementId = "8f14e45f-ceea-467a-9f6c-8d0a1b2c3d4e";
  const submissionId = "11111111-2222-4333-8444-555555555555";
  const signer = { email: "patient@example.test", name: "Pat Patient", clientUserId: agreementId };

  const envelope = buildEnvelopeRequest(template, signer);
  const prefilled = buildEnvelopeRequest(template, signer, [
    { tabLabel: "dateOfLoss", value: "January 15, 2026" },
    { tabLabel: "agreementSignedDay", value: "9" },
    { tabLabel: "agreementSignedMonth", value: "September" },
    { tabLabel: "agreementSignedYear", value: "26" },
  ]);
  const prefilledTabs = prefilled.templateRoles[0]!.tabs?.textTabs ?? [];
  const view = buildRecipientViewRequest(signer, "https://frontend.example.test/en/intake/agreement/return");
  const sandboxEmbedding = buildEmbeddedSigningOrigins("https://frontend.example.test/", "account-d.docusign.com");
  const embeddedView = buildRecipientViewRequest(
    signer,
    "https://frontend.example.test/en/intake/agreement/return",
    sandboxEmbedding
  );
  const serialized = JSON.stringify([envelope, view, embeddedView, prefilled]);

  report("Envelope and recipient-view requests:", [
    ["exactly one template role", envelope.templateRoles.length === 1],
    ["the role is the configured template role", envelope.templateRoles[0]!.roleName === template.roleName],
    ["no routing order is set", !("routingOrder" in envelope.templateRoles[0]!)],
    ["clientUserId is the agreement id", envelope.templateRoles[0]!.clientUserId === agreementId],
    ["clientUserId is never the submission id", envelope.templateRoles[0]!.clientUserId !== submissionId],
    ["the envelope is sent rather than drafted", envelope.status === "sent"],
    ["a plain envelope carries no prefilled tabs", !("tabs" in envelope.templateRoles[0]!)],
    ["prefilled values attach to the signer role", prefilledTabs.length === 4],
    [
      "date of loss is placed under its own label",
      prefilledTabs.some((tab) => tab.tabLabel === "dateOfLoss" && tab.value === "January 15, 2026"),
    ],
    [
      "the three signing-date pieces are all present",
      ["agreementSignedDay", "agreementSignedMonth", "agreementSignedYear"].every((label) =>
        prefilledTabs.some((tab) => tab.tabLabel === label)
      ),
    ],
    [
      "only the intended data labels are prefilled",
      prefilledTabs.every((tab) =>
        ["dateOfLoss", "agreementSignedDay", "agreementSignedMonth", "agreementSignedYear"].includes(tab.tabLabel)
      ),
    ],
    [
      "the recipient view matches the envelope recipient",
      view.email === envelope.templateRoles[0]!.email &&
        view.userName === envelope.templateRoles[0]!.name &&
        view.clientUserId === envelope.templateRoles[0]!.clientUserId,
    ],
    [
      "no private key material in either request",
      !serialized.includes("PRIVATE KEY") && !serialized.includes(privateKey.slice(40, 80)),
    ],
    ["no access token in either request", !/access[_-]?token/i.test(serialized)],
    ["a view without embedding carries no frame-ancestors", !("frameAncestors" in view)],
    [
      "the embedded view may be framed by the application origin and the demo app only",
      JSON.stringify(embeddedView.frameAncestors) ===
        JSON.stringify(["https://frontend.example.test", "https://apps-d.docusign.com"]),
    ],
    [
      "the embedded view accepts messages from the demo app only",
      JSON.stringify(embeddedView.messageOrigins) === JSON.stringify(["https://apps-d.docusign.com"]),
    ],
    [
      "a production OAuth host selects the production signing app",
      signingAppOrigin("account.docusign.com") === "https://apps.docusign.com" &&
        buildEmbeddedSigningOrigins("https://app.example.com", "account.docusign.com").frameAncestors[1] ===
          "https://apps.docusign.com",
    ],
    [
      "the sandbox client loads the demo library with the integration key",
      JSON.stringify(buildEmbeddedSigningClient("account-d.docusign.com", "integration-key-under-test")) ===
        JSON.stringify({
          scriptUrl: "https://js-d.docusign.com/bundle.js",
          integrationKey: "integration-key-under-test",
        }),
    ],
    [
      "a production host loads the production library",
      buildEmbeddedSigningClient("account.docusign.com", "k").scriptUrl === "https://js.docusign.com/bundle.js",
    ],
    [
      "the frontend origin is normalised to scheme and host",
      buildEmbeddedSigningOrigins("http://13.222.146.180/en/", "account-d.docusign.com").frameAncestors[0] ===
        "http://13.222.146.180",
    ],
  ]);
}

/**
 * Language selection is the security-relevant part of the template layer: a
 * patient must never be shown the other language's retainer, and a missing
 * template must fail loudly rather than fall back.
 */
function verifyTemplateSelection(): void {
  const env = {
    DOCUSIGN_TEMPLATE_ID_EN: "en-template",
    DOCUSIGN_TEMPLATE_ID_ES: "es-template",
    DOCUSIGN_TEMPLATE_ROLE_NAME: "Patient",
  } as NodeJS.ProcessEnv;

  const en = loadTemplateConfig("en", env);
  const es = loadTemplateConfig("es", env);

  const named = (locale: string, partial: NodeJS.ProcessEnv, variable: string): boolean => {
    try {
      loadTemplateConfig(locale, partial);
      return false;
    } catch (error) {
      return (error as Error).message.includes(variable);
    }
  };

  let unsupportedLocaleRejected = false;
  try {
    loadTemplateConfig("fr", env);
  } catch {
    unsupportedLocaleRejected = true;
  }

  report("Language template selection:", [
    ["English selects the EN template", en.templateId === "en-template"],
    ["Spanish selects the ES template", es.templateId === "es-template"],
    ["English never resolves to the ES template", en.templateId !== "es-template"],
    ["Spanish never resolves to the EN template", es.templateId !== "en-template"],
    ["both templates share the configured role", en.roleName === "Patient" && es.roleName === "Patient"],
    [
      "a missing EN template names DOCUSIGN_TEMPLATE_ID_EN",
      named(
        "en",
        { DOCUSIGN_TEMPLATE_ID_ES: "es", DOCUSIGN_TEMPLATE_ROLE_NAME: "Patient" } as NodeJS.ProcessEnv,
        "DOCUSIGN_TEMPLATE_ID_EN"
      ),
    ],
    [
      "a missing ES template names DOCUSIGN_TEMPLATE_ID_ES",
      named(
        "es",
        { DOCUSIGN_TEMPLATE_ID_EN: "en", DOCUSIGN_TEMPLATE_ROLE_NAME: "Patient" } as NodeJS.ProcessEnv,
        "DOCUSIGN_TEMPLATE_ID_ES"
      ),
    ],
    [
      "a missing role names DOCUSIGN_TEMPLATE_ROLE_NAME",
      named("en", { DOCUSIGN_TEMPLATE_ID_EN: "en" } as NodeJS.ProcessEnv, "DOCUSIGN_TEMPLATE_ROLE_NAME"),
    ],
    ["an unsupported locale is refused rather than defaulted", unsupportedLocaleRejected],
  ]);
}

/**
 * The values that go into the retainer's locked fields. Wrong formatting here is
 * printed onto a legal document, so both languages are pinned.
 */
function verifyDateFormatting(): void {
  // A mid-day instant, safe from any timezone rolling it to an adjacent day.
  const midday = new Date("2026-09-05T15:00:00Z");
  const en = signingDateParts(midday, "en");
  const es = signingDateParts(midday, "es");

  report("Retainer date formatting:", [
    ["date of loss is long-form English", formatDateOfLoss("2026-09-05", "en") === "September 5, 2026"],
    ["date of loss is long-form Spanish", formatDateOfLoss("2026-09-05", "es") === "5 de septiembre de 2026"],
    ["a non-date yields null, never 'Invalid Date'", formatDateOfLoss("not-a-date", "en") === null],
    ["signing day is the day of the month", en.day === "5"],
    ["signing month is the English month name", en.month === "September"],
    ["signing month is localized for Spanish", es.month === "septiembre"],
    ["signing year is two digits for the '20__' line", en.year === "26"],
  ]);
}

/**
 * DocuSign's refusals arrive as an error code plus a message. The account's
 * cumulative recipient cap and the call-rate limits are capacity, not a fault in
 * the request, and the agreement route answers them differently.
 */
function verifyRefusalClassification(): void {
  const capacity = new DocusignRequestError(
    400,
    "RECIPIENT_LIMIT_EXCEEDED",
    "You have reached the maximum number of recipients permitted for a single transaction in your account."
  );
  const hourly = new DocusignRequestError(429, "HOURLY_APIINVOCATION_LIMIT_EXCEEDED", "");
  const invalid = new DocusignRequestError(400, "TEMPLATE_ID_INVALID", "Invalid template id");
  const plain = new Error("DocuSign request failed (400): RECIPIENT_LIMIT_EXCEEDED");

  report("Refusal classification", [
    ["the recipient cap is account capacity", isAccountCapacityError(capacity)],
    ["an API call-rate limit is account capacity", isAccountCapacityError(hourly)],
    ["an invalid template is not capacity", !isAccountCapacityError(invalid)],
    ["a plain Error is never capacity, whatever its text", !isAccountCapacityError(plain)],
    ["the message keeps the code and DocuSign's detail", /RECIPIENT_LIMIT_EXCEEDED — You have reached/.test(capacity.message)],
    ["the code is kept as a field", capacity.errorCode === "RECIPIENT_LIMIT_EXCEEDED" && capacity.status === 400],
  ]);
}

async function main(): Promise<void> {
  const configured = reportConfig();
  const { privateKey, publicKey } = throwawayKeyPair();

  verifyKeyNormalization();
  verifyMissingConfigIsReported();
  verifyAssertionOffline(privateKey, publicKey);
  verifyAccountSelection();
  verifyEnvelopeRequests(privateKey);
  verifyTemplateSelection();
  verifyDateFormatting();
  verifyRefusalClassification();
  await verifyTokenCaching(privateKey);

  if (!configured) {
    console.log("\nSkipping live chain: DocuSign credentials are not configured.");
    console.log("Offline checks passed. Set the variables above to run the live check.");
    return;
  }

  await verifyLiveChain();
  const en = process.env.DOCUSIGN_TEMPLATE_ID_EN?.trim();
  const es = process.env.DOCUSIGN_TEMPLATE_ID_ES?.trim();
  const role = process.env.DOCUSIGN_TEMPLATE_ROLE_NAME?.trim();
  console.log("\nAuthentication chain verified.");
  console.log(
    en && es && role
      ? "  DOCUSIGN_TEMPLATE_ID_EN, DOCUSIGN_TEMPLATE_ID_ES and DOCUSIGN_TEMPLATE_ROLE_NAME are set; both languages are configured."
      : "  Envelope creation stays blocked: set DOCUSIGN_TEMPLATE_ID_EN, DOCUSIGN_TEMPLATE_ID_ES and DOCUSIGN_TEMPLATE_ROLE_NAME."
  );
}

main().catch((error) => {
  console.error(`\nDocuSign check failed: ${(error as Error).message}`);
  process.exit(1);
});
