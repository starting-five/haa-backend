import { normalizePhone } from "./phone";
import { supabase } from "./supabase";
import { isTwilioConfigured, sendTwilioSms } from "./twilio";

export type CaseNotificationEvent =
  | "intake_started"
  | "intake_submitted"
  | "retainer_signed"
  | "attorney_review_ready"
  | "patient_intake_started"
  | "patient_intake_submitted"
  | "patient_retainer_ready"
  | "patient_case_accepted"
  | "ambassador_patient_onboarded";

export interface NotifyCaseEventInput {
  submissionId: string;
  eventType: CaseNotificationEvent;
  claimantFirstName?: string;
  claimantLastName?: string;
  claimantMobile?: string;
  locale: string;
  claimantId?: string;
  reviewLink?: string;
  /** ambassador_patient_onboarded only: the referring ambassador's verified phone. */
  ambassadorMobile?: string;
}

export interface NotifyCaseEventResult {
  sent: number;
  skipped: number;
  failed: number;
}

function intakeDashboardLink(input: NotifyCaseEventInput, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.ADMIN_DASHBOARD_URL ?? "").trim();
  const claimantId = (input.claimantId ?? "").trim();
  if (!base || !claimantId) return "[link]";

  try {
    const url = new URL(base);
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/patient/${encodeURIComponent(claimantId)}`;
    url.search = "";
    return url.toString();
  } catch {
    return "[link]";
  }
}

/** The ambassador's own dashboard in the patient app, under FRONTEND_URL like the patient's. */
function ambassadorDashboardLink(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.FRONTEND_URL ?? "").trim();
  if (!base) return "[link]";

  try {
    const url = new URL(base);
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/en/ambassadors/dashboard`;
    url.search = "";
    return url.toString();
  } catch {
    return "[link]";
  }
}

function patientCaseLink(input: NotifyCaseEventInput, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.FRONTEND_URL ?? "").trim();
  if (!base) return "[link]";

  try {
    const url = new URL(base);
    const basePath = url.pathname.replace(/\/+$/, "");
    const locale = input.locale === "es" ? "es" : "en";
    url.pathname = `${basePath}/${locale}/intake/dashboard`;
    url.search = "";
    return url.toString();
  } catch {
    return "[link]";
  }
}

type RecipientAudience = "admin" | "lawyer" | "patient" | "ambassador";

const PATIENT_EVENTS: ReadonlySet<CaseNotificationEvent> = new Set([
  "patient_intake_started",
  "patient_intake_submitted",
  "patient_retainer_ready",
  "patient_case_accepted",
]);

const AMBASSADOR_EVENTS: ReadonlySet<CaseNotificationEvent> = new Set(["ambassador_patient_onboarded"]);

// Patient-facing case texts are always enabled. Unlike ambassador texts, there
// is no runtime environment toggle for these events.
export function patientSmsEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  void _env;
  return true;
}

// Ambassador referral texts follow the same default as patient case texts:
// always on when Twilio is configured and a valid recipient is found.
export function ambassadorSmsEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  void _env;
  return true;
}

interface CaseNotificationRecipient {
  recipient: string;
  audience: RecipientAudience;
}

function normalizeRecipientPhone(raw: string | null | undefined): string | null {
  const direct = normalizePhone(raw);
  if (direct) return direct;

  if (typeof raw !== "string") return null;
  const compactDigits = raw.replace(/[^\d]/g, "");
  if (!compactDigits) return null;

  // Intake identity matching accepts auth.users.phone without a leading plus.
  // For US local/NANP shapes, restore the expected +1 E.164 form.
  if (compactDigits.length === 10) {
    return normalizePhone(`+1${compactDigits}`);
  }
  if (compactDigits.length === 11 && compactDigits.startsWith("1")) {
    return normalizePhone(`+${compactDigits}`);
  }

  return normalizePhone(`+${compactDigits}`);
}

function configuredRecipients(name: "INTAKE_ADMIN_NOTIFICATION_TO" | "INTAKE_LAWYER_NOTIFICATION_TO"): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => normalizeRecipientPhone(value))
    .filter((value): value is string => Boolean(value));
}

function upsertRecipient(
  recipients: Map<string, CaseNotificationRecipient>,
  recipient: string | null | undefined,
  audience: RecipientAudience
): void {
  if (!recipient) return;
  const existing = recipients.get(recipient);
  if (!existing || existing.audience === "admin") {
    recipients.set(recipient, { recipient, audience });
  }
}

function recipientsForEvent(input: NotifyCaseEventInput): CaseNotificationRecipient[] {
  const recipients = new Map<string, CaseNotificationRecipient>();

  if (input.eventType === "attorney_review_ready") {
    for (const recipient of configuredRecipients("INTAKE_LAWYER_NOTIFICATION_TO")) {
      upsertRecipient(recipients, recipient, "lawyer");
    }
    return Array.from(recipients.values());
  }

  if (AMBASSADOR_EVENTS.has(input.eventType)) {
    upsertRecipient(recipients, normalizeRecipientPhone(input.ambassadorMobile), "ambassador");
    return Array.from(recipients.values());
  }

  if (PATIENT_EVENTS.has(input.eventType)) {
    const claimantRecipient = normalizeRecipientPhone(input.claimantMobile);
    if (!claimantRecipient && input.claimantMobile) {
      console.warn("case notification skipped invalid patient mobile", { eventType: input.eventType });
    }
    upsertRecipient(recipients, claimantRecipient, "patient");
    return Array.from(recipients.values());
  }

  for (const recipient of configuredRecipients("INTAKE_ADMIN_NOTIFICATION_TO")) {
    upsertRecipient(recipients, recipient, "admin");
  }

  return Array.from(recipients.values());
}

function buildMessage(input: NotifyCaseEventInput, audience: RecipientAudience): string {
  if (audience === "patient" && input.eventType === "patient_intake_started") {
    return "HelpAfterAccident: We received your case intake. Please complete your onboarding so we have the information needed to review your case. Reply STOP to opt out, HELP for help.";
  }

  if (audience === "patient" && input.eventType === "patient_intake_submitted") {
    const link = patientCaseLink(input);
    return `HelpAfterAccident: We received your completed onboarding information. Your case is ready for review, and we'll notify you when there's an update. View your case here: ${link}. Reply STOP to opt out, HELP for help.`;
  }

  if (audience === "patient" && input.eventType === "patient_retainer_ready") {
    const link = patientCaseLink(input);
    return `HelpAfterAccident: Your retainer agreement is ready for review and signature. Please visit ${link} to review and sign your agreement. Reply STOP to opt out, HELP for help.`;
  }

  if (audience === "patient" && input.eventType === "patient_case_accepted") {
    const link = patientCaseLink(input);
    return input.locale.toLowerCase().startsWith("es")
      ? `HelpAfterAccident: Un abogado ha aceptado su caso. Visite su panel para revisar los detalles de su caso y los próximos pasos: ${link}. Responda STOP para dejar de recibir mensajes. Responda HELP para obtener ayuda.`
      : `HelpAfterAccident: An attorney has accepted your case. Visit your dashboard to review your case details and next steps: ${link}. Reply STOP to opt out, HELP for help.`;
  }

  if (audience === "ambassador" && input.eventType === "ambassador_patient_onboarded") {
    return `HelpAfterAccident: A new patient just onboarded using your link, visit your dashboard at ${ambassadorDashboardLink()} for more details. Reply STOP to opt out.`;
  }

  if (input.eventType === "attorney_review_ready") {
    const link = (input.reviewLink ?? "").trim() || "[link]";
    return `HelpAfterAccident: New case match! Visit ${link} to review your case details and accept or decline. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
  }

  const dashboardLink = intakeDashboardLink(input);

  // The patient has completed the DocuSign retainer: the case is back with the
  // admin to review and pass to a lawyer. No patient detail, like the others.
  if (input.eventType === "retainer_signed") {
    return `HelpAfterAccident: A client has signed their retainer. The case is ready for your review at ${dashboardLink}. Reply STOP to opt out.`;
  }

  const statusLabel = input.eventType === "intake_submitted" ? "submitted" : "intake";
  return `HelpAfterAccident: New client alert: ${statusLabel}. Visit your dashboard at ${dashboardLink} to view your case match details. Reply STOP to opt out.`;
}

export async function notifyCaseEvent(input: NotifyCaseEventInput): Promise<NotifyCaseEventResult> {
  if (!isTwilioConfigured()) {
    console.warn("case notifications disabled: twilio_not_configured", { eventType: input.eventType });
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const recipients = recipientsForEvent(input);
  if (recipients.length === 0) {
    console.warn("case notifications skipped: no_recipients", { eventType: input.eventType });
    return { sent: 0, skipped: 0, failed: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { recipient, audience } of recipients) {
    const message = buildMessage(input, audience);
    const { data: existingSent, error: lookupError } = await supabase
      .from("case_notifications")
      .select("id")
      .eq("submission_id", input.submissionId)
      .eq("event_type", input.eventType)
      .eq("channel", "sms")
      .eq("recipient", recipient)
      .eq("status", "sent")
      .maybeSingle();

    if (lookupError) {
      console.error("case notification lookup failed", { code: lookupError.code, eventType: input.eventType });
      failed += 1;
      continue;
    }

    if (existingSent) {
      skipped += 1;
      continue;
    }

    try {
      const result = await sendTwilioSms(recipient, message);
      const { error: insertError } = await supabase.from("case_notifications").insert({
        submission_id: input.submissionId,
        event_type: input.eventType,
        channel: "sms",
        recipient,
        message_body: message,
        status: "sent",
        provider_message_id: result.sid,
      });

      if (insertError && insertError.code !== "23505") {
        console.error("case notification sent insert failed", { code: insertError.code, eventType: input.eventType });
      }

      sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown_error";
      failed += 1;

      const { error: insertError } = await supabase.from("case_notifications").insert({
        submission_id: input.submissionId,
        event_type: input.eventType,
        channel: "sms",
        recipient,
        message_body: message,
        status: "failed",
        error_message: reason.slice(0, 500),
      });

      if (insertError) {
        console.error("case notification failure insert failed", { code: insertError.code, eventType: input.eventType });
      }
    }
  }

  console.info("case notifications completed", {
    eventType: input.eventType,
    submissionId: input.submissionId,
    sent,
    skipped,
    failed,
  });

  return { sent, skipped, failed };
}
