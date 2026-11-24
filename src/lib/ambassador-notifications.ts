import { notifyCaseEvent, type NotifyCaseEventResult } from "./case-notifications";
import { findReferralForSubmission } from "./referrals";
import { supabase } from "./supabase";

// The text to the brand ambassador whose link brought in a patient. Recipient
// resolution lives here; the message, the link, the setting, the sent-once
// guard and the Twilio call are notifyCaseEvent's, as for every other case
// notification. It is not awaited by the route: the intake is already stored
// when it runs, and a text that fails is recorded as failed, never undone into
// the case.

const NOTHING_SENT: NotifyCaseEventResult = { sent: 0, skipped: 0, failed: 0 };

export type ReferringAmbassador =
  | { found: true; userId: string; mobile: string }
  | { found: false; reason: "no_referral" | "no_ambassador" | "self_referral" | "no_phone" | "lookup_failed" };

/**
 * The brand ambassador whose link a submission came in through, by the
 * referral provider's own attribution (see findReferralForSubmission): the
 * link it recorded, matched to the ambassador provisioned with that link, or
 * failing that its partner. The number is the ambassador's verified sign-in
 * phone. Nobody is chosen when the provider has no referral for the
 * submission, and a patient referred through their own link is not texted
 * about themselves.
 */
export async function resolveReferringAmbassador(
  submissionId: string,
  patientUserId: string | null
): Promise<ReferringAmbassador> {
  const found = await findReferralForSubmission(submissionId);
  if ("error" in found) return { found: false, reason: "lookup_failed" };
  if (!found.referral) return { found: false, reason: "no_referral" };

  const byColumn = async (column: "provider_link_id" | "provider_partner_id", value: string) => {
    if (!value) return { userId: null as string | null, failed: false };
    const { data, error } = await supabase.from("ambassador_profiles").select("user_id").eq(column, value).limit(2);
    if (error) {
      console.error("referring ambassador lookup failed", { code: error.code });
      return { userId: null, failed: true };
    }
    // a provider id names one ambassador; two rows would make the answer a guess
    return { userId: data && data.length === 1 ? (data[0]!.user_id as string) : null, failed: false };
  };

  const byLink = await byColumn("provider_link_id", found.referral.linkId);
  const byPartner = byLink.userId ? byLink : await byColumn("provider_partner_id", found.referral.partnerId);
  if (byLink.failed || byPartner.failed) return { found: false, reason: "lookup_failed" };
  const userId = byLink.userId ?? byPartner.userId;
  if (!userId) return { found: false, reason: "no_ambassador" };
  if (patientUserId && userId === patientUserId) return { found: false, reason: "self_referral" };

  const { data: user, error: userError } = await supabase.auth.admin.getUserById(userId);
  if (userError) {
    console.error("referring ambassador user lookup failed", { name: userError.name });
    return { found: false, reason: "lookup_failed" };
  }
  const phone = (user?.user?.phone ?? "").trim();
  if (!phone) return { found: false, reason: "no_phone" };
  return { found: true, userId, mobile: phone };
}

/**
 * The ambassador whose link brought in a patient who has just submitted their
 * intake.
 */
export async function notifyReferringAmbassador(input: {
  submissionId: string;
  patientUserId: string | null;
  locale: string;
}): Promise<NotifyCaseEventResult> {
  const ambassador = await resolveReferringAmbassador(input.submissionId, input.patientUserId);
  if (!ambassador.found) {
    console.info("ambassador onboarded notification skipped", { reason: ambassador.reason });
    return NOTHING_SENT;
  }

  return notifyCaseEvent({
    submissionId: input.submissionId,
    eventType: "ambassador_patient_onboarded",
    ambassadorMobile: ambassador.mobile,
    locale: input.locale,
  });
}
