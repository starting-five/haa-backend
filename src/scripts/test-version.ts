import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { AddressInfo } from "net";

// Proves the version endpoint and the version derivation behind it.
//
// Three things are checked: that a build's identity survives into the running
// process and out of GET /version, that the environment is a runtime value the
// same image reports differently in alpha and in production, and that neither
// an absent nor a malformed value is ever echoed back to a caller.
//
// No database, no network and no repository checkout are needed — which is the
// point of the endpoint.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

const {
  countBuildsSinceVersion,
  createGitRunner,
  formatAppVersion,
  parseAppVersion,
  resolveAppVersion,
  resolveBuildNumber,
  resolveBuildTag,
  validateAppVersion,
  validateBaseVersion,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("../../scripts/app-version.cjs");

const temporaryDirectories: string[] = [];

function createRepository(): {
  directory: string;
  git: (args: string[]) => string;
  commit: (version: string | null, message: string) => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "haa-version-"));
  temporaryDirectories.push(directory);

  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  run(["init", "--initial-branch=main"]);
  run(["config", "user.email", "release@example.test"]);
  run(["config", "user.name", "Release"]);

  let counter = 0;
  const commit = (version: string | null, message: string) => {
    if (version) {
      writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ name: "api", version }, null, 2)}\n`);
      run(["add", "package.json"]);
    } else {
      counter += 1;
      writeFileSync(path.join(directory, `change-${counter}.txt`), message);
      run(["add", `change-${counter}.txt`]);
    }
    run(["commit", "-m", message]);
  };

  return { directory, git: createGitRunner(directory), commit };
}

async function main(): Promise<void> {
  // ── the public version and the internal build ─────────────────────────────
  // The public version is package.json's version (0.1.0-rc8); the build number
  // counts commits since it was set, and never becomes part of it.
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const repository = createRepository();
  repository.commit("0.1.0-rc8", "Release candidate 8");
  record("the commit that sets the version is build 1", countBuildsSinceVersion(repository.git, "0.1.0-rc8") === 1);

  repository.commit(null, "First change");
  repository.commit(null, "Second change");
  record("each later commit is the next build", countBuildsSinceVersion(repository.git, "0.1.0-rc8") === 3);
  record(
    "the public version does not move with the build",
    resolveAppVersion({ version: "0.1.0-rc8", env: {} }) === "0.1.0-rc8"
  );
  record(
    "the build tag carries the build beside the version",
    resolveBuildTag({ version: "0.1.0-rc8", env: {}, git: repository.git }) === "0.1.0-rc8.3"
  );

  repository.commit("0.1.0-rc9", "Release candidate 9");
  record(
    "rc9 is one package.json edit, and its builds start again at 1",
    resolveAppVersion({ version: "0.1.0-rc9", env: {} }) === "0.1.0-rc9" &&
      resolveBuildTag({ version: "0.1.0-rc9", env: {}, git: repository.git }) === "0.1.0-rc9.1"
  );
  record(
    "rc8 → rc9 → rc10 format as candidates",
    formatAppVersion("0.1.0", 9) === "0.1.0-rc9" &&
      formatAppVersion("0.1.0", 10) === "0.1.0-rc10" &&
      parseAppVersion("0.1.0-rc8").releaseCandidate === 8
  );
  repository.commit("0.1.0-beta", "Public beta");
  record(
    "the public beta is one package.json edit, and its builds start again at 1",
    resolveAppVersion({ version: "0.1.0-beta", env: {} }) === "0.1.0-beta" &&
      resolveBuildTag({ version: "0.1.0-beta", env: {}, git: repository.git }) === "0.1.0-beta.1"
  );
  record(
    "the public beta is a prerelease, but not a release candidate",
    (() => {
      const beta = parseAppVersion("0.1.0-beta");
      return beta.base === "0.1.0" && beta.releaseCandidate === null && beta.isPrerelease === true;
    })()
  );
  // the version is kept in package.json and in the lockfile's root, which npm
  // reads back — a release candidate changes all three together
  const ownLock = JSON.parse(readFileSync(path.join(__dirname, "../../package-lock.json"), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  record(
    "this repository is release candidate 2 of 0.1.1, 0.1.1-rc2, in package.json and in the lockfile",
    resolveAppVersion({
      version: JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8")).version,
      env: {},
    }) === "0.1.1-rc2" &&
      ownLock.version === "0.1.1-rc2" &&
      ownLock.packages[""]?.version === "0.1.1-rc2"
  );

  record(
    "the old build-numbered format and a build tag are not public versions",
    ["1.0.0-rc.95", "0.1.0-rc8.95", "RC3", "0.1.0-rc0", "0.1.0-RC8"].every((value) =>
      throws(() => validateAppVersion(value))
    )
  );
  record(
    "0.1.0-beta is a public version; beta1, Beta, a beta build tag and beta-rc1 are not",
    validateAppVersion("0.1.0-beta") === "0.1.0-beta" &&
      ["0.1.0-beta1", "0.1.0-Beta", "0.1.0-beta.1", "0.1.0-beta-rc1"].every((value) =>
        throws(() => validateAppVersion(value))
      )
  );
  record(
    "a base version cannot carry a candidate",
    throws(() => validateBaseVersion("0.1.0-rc8"))
  );
  record(
    "overrides are validated",
    resolveAppVersion({ version: "0.1.0-rc8", env: { HAA_APP_VERSION: "0.2.0-rc1" } }) === "0.2.0-rc1" &&
      throws(() => resolveAppVersion({ version: "0.1.0-rc8", env: { HAA_APP_VERSION: "1.0.0-rc.95" } })) &&
      resolveBuildNumber({ version: "0.1.0-rc8", env: { HAA_BUILD_NUMBER: "42" }, git: repository.git }) === 42 &&
      throws(() => resolveBuildNumber({ version: "0.1.0-rc8", env: { HAA_BUILD_NUMBER: "rc8" }, git: repository.git }))
  );

  // ── the endpoint ──────────────────────────────────────────────────────────
  const buildEnvironment = {
    HAA_APP_VERSION: "0.1.0-rc8",
    HAA_GIT_SHA: "231ff968d2de03db6895122e52a9388b6efb834f",
    HAA_BUILD_ID: "gha-17482912-1",
    HAA_BUILT_AT: "2026-09-22T09:15:00Z",
    HAA_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  };
  Object.assign(process.env, buildEnvironment, { HAA_ENVIRONMENT: "alpha" });

  // The app's Supabase client refuses to load without these, and importing the
  // real app is the point — the route is proven where it is actually mounted.
  // Nothing here reaches Supabase: /version opens no client and makes no call,
  // and dotenv is deliberately not loaded, so no real credential is in scope.
  process.env.SUPABASE_URL ??= "https://version-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "not-a-real-key";

  const { app } = await import("../app");
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${base}/version`);
    const body = (await response.json()) as Record<string, unknown>;

    record("GET /version answers 200", response.status === 200);
    record("it is not cached", response.headers.get("cache-control") === "no-store");
    record("it names the application", body.application === "haa-backend");
    record("it reports the public version, with no build number", body.version === "0.1.0-rc8");
    record("it reports the exact commit", body.gitSha === "231ff968d2de03db6895122e52a9388b6efb834f");
    record("it reports the deployment environment", body.environment === "alpha");
    record("it reports the build id and time", body.buildId === "gha-17482912-1" && typeof body.builtAt === "string");
    record("it reports the image digest", body.imageDigest === `sha256:${"a".repeat(64)}`);
    record(
      "it carries nothing else",
      Object.keys(body).sort().join(",") === "application,buildId,builtAt,environment,gitSha,imageDigest,version"
    );

    // The same build, started as production: only the environment moves.
    process.env.HAA_ENVIRONMENT = "production";
    const promoted = (await (await fetch(`${base}/version`)).json()) as Record<string, unknown>;
    record(
      "the same build reports a different environment when deployed elsewhere",
      promoted.environment === "production" && promoted.version === body.version && promoted.gitSha === body.gitSha
    );

    // Nothing unrecognised, absent or secret is ever echoed.
    process.env.HAA_ENVIRONMENT = "../../etc/passwd";
    record(
      "an unrecognised environment reads as unknown",
      ((await (await fetch(`${base}/version`)).json()) as Record<string, unknown>).environment === "unknown"
    );

    delete process.env.HAA_ENVIRONMENT;
    delete process.env.HAA_APP_VERSION;
    process.env.HAA_GIT_SHA = "231ff96";
    const unbuilt = (await (await fetch(`${base}/version`)).json()) as Record<string, unknown>;
    record(
      "missing or malformed build metadata reads as unknown",
      unbuilt.version === "unknown" && unbuilt.gitSha === "unknown" && unbuilt.environment === "unknown"
    );

    // The old build-numbered version and an internal build tag are not public
    // versions: an image built with either reports unknown rather than echoing it.
    const reportedVersionFor = async (value: string) => {
      process.env.HAA_APP_VERSION = value;
      return ((await (await fetch(`${base}/version`)).json()) as Record<string, unknown>).version;
    };
    record(
      "a build tag or the old rc.N format is never reported as the version",
      (await reportedVersionFor("1.0.0-rc.95")) === "unknown" &&
        (await reportedVersionFor("0.1.0-rc8.95")) === "unknown" &&
        (await reportedVersionFor("0.1.0-rc8")) === "0.1.0-rc8"
    );
    record(
      "the public beta is reported as built, and a malformed beta is not",
      (await reportedVersionFor("0.1.0-beta")) === "0.1.0-beta" &&
        (await reportedVersionFor("0.1.0-beta.1")) === "unknown" &&
        (await reportedVersionFor("0.1.0-beta1")) === "unknown"
    );
    delete process.env.HAA_APP_VERSION;

    // Assembled rather than written out: the compiled script ships inside the
    // image, and a literal that looks like a key trips secret scanners that
    // cannot tell a fixture from the real thing.
    process.env.SUPABASE_SERVICE_ROLE_KEY = ["sb", "secret", "must", "not", "leak"].join("_");
    process.env.DATABASE_URL = `postgres${"ql"}://user:${"pw"}@host:5432/postgres`;
    const serialized = JSON.stringify(await (await fetch(`${base}/version`)).json());
    record(
      "no secret sharing the environment is exposed",
      !/sb_secret|postgresql:|must_not_leak|pw@/i.test(serialized)
    );

    // /health is untouched by any of this.
    const health = await fetch(`${base}/health`);
    const healthBody = (await health.json()) as Record<string, unknown>;
    record("health still answers", health.status === 200 && healthBody.status === "ok");
  } finally {
    server.close();
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    const failed = checks.filter(([, passed]) => !passed);
    for (const [label, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    assert(failed.length === 0, `${failed.length} version check(s) failed`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
