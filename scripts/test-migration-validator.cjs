const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const validator = path.resolve(__dirname, "validate-migration.cjs");

function validate(sql) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "haa-validator-"));
  try {
    fs.writeFileSync(path.join(directory, "001_change.sql"), sql);
    return spawnSync(process.execPath, [validator], {
      env: { ...process.env, MIGRATIONS_DIR: directory },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

assert.equal(
  validate("-- never DROP TABLE here\ncreate table if not exists safe_example (id uuid);\n").status,
  0
);

for (const sql of [
  "drop table existing_data;",
  "alter table existing_data drop column important_value;",
  "truncate existing_data;",
  "delete from existing_data;",
  "alter table existing_data alter column amount type integer;",
  "alter table existing_data rename column old_name to new_name;",
]) {
  const result = validate(sql);
  assert.equal(result.status, 1, `validator unexpectedly accepted: ${sql}`);
  assert.match(result.stderr, /forbidden destructive operation/);
}

console.log("PASS: migration validator rejects destructive SQL and ignores comments");
