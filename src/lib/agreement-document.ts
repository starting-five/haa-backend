import { supabase } from "./supabase";
import { downloadSignedDocument } from "./docusign";

/**
 * Keeps the signed agreement PDF once DocuSign reports an envelope completed.
 *
 * It lives in its own private bucket rather than beside the patient's evidence.
 * Evidence keys begin with a submission id and the patient's browser holds
 * write tokens inside that namespace; the signed agreement is a legal record the
 * application produces, and nothing a patient uploads should share a namespace
 * with it.
 *
 * Nothing here reaches the browser. The bytes are fetched with the application's
 * DocuSign credentials and written with the service-role key, and the route only
 * ever reports a status.
 */
export const AGREEMENTS_BUCKET = "agreements";

/** Deterministic: the same agreement always resolves to the same object. */
export function signedDocumentPath(submissionId: string, agreementId: string): string {
  return `${submissionId}/${agreementId}.pdf`;
}

/**
 * Stores the signed PDF for an agreement, exactly once.
 *
 * Completion is reconciled from the return route, which polls, and the patient
 * may refresh or come back to it, so this runs more than once for one signature.
 * It is safe to repeat: a recorded path short-circuits it, the object key is
 * derived rather than generated, and the upload is made with `upsert: false` so
 * a race writes the same key once and the loser treats the conflict as success.
 *
 * Storing the document is not what makes an agreement complete. A failure here
 * is logged and reported, never allowed to change the agreement's status.
 */
export async function storeSignedDocument(
  agreementId: string,
  submissionId: string,
  envelopeId: string
): Promise<"stored" | "already_stored" | "failed"> {
  const { data: agreement, error: readError } = await supabase
    .from("agreements")
    .select("signed_document_path")
    .eq("id", agreementId)
    .maybeSingle();

  if (readError) {
    console.error("agreement read before document storage failed:", { code: readError.code });
    return "failed";
  }
  if (agreement?.signed_document_path) return "already_stored";

  const path = signedDocumentPath(submissionId, agreementId);

  try {
    const pdf = await downloadSignedDocument(envelopeId);
    const { error: uploadError } = await supabase.storage
      .from(AGREEMENTS_BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });

    // A concurrent reconciliation already wrote this exact key. The object is
    // the one this call would have written, so it is a success, not a clash.
    const alreadyThere = uploadError && /exists/i.test(uploadError.message);
    if (uploadError && !alreadyThere) {
      console.error("signed agreement upload failed:", { name: uploadError.name });
      return "failed";
    }

    const { error: recordError } = await supabase
      .from("agreements")
      .update({ signed_document_path: path, updated_at: new Date().toISOString() })
      .eq("id", agreementId)
      .is("signed_document_path", null);

    if (recordError) {
      console.error("recording the signed agreement path failed:", { code: recordError.code });
      return "failed";
    }

    return alreadyThere ? "already_stored" : "stored";
  } catch (error) {
    console.error("signed agreement retrieval failed:", (error as Error).message);
    return "failed";
  }
}
