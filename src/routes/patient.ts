import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { isReadyForAgreement, SUBMITTED_CASE_STATUSES } from "../lib/case-status";
import { resolveClaimantForRequest } from "../lib/patient-identity";
import { providerMatchesFor, type LawyerAssignmentRow } from "../lib/provider-matches";
import { type PatientDashboard, type PatientDashboardCase, type PatientIntakeResume } from "../types/patient";

export const patientRouter = Router();

patientRouter.get("/intake-resume", requireAuth, async (req: Request, res: Response) => {
  const resolved = await resolveClaimantForRequest(req);

  if (resolved.error === "identity_lookup_failed") {
    res.status(500).json({ error: "identity_lookup_failed" });
    return;
  }

  if (!resolved.claimant) {
    res.status(409).json({ error: "intake_incomplete" });
    return;
  }

  const claimant = resolved.claimant;

  const { data: latestIntakeSubmission, error: submissionError } = await supabase
    .from("intake_submissions")
    .select("id")
    .eq("claimant_id", claimant.claimantId)
    .eq("status", "intake")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (submissionError) {
    console.error("patient intake resume submission lookup failed:", { code: submissionError.code });
    res.status(500).json({ error: "dashboard_lookup_failed" });
    return;
  }

  const response: PatientIntakeResume = {
    patient: {
      firstName: claimant.firstName,
      lastName: claimant.lastName,
      mobile: claimant.mobile,
      email: claimant.email,
    },
    submissionId: latestIntakeSubmission?.id ?? null,
  };

  res.status(200).json(response);
});

patientRouter.get("/dashboard", requireAuth, async (req: Request, res: Response) => {
  const resolved = await resolveClaimantForRequest(req);

  if (resolved.error === "identity_lookup_failed") {
    res.status(500).json({ error: "identity_lookup_failed" });
    return;
  }

  if (!resolved.claimant) {
    res.status(409).json({ error: "intake_incomplete" });
    return;
  }

  const claimant = resolved.claimant;

  const { data: submissions, error: submissionsError } = await supabase
    .from("intake_submissions")
    .select("id, status, submitted_at, locale, treatment_area")
    .eq("claimant_id", claimant.claimantId)
    .in("status", [...SUBMITTED_CASE_STATUSES])
    .order("created_at", { ascending: false });

  if (submissionsError) {
    console.error("patient dashboard submissions lookup failed:", { code: submissionsError.code });
    res.status(500).json({ error: "dashboard_lookup_failed" });
    return;
  }

  if (!submissions?.length) {
    res.status(409).json({ error: "intake_incomplete" });
    return;
  }

  // One active agreement per case at most (agreements_one_active_per_submission).
  // Declined and voided rows are finished, and the patient may sign afresh after
  // either, so they are not reported.
  const submissionIds = submissions.map((submission) => submission.id);
  const { data: agreements, error: agreementsError } = await supabase
    .from("agreements")
    .select("submission_id, status")
    .in("submission_id", submissionIds)
    .not("status", "in", "(declined,voided)");

  if (agreementsError) {
    console.error("patient dashboard agreements lookup failed:", { code: agreementsError.code });
    res.status(500).json({ error: "dashboard_lookup_failed" });
    return;
  }

  // Lawyer acceptances of these cases only — the caller's own submissions, resolved
  // from their session above. lib/provider-matches.ts decides what counts.
  const { data: acceptances, error: acceptancesError } = await supabase
    .from("review_assignments")
    .select("submission_id, status, accepted_at, revoked_at")
    .in("submission_id", submissionIds)
    .eq("status", "accepted");

  if (acceptancesError) {
    console.error("patient dashboard review assignments lookup failed:", { code: acceptancesError.code });
    res.status(500).json({ error: "dashboard_lookup_failed" });
    return;
  }

  const lawyerAcceptances = (acceptances ?? []) as LawyerAssignmentRow[];
  const cases: PatientDashboardCase[] = [];

  for (const submission of submissions ?? []) {
    const { data: accident, error: accidentError } = await supabase
      .from("accidents")
      .select("incident_type, incident_location, role, incident_date")
      .eq("submission_id", submission.id)
      .maybeSingle();

    if (accidentError) {
      console.error("patient dashboard accident lookup failed:", { code: accidentError.code });
      res.status(500).json({ error: "dashboard_lookup_failed" });
      return;
    }

    const agreementStatus = agreements?.find((agreement) => agreement.submission_id === submission.id)?.status ?? null;

    cases.push({
      submissionId: submission.id,
      status: submission.status,
      submittedAt: submission.submitted_at,
      locale: submission.locale,
      treatmentArea: submission.treatment_area,
      incidentType: accident?.incident_type ?? "other",
      incidentLocation: accident?.incident_location ?? "",
      role: accident?.role ?? null,
      // The dashboard's incident-progress header shows the date of loss; it is
      // real patient data (accidents.incident_date), nullable for older rows.
      incidentDate: accident?.incident_date ?? null,
      // The stored status, not refreshed from DocuSign here; GET
      // /intake/agreement/:submissionId is the authoritative read.
      agreementStatus,
      // The patient's next step is the retainer: the admin has accepted the case
      // and it is not signed yet. The same rule gates POST /intake/agreement.
      awaitingSignature: isReadyForAgreement(submission.status) && agreementStatus !== "completed",
      // Matched or not, each provider on its own; never inferred from the status.
      providers: providerMatchesFor(submission, lawyerAcceptances),
    });
  }

  const dashboard: PatientDashboard = {
    patient: {
      firstName: claimant.firstName,
      lastName: claimant.lastName,
      mobile: claimant.mobile,
      email: claimant.email,
    },
    cases,
  };

  res.status(200).json(dashboard);
});
