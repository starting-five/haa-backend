import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Client } from "pg";

const MIGRATION_NAME = /^(\d{3,})_[a-z0-9][a-z0-9_]*\.sql$/;
type MigrationClient = Pick<Client, "query">;

interface MigrationFile {
  version: string;
  filename: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  filename: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function loadMigrations(migrationsDirectory: string): MigrationFile[] {
  const filenames = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (filenames.length === 0) throw new Error(`No SQL migrations found in ${migrationsDirectory}`);

  const migrations = filenames.map((filename) => {
    const version = MIGRATION_NAME.exec(filename)?.[1];
    if (!version) throw new Error(`Invalid migration filename: ${filename}`);
    const sql = readFileSync(join(migrationsDirectory, filename), "utf8");
    return {
      version,
      filename,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
    };
  });

  const versions = migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) throw new Error("Migration versions must be unique");
  return migrations;
}

export async function runMigrations(client: MigrationClient, migrationsDirectory: string): Promise<MigrationResult> {
  const migrations = loadMigrations(migrationsDirectory);
  const applied: string[] = [];
  const skipped: string[] = [];

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('haa-backend-migrations'))");
    await client.query(`
      create table if not exists haa_schema_migrations (
        version text primary key,
        filename text not null unique,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const result = await client.query<AppliedMigration>(
      "select version, filename, checksum from haa_schema_migrations order by version"
    );
    const appliedByVersion = new Map(result.rows.map((row) => [row.version, row]));
    const repositoryVersions = new Set(migrations.map((migration) => migration.version));

    for (const existing of result.rows) {
      if (!repositoryVersions.has(existing.version)) {
        throw new Error(`Applied migration ${existing.version} (${existing.filename}) is missing`);
      }
    }

    for (const migration of migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.filename !== migration.filename || existing.checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.version} was renamed or edited`);
        }
        skipped.push(migration.filename);
        continue;
      }

      await client.query(migration.sql);
      await client.query("insert into haa_schema_migrations (version, filename, checksum) values ($1, $2, $3)", [
        migration.version,
        migration.filename,
        migration.checksum,
      ]);
      applied.push(migration.filename);
    }

    await client.query("commit");
    return { applied, skipped };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
