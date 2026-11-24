// Where a patient's case stands, as the patient routes read it.
//
// Migrations 014 and 022 widened intake_submissions.status past 'submitted'.
// The review decisions in routes/portal.ts, agreement completion in
// routes/agreements.ts and the lawyer handoff in lib/lawyer-handoff.ts move a
// case between these values:
//
//   submitted → retainer_pending_signature   admin approve_for_retainer
//   retainer_pending_signature → signed      the patient's agreement completes
//   signed → attorney                        automatically, straight after; or
//                                            admin pass_to_lawyer, for a case
//                                            signed before that or whose
//                                            automatic handoff did not finish
//   attorney → qualified / not_qualified     the lawyer's decision
//
// None of them sends a case back to intake, so every one still means "this
// patient has submitted a case".

/** Every status of a case whose intake has been submitted — the cases the patient dashboard shows. */
export const SUBMITTED_CASE_STATUSES = [
  "submitted",
  "retainer_pending_signature",
  "signed",
  "qualified",
  "not_qualified",
  "attorney",
  "doctor",
] as const;

export function isSubmittedCase(status: string): boolean {
  return (SUBMITTED_CASE_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether POST /intake/complete may still write a case: while it is in intake,
 * and while it waits for review — a retried submit lands there. Once the Admin
 * Dashboard has decided, the case's facts are what was reviewed and, after
 * signing, what the retainer was issued on.
 */
const COMPLETABLE_STATUSES = ["intake", "submitted"];

export function canCompleteIntake(status: string): boolean {
  return COMPLETABLE_STATUSES.includes(status);
}

/**
 * Whether the patient may change their case from Case Summary (POST
 * /case/:submissionId): at every stage of a submitted case — in review,
 * awaiting signature, signed, with the lawyer, decided. A product decision
 * (2026-10-09): the patient corrects their own facts whenever they find a
 * mistake. Two things follow from it and are deliberate:
 *
 * - an edit after approval or signing changes facts the admin reviewed, the
 *   retainer was issued on (its date of loss) and, after the handoff, what
 *   the lawyer was given — none of them is notified by this route;
 * - email and phone are never editable here, at any stage (lib/case-summary.ts).
 *
 * An intake that has not been submitted is edited in intake, not here.
 */
export function canEditCaseSummary(status: string): boolean {
  return isSubmittedCase(status);
}

/**
 * The retainer waits for the Admin Dashboard. Its approval (POST
 * /portal/review-decision, approve_for_retainer) moves a submitted case to
 * 'retainer_pending_signature'; a case still in review, turned down, already
 * signed or passed on has nothing to sign.
 *
 * POST /intake/agreement enforces this and GET /patient/dashboard reports it, so
 * the screen that offers the agreement and the route that opens it read the
 * same rule. Agreement completion moves the case on to 'signed' only from here.
 */
export const AGREEMENT_READY_STATUS = "retainer_pending_signature";

export function isReadyForAgreement(status: string): boolean {
  return status === AGREEMENT_READY_STATUS;
}
