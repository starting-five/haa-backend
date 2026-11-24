import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { fetchReferralLeads, resolveReferralLinkIdentity } from "../lib/referrals";

export const ambassadorsRouter = Router();

type ContactAvailabilityRequest = {
  phone?: string;
  email?: string;
};

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

function buildPhoneCandidates(normalizedPhone: string): string[] {
  const digits = normalizedPhone.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  const withCountryCode = digits.length === 10 ? `1${digits}` : digits;

  return Array.from(new Set([normalizedPhone, digits, last10, `+${withCountryCode}`, withCountryCode]));
}

function isRecoverableProfileLookupError(error: { code?: string } | null): boolean {
  if (!error?.code) return false;
  return error.code === "42P01" || error.code === "42703";
}

ambassadorsRouter.post("/contact-availability", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ContactAvailabilityRequest;
  const normalizedPhone = normalizePhone(body.phone ?? "");
  const normalizedEmail = normalizeEmail(body.email ?? "");

  if (!normalizedPhone && !normalizedEmail) {
    res.status(200).json({ available: false, reason: "invalid" });
    return;
  }

  if (normalizedPhone) {
    const phoneCandidates = buildPhoneCandidates(normalizedPhone);

    const [profileLookup, claimantLookup, lawyerLookup] = await Promise.all([
      supabase.from("profiles").select("user_id").in("phone", phoneCandidates).limit(1),
      supabase.from("claimants").select("id").in("mobile", phoneCandidates).limit(1),
      supabase.from("lawyers").select("user_id").in("phone", phoneCandidates).limit(1),
    ]);

    if (
      (profileLookup.error && !isRecoverableProfileLookupError(profileLookup.error)) ||
      (claimantLookup.error && !isRecoverableProfileLookupError(claimantLookup.error)) ||
      (lawyerLookup.error && !isRecoverableProfileLookupError(lawyerLookup.error))
    ) {
      res.status(200).json({ available: false, reason: "error" });
      return;
    }

    const profileTaken = profileLookup.error ? false : profileLookup.data.length > 0;
    const claimantTaken = claimantLookup.error ? false : claimantLookup.data.length > 0;
    const lawyerTaken = lawyerLookup.error ? false : lawyerLookup.data.length > 0;
    const taken = profileTaken || claimantTaken || lawyerTaken;
    res.status(200).json({ available: !taken, reason: taken ? "taken" : "available" });
    return;
  }

  const [profileLookup, claimantLookup, lawyerLookup] = await Promise.all([
    supabase.from("profiles").select("user_id").eq("email", normalizedEmail).limit(1),
    supabase.from("claimants").select("id").eq("email", normalizedEmail).limit(1),
    supabase.from("lawyers").select("user_id").eq("email", normalizedEmail).limit(1),
  ]);

  if (
    (profileLookup.error && !isRecoverableProfileLookupError(profileLookup.error)) ||
    (claimantLookup.error && !isRecoverableProfileLookupError(claimantLookup.error)) ||
    (lawyerLookup.error && !isRecoverableProfileLookupError(lawyerLookup.error))
  ) {
    res.status(200).json({ available: false, reason: "error" });
    return;
  }

  const profileTaken = profileLookup.error ? false : profileLookup.data.length > 0;
  const claimantTaken = claimantLookup.error ? false : claimantLookup.data.length > 0;
  const lawyerTaken = lawyerLookup.error ? false : lawyerLookup.data.length > 0;
  const taken = profileTaken || claimantTaken || lawyerTaken;
  res.status(200).json({ available: !taken, reason: taken ? "taken" : "available" });
});

type ReferredPerson = {
  submissionId: string;
  name: string;
  incidentType: string;
  incidentDate: string | null;
  location: string;
  phone: string;
  email: string | null;
  status: string;
  referredAt: string;
};

function isDebugEnabled(request: Request): boolean {
  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "DEV").trim().toUpperCase();
  const debugAllowed = appEnv === "DEV" || appEnv === "DEVELOPMENT" || appEnv === "TEST";
  if (!debugAllowed) return false;

  const debugQuery = request.query.debug;
  if (Array.isArray(debugQuery)) return debugQuery.includes("1");
  return debugQuery === "1";
}

/**
 * The patients one ambassador referred.
 *
 * This is patient data — names, mobiles, emails, where they were hurt — so the
 * question it answers is an authorization question, and it is answered here
 * rather than in the browser tier. The caller's own ambassador row supplies the
 * referral link, the provider supplies the intakes recorded against that link,
 * and only those submission ids are ever read.
 *
 * Every way of not knowing the referral set returns an empty list: no
 * ambassador row, no resolvable link, the provider unconfigured or unreachable.
 * There is deliberately no branch that widens the query when the set is
 * unknown — "we cannot tell whose these are" must never mean "show them all".
 */
ambassadorsRouter.get("/people", requireAuth, async (req: Request, res: Response) => {
  const debugEnabled = isDebugEnabled(req);
  const debug: Record<string, unknown> = {
    stage: "auth",
  };

  const authUserId = req.user?.id;
  if (!authUserId) {
    // requireAuth runs first; failing closed rather than trusting that it did.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data: profile, error: profileError } = await supabase
    .from("ambassador_profiles")
    .select("user_id, provider_link_id, referral_link_key, short_link, username_display, username")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error("ambassador profile lookup failed", { code: profileError.code });
    if (debugEnabled) {
      res.status(500).json({ error: "Failed to load referrals", debug: { ...debug, stage: "profile_error" } });
      return;
    }
    res.status(500).json({ error: "Failed to load referrals" });
    return;
  }

  // A caller with no ambassador row is not an ambassador. They are told the
  // same thing as an ambassador who has referred nobody, so the response
  // cannot be used to discover whether an account is one.
  if (!profile) {
    if (debugEnabled) {
      res.status(200).json({ people: [], debug: { ...debug, stage: "missing_ambassador_profile" } });
      return;
    }
    res.status(200).json({ people: [] });
    return;
  }

  debug.stage = "profile_loaded";
  debug.identityCandidates = {
    providerLinkId: Boolean((profile as { provider_link_id?: unknown }).provider_link_id),
    shortLink: Boolean((profile as { short_link?: unknown }).short_link),
    referralLinkKey: Boolean((profile as { referral_link_key?: unknown }).referral_link_key),
    usernameDisplay: Boolean((profile as { username_display?: unknown }).username_display),
    username: Boolean((profile as { username?: unknown }).username),
  };

  const identity = resolveReferralLinkIdentity(profile as Record<string, unknown>);
  if (!identity) {
    if (debugEnabled) {
      res.status(200).json({ people: [], debug: { ...debug, stage: "missing_identity" } });
      return;
    }
    res.status(200).json({ people: [] });
    return;
  }

  debug.stage = "identity_resolved";
  debug.identityType = identity.type;
  debug.identityValue = identity.type === "linkId" ? identity.linkId : `${identity.domain}/${identity.key}`;

  const referrals = await fetchReferralLeads(identity);
  if ("error" in referrals) {
    if (debugEnabled) {
      res.status(200).json({ people: [], truncated: false, debug: { ...debug, stage: "referrals_error", referrals } });
      return;
    }
    res.status(200).json({ people: [], truncated: false });
    return;
  }

  debug.stage = "referrals_loaded";
  debug.referralLeadsCount = referrals.leads.length;
  debug.referralLeadsTruncated = referrals.truncated;

  if (referrals.leads.length === 0) {
    if (debugEnabled) {
      res.status(200).json({ people: [], truncated: false, debug: { ...debug, stage: "no_referral_leads" } });
      return;
    }
    res.status(200).json({ people: [], truncated: false });
    return;
  }

  const referredAtBySubmissionId = new Map(referrals.leads.map((lead) => [lead.submissionId, lead.createdAt]));
  const submissionIds = [...referredAtBySubmissionId.keys()];
  debug.submissionIdsFromLeadsCount = submissionIds.length;
  debug.submissionIdsFromLeadsSample = submissionIds.slice(0, 5);

  const { data: submissions, error: submissionsError } = await supabase
    .from("intake_submissions")
    .select("id, status, claimant_id")
    .in("id", submissionIds);

  if (submissionsError) {
    console.error("referred submissions lookup failed", { code: submissionsError.code });
    if (debugEnabled) {
      res.status(500).json({ error: "Failed to load referrals", debug: { ...debug, stage: "submissions_error" } });
      return;
    }
    res.status(500).json({ error: "Failed to load referrals" });
    return;
  }

  const rows = submissions ?? [];
  debug.matchedSubmissionsCount = rows.length;
  debug.matchedSubmissionIdsSample = rows.map((row) => row.id).slice(0, 5);

  if (rows.length === 0) {
    if (debugEnabled) {
      res.status(200).json({ people: [], truncated: referrals.truncated, debug: { ...debug, stage: "no_submission_matches" } });
      return;
    }
    res.status(200).json({ people: [], truncated: referrals.truncated });
    return;
  }

  const claimantIds = [...new Set(rows.map((row) => row.claimant_id).filter(Boolean))];
  const [claimantsResult, accidentsResult] = await Promise.all([
    supabase.from("claimants").select("id, first_name, last_name, mobile, email, residence").in("id", claimantIds),
    supabase
      .from("accidents")
      .select("submission_id, incident_type, incident_date, incident_location")
      .in(
        "submission_id",
        rows.map((row) => row.id)
      ),
  ]);

  if (claimantsResult.error || accidentsResult.error) {
    console.error("referred people lookup failed", {
      claimants: claimantsResult.error?.code,
      accidents: accidentsResult.error?.code,
    });
    if (debugEnabled) {
      res.status(500).json({ error: "Failed to load referrals", debug: { ...debug, stage: "person_data_error" } });
      return;
    }
    res.status(500).json({ error: "Failed to load referrals" });
    return;
  }

  const claimantById = new Map((claimantsResult.data ?? []).map((row) => [row.id, row]));
  const accidentBySubmissionId = new Map((accidentsResult.data ?? []).map((row) => [row.submission_id, row]));

  const people: ReferredPerson[] = rows.map((row) => {
    const claimant = claimantById.get(row.claimant_id);
    const accident = accidentBySubmissionId.get(row.id);
    const name = [claimant?.first_name, claimant?.last_name].filter(Boolean).join(" ").trim();

    return {
      submissionId: row.id,
      name,
      incidentType: accident?.incident_type ?? "",
      // Null until the patient reaches the accident screens.
      incidentDate: accident?.incident_date ?? null,
      location: accident?.incident_location ?? claimant?.residence ?? "",
      phone: claimant?.mobile ?? "",
      email: claimant?.email ?? null,
      status: row.status,
      referredAt: referredAtBySubmissionId.get(row.id) ?? "",
    };
  });

  people.sort((left, right) => {
    const a = Date.parse(left.referredAt);
    const b = Date.parse(right.referredAt);
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    return b - a;
  });

  if (debugEnabled) {
    res.status(200).json({
      people,
      truncated: referrals.truncated,
      debug: { ...debug, stage: "ok", peopleCount: people.length },
    });
    return;
  }

  res.status(200).json({ people, truncated: referrals.truncated });
});
