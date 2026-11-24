import type { StoredLocationDetails } from "../lib/location-columns";

/** GET /case/:submissionId — the patient's own case, as Case Summary shows it. */
export interface CaseSummary {
  submissionId: string;
  status: string;
  submittedAt: string | null;
  firstName: string;
  lastName: string;
  /** Shown, never editable from Case Summary — see lib/case-summary.ts. */
  phone: string;
  email: string | null;
  incidentType: string;
  incidentDate: string | null;
  incidentLocation: string;
  incidentLocationDetails: StoredLocationDetails | null;
  role: string | null;
  /** Comma-joined injury keys, plus any the patient typed, as /intake/complete stored them. */
  injuries: string | null;
  treatmentArea: string | null;
  treatmentAreaLocationDetails: StoredLocationDetails | null;
  /** The people who were there, with the contact details the patient gave for them, so they can be edited. */
  companions: CaseCompanion[];
  documents: { id: string; fileName: string; mimeType: string; category: string | null }[];
  /** Whether POST /case/:submissionId will accept a change. See canEditCaseSummary. */
  editable: boolean;
}

export interface CaseLocationDetailsInput {
  text?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source: "autosuggest" | "current_location" | "manual";
  precision: "address" | "city_estimate" | "unvalidated";
}

export interface CaseCompanion {
  id: string;
  firstName: string;
  lastName: string;
  relation: string;
  cellNumber: string;
  email: string | null;
}

/** One companion as Save sends it: with its id to keep and edit it, without one to add it. */
export interface CaseCompanionInput {
  id?: string;
  firstName: string;
  lastName: string;
  relation: string;
  /** Stored as the intake stores it, "(407) 555-1234". */
  cellNumber: string;
  email: string | null;
}

/** A file already uploaded to the case's own folder through POST /intake/documents/upload-url. */
export interface CaseDocumentInput {
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  category: string;
}

/**
 * POST /case/:submissionId. Every group is optional and replaces what is
 * stored for it. Email and phone are not part of it: they are the patient's
 * sign-in identity and contact, and a body naming them is refused.
 */
export interface CaseSummaryUpdatePayload {
  claimant?: { firstName: string; lastName: string };
  accident?: {
    incidentType: string;
    incidentDate: string;
    incidentLocation: string;
    incidentLocationDetails?: CaseLocationDetailsInput | null;
    role: string;
  };
  injuries?: string;
  treatmentArea?: string;
  treatmentAreaLocationDetails?: CaseLocationDetailsInput | null;
  /** The whole list as it should now be: kept ids are updated, new entries added, missing ids removed. */
  companions?: CaseCompanionInput[];
  documents?: { add: CaseDocumentInput[]; remove: string[] };
}
