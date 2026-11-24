// What this build is, and where it is running.
//
// The two halves come from different places on purpose. Version, commit and
// build identity are baked into the image at build time and never change
// afterwards, so the same artefact can be promoted from alpha to beta to
// production and still answer with the commit it was built from. The
// environment is read from the process environment, because it is the one
// thing that differs between those deployments.
//
// Nothing here queries the database, runs git, or reads a secret — every value
// is either a build argument or a plain deployment variable, and the response
// is safe to serve publicly.

export const BACKEND_APPLICATION_NAME = "haa-backend";

/** Deployments this application knows how to be. Anything else reads as unknown. */
export const KNOWN_ENVIRONMENTS = ["local", "alpha", "beta", "staging", "production"] as const;

export type KnownEnvironment = (typeof KNOWN_ENVIRONMENTS)[number];

export const UNKNOWN = "unknown";

export interface BuildInfo {
  application: string;
  version: string;
  gitSha: string;
  environment: KnownEnvironment | typeof UNKNOWN;
  buildId?: string;
  builtAt?: string;
  imageDigest?: string;
}

// The public version only — MAJOR.MINOR.PATCH, MAJOR.MINOR.PATCH-rcN or
// MAJOR.MINOR.PATCH-beta (scripts/app-version.cjs). The build number is never
// part of it.
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc[1-9]\d*|-beta)?$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function normalize(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A value that does not match its shape is reported as unknown rather than
 * echoed back: a version endpoint that repeats whatever is in the environment
 * is a place for something else to end up.
 */
function match(value: string | undefined, pattern: RegExp, transform?: (input: string) => string): string | null {
  const normalized = transform ? transform(normalize(value)) : normalize(value);
  return normalized && pattern.test(normalized) ? normalized : null;
}

function readEnvironment(value: string | undefined): KnownEnvironment | typeof UNKNOWN {
  const normalized = normalize(value).toLowerCase();
  return (KNOWN_ENVIRONMENTS as readonly string[]).includes(normalized) ? (normalized as KnownEnvironment) : UNKNOWN;
}

function readBuiltAt(value: string | undefined): string | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const buildId = match(env.HAA_BUILD_ID, BUILD_ID_PATTERN);
  const builtAt = readBuiltAt(env.HAA_BUILT_AT);
  const imageDigest = match(env.HAA_IMAGE_DIGEST, IMAGE_DIGEST_PATTERN, (input) => input.toLowerCase());

  return {
    application: BACKEND_APPLICATION_NAME,
    version: match(env.HAA_APP_VERSION, VERSION_PATTERN) ?? UNKNOWN,
    gitSha: match(env.HAA_GIT_SHA, GIT_SHA_PATTERN, (input) => input.toLowerCase()) ?? UNKNOWN,
    environment: readEnvironment(env.HAA_ENVIRONMENT),
    ...(buildId ? { buildId } : {}),
    ...(builtAt ? { builtAt } : {}),
    ...(imageDigest ? { imageDigest } : {}),
  };
}
