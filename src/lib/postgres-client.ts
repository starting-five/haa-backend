import { lookup } from "dns/promises";
import { Client, type ClientConfig } from "pg";

const POOLER_HINT =
  "Use the Supabase Session Pooler URI (Dashboard → Connect → Session pooler, port 5432). " +
  "Direct db.*.supabase.co hosts are often IPv6-only and fail in GitHub Actions.";

function parseDatabaseUrl(connectionString: string): ClientConfig {
  const parsed = new URL(connectionString.replace(/^postgresql:/, "postgres:"));
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());

  return {
    host: hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    ssl: localHost ? false : { rejectUnauthorized: false },
  };
}

async function resolveIpv4Host(hostname: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return hostname;
  }

  try {
    const result = await lookup(hostname, { family: 4 });
    console.log(`Resolved ${hostname} → ${result.address} (IPv4)`);
    return result.address;
  } catch {
    if (/^db\.[^.]+\.supabase\.co$/i.test(hostname)) {
      console.error(`No IPv4 address found for direct Supabase host: ${hostname}`);
      console.error(POOLER_HINT);
      process.exit(1);
    }

    throw new Error(`Could not resolve IPv4 address for database host: ${hostname}`);
  }
}

export async function createPostgresClient(connectionString: string): Promise<Client> {
  const config = parseDatabaseUrl(connectionString);
  const hostname = config.host;

  if (!hostname) {
    throw new Error("DATABASE_URL is missing a hostname.");
  }

  config.host = await resolveIpv4Host(hostname);

  return new Client(config);
}

export function getDatabaseHost(connectionString: string): string {
  return parseDatabaseUrl(connectionString).host ?? "";
}
