import "dotenv/config";
import { setDefaultResultOrder } from "dns";
import { join } from "path";
import { runMigrations } from "../lib/migrations";
import { createPostgresClient } from "../lib/postgres-client";

setDefaultResultOrder("ipv4first");

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  return databaseUrl;
}

async function migrate() {
  const client = await createPostgresClient(getDatabaseUrl());

  try {
    await client.connect();
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENETUNREACH") {
      console.error(`Migration failed: ${error.message}`);
      console.error(
        "The database host is unreachable from this network. " +
          "Update DATABASE_URL to the Supabase Session Pooler URI (port 5432)."
      );
      process.exit(1);
    }
    throw err;
  }

  console.log("Running migrations...");

  const migrationsDirectory = process.env.MIGRATIONS_DIR
    ? join(process.env.MIGRATIONS_DIR)
    : join(__dirname, "../../supabase/migrations");

  try {
    const result = await runMigrations(client, migrationsDirectory);
    for (const migration of result.applied) console.log(`Applied ${migration}`);
    for (const migration of result.skipped) console.log(`Already applied ${migration}`);
    console.log(`✓ Migrations complete (${result.applied.length} applied, ${result.skipped.length} skipped)`);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
