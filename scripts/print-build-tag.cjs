const path = require("node:path");
const { readFileSync } = require("node:fs");

const { createGitRunner, resolveBuildTag } = require("./app-version.cjs");

// Prints the internal tag of the commit checked out — <public version>.<build
// number>, e.g. 0.1.0-rc8.95 — for the pipeline to tag the image with beside
// its commit SHA. It is never the public version.

const repositoryRoot = path.resolve(__dirname, "..");
const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

process.stdout.write(`${resolveBuildTag({ version, env: process.env, git: createGitRunner(repositoryRoot) })}\n`);
