export interface LocationDetails {
  text: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  // "manual" marks a user-typed fallback (Google unavailable); "unvalidated"
  // marks that such an entry was never geocoded. Stored verbatim in text columns.
  source: "autosuggest" | "current_location" | "manual";
  precision: "address" | "city_estimate" | "unvalidated";
}

/**
 * The one field the duplicate-registration check accepts. Nothing else is read:
 * the caller is unauthenticated at this point in the flow, so anything more
 * would be an identifier they have not earned the right to supply.
 */
export interface RegistrationStatusPayload {
  phone: string;
}

/**
 * And the one field it returns. Deliberately not a patient, a case, a count or
 * an identifier — only whether this number can sign in.
 */
export interface RegistrationStatusResponse {
  status: "new" | "existing";
}

export interface StartIntakePayload {
  locale: "en" | "es";
  claimant: {
    firstName: string;
    lastName: string;
    mobile: string;
    email?: string;
  };
  // Absent on the call that opens the case at verification, present on the one
  // that follows once the patient has answered the accident screens.
  accident?: {
    incidentType: string;
    incidentLocation: string;
    incidentDate?: string;
    incidentLocationDetails?: LocationDetails | null;
  };
}

export type AccidentInput = NonNullable<StartIntakePayload["accident"]>;

export interface CompleteIntakePayload {
  submissionId: string;
  claimant: {
    residence?: string;
    residenceLocationDetails?: LocationDetails | null;
  };
  accident: {
    incidentType?: string;
    incidentDate?: string;
    incidentLocation?: string;
    incidentLocationDetails?: LocationDetails | null;
    role?: string;
    description?: string;
    injuries?: string;
    injuryTypes?: string;
  };
  treatmentArea?: string;
  treatmentAreaLocationDetails?: LocationDetails | null;
  documents: UploadedFile[];
  companions?: IntakeCompanion[];
}

export interface DocumentUploadUrlPayload {
  submissionId: string;
  fileName: string;
  category?: string;
}

export interface DeleteDocumentPayload {
  submissionId: string;
  storagePath: string;
}

export interface UploadedFile {
  fileName: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
  category?: string;
}

export interface IntakeCompanion {
  firstName: string;
  lastName: string;
  relation: string;
  cellNumber: string;
  email?: string;
}

export interface VerifyOtpPayload {
  phone: string;
  code: string;
}

export interface AgreementPayload {
  submissionId: string;
  /**
   * The patient's currently selected language. It is the source of truth for
   * which retainer template is used, so it is validated and fails closed — an
   * unknown or missing value is rejected, never defaulted.
   */
  locale: "en" | "es";
}

export interface LawyerProfilePayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  practice?: string;
  role?: string;
}
