import type { NextFunction, Request, Response } from "express";
import { supabase } from "../lib/supabase";

// Portal routes serve every patient's record to a lawyer. `requireAuth` alone
// does not separate the two actors: patients and lawyers both authenticate
// through the same Supabase project into the same auth.users table, so a
// patient's session satisfies it and reads the whole database.
//
// This closes the half of that which the existing data model can decide on its
// own: a caller who owns a claimant is a patient, and a patient is never a
// portal actor. It is deliberately named for what it proves. It does NOT
// establish that the caller is a lawyer — `lawyers` rows are self-served by
// POST /portal/lawyer/profile, so membership grants nothing — and a real actor
// model (an approval flow, or a role claim in the JWT) is still needed before
// the portal can face real patient data. See README, "Authorization".
export async function denyPatientSession(req: Request, res: Response, next: NextFunction) {
  const authUserId = req.user?.id;
  if (!authUserId) {
    // requireAuth runs first; failing closed rather than trusting that it did.
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data: claimant, error } = await supabase
    .from("claimants")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("portal actor lookup failed", { code: error.code });
    res.status(500).json({ error: "Failed to verify access" });
    return;
  }

  if (claimant) {
    res.status(403).json({ error: "not_a_portal_user" });
    return;
  }

  next();
}

// Admin-only portal routes. The caller must be listed in admin_users, the same
// table the Admin Dashboard's own database access is scoped by (migration 019).
// Not being a patient is not enough here: POST /review-decision passes a case to
// a lawyer and mints the review link, and GET /submissions returns every
// patient's name and contact details, so a lawyer's own session reaching either
// would undo what the review link withholds. A failed lookup refuses.
export async function requireAdminUser(req: Request, res: Response, next: NextFunction) {
  const authUserId = req.user?.id;
  if (!authUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { data: admin, error } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("admin_users lookup failed", { code: error.code });
    res.status(500).json({ error: "Failed to verify access" });
    return;
  }

  if (!admin) {
    res.status(403).json({ error: "admin_only" });
    return;
  }

  next();
}
