import { strict as assert } from "assert";
import { isLawyerAcceptance, providerMatchesFor, type LawyerAssignmentRow } from "../lib/provider-matches";

// The rule the patient dashboard's team cards are drawn from, without a
// database: which review assignments make a lawyer match, that the case's status
// alone never does, and that a doctor is never matched while nothing records one.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

const CASE = "9b2e7c41-5d6a-4f38-8e1b-2c7d9a0f3e55";
const OTHER = "0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f";
const AT = "2026-10-01T10:00:00.000Z";

const row = (overrides: Partial<LawyerAssignmentRow>): LawyerAssignmentRow => ({
  submission_id: CASE,
  status: "accepted",
  accepted_at: AT,
  revoked_at: null,
  ...overrides,
});
const lawyerFor = (status: string, rows: LawyerAssignmentRow[]) =>
  providerMatchesFor({ id: CASE, status }, rows).lawyer.matched;

record("an accepted, unrevoked assignment is a lawyer acceptance", isLawyerAcceptance(row({})));
record("accepted without accepted_at is not", !isLawyerAcceptance(row({ accepted_at: null })));
record("accepted then revoked is not", !isLawyerAcceptance(row({ revoked_at: AT })));
for (const status of ["pending", "rejected", "expired", "revoked", null]) {
  record(`a ${status ?? "null"} assignment is not`, !isLawyerAcceptance(row({ status })));
}

record("no assignment: no lawyer", !lawyerFor("submitted", []));
record(
  "passed to a lawyer who has not decided: no lawyer",
  !lawyerFor("attorney", [row({ status: "pending", accepted_at: null })])
);
record("qualified by the admin with no lawyer acceptance: no lawyer", !lawyerFor("qualified", []));
record(
  "rejected by the lawyer: no lawyer",
  !lawyerFor("not_qualified", [row({ status: "rejected", accepted_at: null })])
);
record("accepted by a lawyer: lawyer matched", lawyerFor("qualified", [row({})]));
record("accepted, then the case closed as not_qualified: no lawyer", !lawyerFor("not_qualified", [row({})]));
record("accepted by a lawyer, revoked since: no lawyer", !lawyerFor("qualified", [row({ revoked_at: AT })]));
record("another case's acceptance does not match this one", !lawyerFor("qualified", [row({ submission_id: OTHER })]));
record(
  "one acceptance among other rows is enough",
  lawyerFor("qualified", [row({ status: "rejected", accepted_at: null }), row({})])
);

for (const status of ["submitted", "attorney", "qualified", "doctor", "treating", "not_qualified"]) {
  const matches = providerMatchesFor({ id: CASE, status }, [row({})]);
  record(`status ${status}: no doctor, whatever the lawyer`, matches.doctor.matched === false);
}
record(
  "the two answers are independent: a lawyer match says nothing about a doctor",
  JSON.stringify(providerMatchesFor({ id: CASE, status: "qualified" }, [row({})])) ===
    JSON.stringify({ lawyer: { matched: true }, doctor: { matched: false } })
);
record(
  "the response carries exactly lawyer and doctor, each only { matched }",
  JSON.stringify(Object.keys(providerMatchesFor({ id: CASE, status: "submitted" }, []))) === '["lawyer","doctor"]'
);

const failed = checks.filter(([, passed]) => !passed);
for (const [label, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
assert(failed.length === 0, `${failed.length} provider match check(s) failed`);
