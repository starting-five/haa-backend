const path = require("node:path");
const { readFileSync } = require("node:fs");

const { resolveAppVersion } = require("./app-version.cjs");

// Prints the public version — package.json's version, e.g. 0.1.0-rc8 — for the
// build pipeline to pass to docker as a build argument. It is what GET /version
// reports. Nothing here reaches the container: the container is told what it
// is, and never has to work it out.

const repositoryRoot = path.resolve(__dirname, "..");
const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

process.stdout.write(`${resolveAppVersion({ version, env: process.env })}\n`);
