// Whether a patient's case has a lawyer, and whether it has a doctor — the one
// place either answer is worked out. GET /patient/dashboard reports it per case
// and the patient app renders it; nothing else decides it.
//
// Lawyer: a case is matched with a lawyer when a lawyer has accepted it through
// their review link — a review_assignments row the lawyer moved to 'accepted',
// with accepted_at recorded, that has not been revoked. The case's own status is
// not evidence of a match: the Admin Dashboard can set 'qualified' without any
// lawyer having seen the case, and 'attorney' only means it was passed to one.
// An accepted link that has since expired is still a match: expiry ends the
// link's access to the case, not the lawyer's acceptance of it. A case closed as
// 'not_qualified' after a lawyer accepted is no longer represented, so it is not
// a match either.
//
// Doctor: nothing records one. The schema has no doctor assignment of any kind
// (no table, no column on the case, no review flow), so no case can be matched
// with a doctor yet. When doctor matching is stored, its rule goes here, next to
// the lawyer's, and the two are worked out independently.

export interface ProviderMatch {
  matched: boolean;
}

export interface ProviderMatches {
  lawyer: ProviderMatch;
  doctor: ProviderMatch;
}

/** The review_assignments columns the lawyer rule reads. */
export interface LawyerAssignmentRow {
  submission_id: string;
  status: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** The intake_submissions columns the rules read. */
export interface ProviderMatchCase {
  id: string;
  status: string | null;
}

const CLOSED_WITHOUT_REPRESENTATION = "not_qualified";

export function isLawyerAcceptance(row: LawyerAssignmentRow): boolean {
  return row.status === "accepted" && Boolean(row.accepted_at) && !row.revoked_at;
}

export function providerMatchesFor(
  submission: ProviderMatchCase,
  assignments: readonly LawyerAssignmentRow[]
): ProviderMatches {
  const lawyerMatched =
    submission.status !== CLOSED_WITHOUT_REPRESENTATION &&
    assignments.some((row) => row.submission_id === submission.id && isLawyerAcceptance(row));

  return {
    lawyer: { matched: lawyerMatched },
    doctor: { matched: false },
  };
}
