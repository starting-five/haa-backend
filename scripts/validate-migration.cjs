const fs = require("fs");
const path = require("path");

const migrationsDir = path.resolve(
  process.env.MIGRATIONS_DIR || path.join(__dirname, "../supabase/migrations")
);
const files = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()
  : [];
const errors = [];

if (files.length === 0) errors.push(`No SQL migrations found in ${migrationsDir}`);
const invalidNames = files.filter((file) => !/^\d{3,}_[a-z0-9][a-z0-9_]*\.sql$/.test(file));
if (invalidNames.length) errors.push(`Invalid migration filenames: ${invalidNames.join(", ")}`);

const versions = files.map((file) => file.split("_", 1)[0]);
const duplicateVersions = versions.filter((version, index) => versions.indexOf(version) !== index);
if (duplicateVersions.length) errors.push(`Duplicate migration versions: ${[...new Set(duplicateVersions)]}`);

const forbidden = [
  ["DROP DATABASE", /\bdrop\s+database\b/i],
  ["DROP SCHEMA", /\bdrop\s+schema\b/i],
  ["DROP TABLE", /\bdrop\s+table\b/i],
  ["DROP VIEW/TYPE/INDEX", /\bdrop\s+(?:materialized\s+)?(?:view|type|index)\b/i],
  ["TRUNCATE", /\btruncate\b/i],
  ["DELETE FROM", /\bdelete\s+from\b/i],
  ["ALTER TABLE DROP COLUMN", /\balter\s+table\b[\s\S]*?\bdrop\s+column\b/i],
  ["ALTER TABLE RENAME", /\balter\s+table\b[\s\S]*?\brename\s+(?:column|to)\b/i],
  ["ALTER COLUMN TYPE", /\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i],
];

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ");
  if (!sql.trim()) errors.push(`${file} is empty`);
  for (const [label, pattern] of forbidden) {
    if (pattern.test(sql)) errors.push(`${file} contains forbidden destructive operation: ${label}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error("Migration validation failed; release must stop.");
  process.exit(1);
}
console.log(`PASS: ${files.length} ordered migration(s) contain no forbidden destructive operations`);
