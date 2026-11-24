// The referral provider is Dub. The only thing this module is used for is
// answering "which intakes came through this ambassador's link", which is the
// authorization fact the People Helped endpoint is scoped by — so it lives
// server-side, next to the patient data it gates, rather than in the browser
// tier that consumes the answer.

const REFERRAL_API_BASE_URL = "https://api.dub.co";

// Dub caps a page at 100. Ten pages is 1,000 referred intakes for one
// ambassador, far beyond anything seen, and it bounds the work a single
// dashboard load can ask of the provider. Past it the answer is reported as
// truncated rather than silently short.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export type ReferralLinkIdentity =
  { type: "linkId"; linkId: string } | { type: "domainKey"; domain: string; key: string };

export type ReferralLead = {
  /** intake_submissions.id, as recorded on the lead's customer external id. */
  submissionId: string;
  createdAt: string;
};

export type ReferralLeadsResult =
  { error: "not_configured" | "provider_unavailable" } | { leads: ReferralLead[]; truncated: boolean };

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The submission id a lead was recorded against. Dub carries it as the
 * customer's external id; the metadata spellings are accepted because the
 * tracking call has written it both ways.
 *
 * Only a UUID is accepted. The value decides which patient record is shown, so
 * anything that is not the shape of a submission id is discarded rather than
 * passed to a query.
 */
function readSubmissionId(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const top = event as Record<string, unknown>;
  const data = top.data && typeof top.data === "object" ? (top.data as Record<string, unknown>) : {};
  const customer = top.customer && typeof top.customer === "object" ? (top.customer as Record<string, unknown>) : {};
  const dataCustomer =
    data.customer && typeof data.customer === "object" ? (data.customer as Record<string, unknown>) : {};
  const metadata = top.metadata && typeof top.metadata === "object" ? (top.metadata as Record<string, unknown>) : {};
  const dataMetadata =
    data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : {};

  const raw =
    asNonEmptyString(top.customerExternalId) ||
    asNonEmptyString(top.customer_external_id) ||
    asNonEmptyString(data.customerExternalId) ||
    asNonEmptyString(data.customer_external_id) ||
    asNonEmptyString(customer.externalId) ||
    asNonEmptyString(customer.external_id) ||
    asNonEmptyString(dataCustomer.externalId) ||
    asNonEmptyString(dataCustomer.external_id) ||
    asNonEmptyString(metadata.customerExternalId) ||
    asNonEmptyString(dataMetadata.customerExternalId) ||
    asNonEmptyString(metadata.submissionId) ||
    asNonEmptyString(metadata.submission_id) ||
    asNonEmptyString(dataMetadata.submissionId) ||
    asNonEmptyString(dataMetadata.submission_id);

  return UUID_PATTERN.test(raw) ? raw : "";
}

function readCreatedAt(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const top = event as Record<string, unknown>;
  const data = top.data && typeof top.data === "object" ? (top.data as Record<string, unknown>) : {};
  return (
    asNonEmptyString(top.timestamp) ||
    asNonEmptyString(top.createdAt) ||
    asNonEmptyString(top.created_at) ||
    asNonEmptyString(data.timestamp) ||
    asNonEmptyString(data.createdAt) ||
    asNonEmptyString(data.created_at)
  );
}

/** Dub has answered with a bare array and with { events: [...] }; accept both. */
function readEvents(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { events?: unknown[] }).events)) {
    return (payload as { events: unknown[] }).events;
  }
  return [];
}

export function resolveReferralLinkIdentity(record: Record<string, unknown>): ReferralLinkIdentity | null {
  const providerLinkId = asNonEmptyString(record.provider_link_id);
  if (providerLinkId) return { type: "linkId", linkId: providerLinkId };

  const shortLink = asNonEmptyString(record.short_link);
  if (shortLink) {
    try {
      const url = new URL(shortLink.startsWith("http") ? shortLink : `https://${shortLink}`);
      const key = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
      if (key) return { type: "domainKey", domain: url.hostname, key };
    } catch {
      // fall through to the configured domain
    }
  }

  const key =
    asNonEmptyString(record.referral_link_key) ||
    asNonEmptyString(record.username_display) ||
    asNonEmptyString(record.username);
  const domain = asNonEmptyString(process.env.DUB_AMBASSADOR_LINK_DOMAIN);

  return key && domain ? { type: "domainKey", domain, key } : null;
}

/**
 * Every lead recorded against one referral link, newest first.
 *
 * A provider error is never reported as "no leads": the caller has to be able
 * to tell "this ambassador referred nobody" from "we could not find out", and
 * only the first of those may be shown as an empty list.
 */
export async function fetchReferralLeads(identity: ReferralLinkIdentity): Promise<ReferralLeadsResult> {
  const token = asNonEmptyString(process.env.DUB_API_KEY);
  if (!token) return { error: "not_configured" };

  const leads = new Map<string, ReferralLead>();
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      event: "leads",
      interval: "all",
      sortOrder: "desc",
      pageSize: String(PAGE_SIZE),
      page: String(page),
    });
    if (identity.type === "linkId") query.set("linkId", identity.linkId);
    else {
      query.set("domain", identity.domain);
      query.set("key", identity.key);
    }

    let events: unknown[];
    try {
      const response = await fetch(`${REFERRAL_API_BASE_URL}/events?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        console.error("referral leads lookup failed", { status: response.status, page });
        return { error: "provider_unavailable" };
      }
      events = readEvents(await response.json());
    } catch (error) {
      console.error("referral leads request failed", {
        page,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { error: "provider_unavailable" };
    }

    for (const event of events) {
      const submissionId = readSubmissionId(event);
      if (!submissionId || leads.has(submissionId)) continue;
      leads.set(submissionId, { submissionId, createdAt: readCreatedAt(event) });
    }

    if (events.length < PAGE_SIZE) return { leads: [...leads.values()], truncated: false };
    if (page === MAX_PAGES) truncated = true;
  }

  return { leads: [...leads.values()], truncated };
}

export type SubmissionReferral = { linkId: string; partnerId: string };

export type SubmissionReferralResult =
  { error: "not_configured" | "provider_unavailable" } | { referral: SubmissionReferral | null };

/**
 * The referral link a submission came in through, if any. The lead recorded at
 * verification (haa-frontend /api/intake/dub-lead) names the submission as the
 * customer's external id, and Dub keeps the link and partner that customer was
 * attributed to — so this asks Dub for that customer rather than guessing from
 * anything stored here. A submission that never came through a link has no
 * customer, or one with no link, and answers { referral: null }.
 */
export async function findReferralForSubmission(submissionId: string): Promise<SubmissionReferralResult> {
  const token = asNonEmptyString(process.env.DUB_API_KEY);
  if (!token) return { error: "not_configured" };
  if (!UUID_PATTERN.test(submissionId)) return { referral: null };

  const query = new URLSearchParams({ externalId: submissionId, includeExpandedFields: "true", pageSize: "1" });
  let customers: unknown;
  try {
    const response = await fetch(`${REFERRAL_API_BASE_URL}/customers?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("referral customer lookup failed", { status: response.status });
      return { error: "provider_unavailable" };
    }
    customers = await response.json();
  } catch (error) {
    console.error("referral customer request failed", { message: error instanceof Error ? error.message : "unknown" });
    return { error: "provider_unavailable" };
  }

  const list = Array.isArray(customers) ? customers : [];
  // externalId is an exact filter; the check is repeated so a provider that
  // ignored it could never attribute another patient's lead
  const customer = list.find(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).externalId === submissionId
  ) as Record<string, unknown> | undefined;
  if (!customer) return { referral: null };

  const link = customer.link && typeof customer.link === "object" ? (customer.link as Record<string, unknown>) : {};
  const partner =
    customer.partner && typeof customer.partner === "object" ? (customer.partner as Record<string, unknown>) : {};
  const linkId = asNonEmptyString(link.id);
  const partnerId = asNonEmptyString(partner.id);
  return linkId || partnerId ? { referral: { linkId, partnerId } } : { referral: null };
}
