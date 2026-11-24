import "dotenv/config";
import { strict as assert } from "assert";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { runMigrations } from "../lib/migrations";
import { createPostgresClient, getDatabaseHost } from "../lib/postgres-client";

async function verifyDataPreservation() {
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

  const parsed = new URL(databaseUrl.replace(/^postgresql:/, "postgres:"));
  assert(["localhost", "127.0.0.1", "::1"].includes(getDatabaseHost(databaseUrl)));
  assert.match(basename(parsed.pathname), /^haa_migration_test_/);

  const migrationsDirectory = mkdtempSync(join(tmpdir(), "haa-preservation-migrations-"));
  const client = await createPostgresClient(databaseUrl);

  try {
    cpSync(
      join(__dirname, "../../supabase/migrations/001_create_intake_tables.sql"),
      join(migrationsDirectory, "001_create_intake_tables.sql")
    );
    await client.connect();
    await client.query("create schema auth");
    await client.query("create table auth.users (id uuid primary key)");

    const initial = await runMigrations(client, migrationsDirectory);
    assert.deepEqual(initial.applied, ["001_create_intake_tables.sql"]);

    const claimantId = "10000000-0000-4000-8000-000000000001";
    const submissionId = "20000000-0000-4000-8000-000000000002";
    await client.query(
      `insert into claimants (id, first_name, last_name, mobile)
       values ($1, 'Existing', 'Claimant', '+15550000001')`,
      [claimantId]
    );
    await client.query("insert into intake_submissions (id, claimant_id) values ($1, $2)", [submissionId, claimantId]);

    writeFileSync(
      join(migrationsDirectory, "002_add_preservation_marker.sql"),
      "alter table intake_submissions add column if not exists preservation_marker text;\n"
    );
    const upgraded = await runMigrations(client, migrationsDirectory);
    assert.deepEqual(upgraded.applied, ["002_add_preservation_marker.sql"]);
    assert.deepEqual(upgraded.skipped, ["001_create_intake_tables.sql"]);

    const row = await client.query("select id, claimant_id, status from intake_submissions where id = $1", [
      submissionId,
    ]);
    // 'in_progress' is migration 001's default, and 001 is the only real
    // migration this test applies — the second one is written above, into a
    // temp directory, purely to have something pending. 014's rename to
    // 'intake' never runs here, so the current schema's default is not what
    // this row gets. A status rename must not touch this line.
    assert.deepEqual(row.rows, [{ id: submissionId, claimant_id: claimantId, status: "in_progress" }]);

    const column = await client.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'intake_submissions'
         and column_name = 'preservation_marker'`
    );
    assert.equal(column.rowCount, 1);

    const repeated = await runMigrations(client, migrationsDirectory);
    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(repeated.skipped, ["001_create_intake_tables.sql", "002_add_preservation_marker.sql"]);

    const preserved = await client.query("select count(*)::int as count from intake_submissions where id = $1", [
      submissionId,
    ]);
    assert.equal(preserved.rows[0]?.count, 1);
    const ledger = await client.query("select version from haa_schema_migrations order by version");
    assert.deepEqual(ledger.rows, [{ version: "001" }, { version: "002" }]);
    console.log("PASS: pending migrations preserve existing data and repeated runs are safe");
  } finally {
    await client.end().catch(() => undefined);
    rmSync(migrationsDirectory, { recursive: true, force: true });
  }
}

verifyDataPreservation().catch((error) => {
  console.error(`Data-preservation test failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
