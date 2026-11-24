export interface PatientDashboardCase {
  submissionId: string;
  status: string;
  submittedAt: string | null;
  locale: string;
  treatmentArea: string | null;
  incidentType: string;
  incidentLocation: string;
  role: string | null;
  incidentDate: string | null;
  /** The case's active agreement, as stored: created, sent, delivered or completed. Null when there is none. */
  agreementStatus: string | null;
  /** Accepted by the admin and not yet signed — the patient's next step is the retainer. */
  awaitingSignature: boolean;
  /** Whether a lawyer and a doctor are matched with the case, each on its own. See lib/provider-matches.ts. */
  providers: {
    lawyer: { matched: boolean };
    doctor: { matched: boolean };
  };
}

export interface PatientDashboard {
  patient: {
    firstName: string;
    lastName: string;
    mobile: string;
    email: string | null;
  } | null;
  cases: PatientDashboardCase[];
}

export interface PatientIntakeResume {
  patient: {
    firstName: string;
    lastName: string;
    mobile: string;
    email: string | null;
  } | null;
  submissionId: string | null;
}
