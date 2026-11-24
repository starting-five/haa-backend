import "dotenv/config";
import { execFileSync } from "child_process";
import { createPostgresClient, getDatabaseHost } from "../lib/postgres-client";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

// submission_companions was added in 001 but never added here, so a reset left
// its rows behind while cascade removed the foreign key that gave them meaning.
// Re-running 001 then skipped the table, because it is created "if not exists",
// leaving stale companions attached to submissions that no longer exist.
const DROP_SQL = `
  drop table if exists ambassador_profiles cascade;
  drop table if exists user_roles cascade;
  drop table if exists profiles cascade;
  drop table if exists review_decision_events cascade;
  drop table if exists review_assignments cascade;
  drop table if exists documents cascade;
  drop table if exists submission_companions cascade;
  drop table if exists accidents cascade;
  drop table if exists claimants cascade;
  drop table if exists intake_submissions cascade;
  drop table if exists lawyers cascade;
  drop table if exists haa_schema_migrations;
`;

async function reset() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const environment = process.env.NODE_ENV?.trim();

  if (environment !== "development" && environment !== "test") {
    console.error("✗ db:reset is allowed only when NODE_ENV is development or test");
    process.exit(1);
  }

  if (process.env.ALLOW_DB_RESET !== "true") {
    console.error("✗ Set ALLOW_DB_RESET=true in your .env to confirm reset");
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is required");
    process.exit(1);
  }

  const host = getDatabaseHost(databaseUrl).toLowerCase();
  const isLocalHost = LOCAL_HOSTS.includes(host);

  if (!isLocalHost) {
    if (process.env.ALLOW_REMOTE_DB_RESET !== "true") {
      console.error("✗ db:reset is restricted to local hosts unless ALLOW_REMOTE_DB_RESET=true");
      process.exit(1);
    }

    const expectedToken = host;
    const providedToken = process.env.RESET_CONFIRM_HOST?.trim().toLowerCase();
    if (!providedToken || providedToken !== expectedToken) {
      console.error(`✗ Remote reset blocked. Set RESET_CONFIRM_HOST=${expectedToken} to confirm.`);
      process.exit(1);
    }

    console.warn(`⚠ Remote reset override accepted for host: ${host}`);
  }

  const client = await createPostgresClient(databaseUrl);
  await client.connect();

  console.log("⚠ Dropping all tables...");

  try {
    await client.query(DROP_SQL);
    console.log("✓ Tables dropped");

    // Re-run migrations to rebuild from scratch
    execFileSync("tsx", ["src/scripts/migrate.ts"], { stdio: "inherit" });
  } catch (err) {
    console.error("Reset failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

reset();
