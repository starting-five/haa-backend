// Phone normalisation for every route that has to recognise a patient by their
// number. It lives on its own rather than beside the development OTP bridge
// because production routes depend on it: the duplicate-registration check
// compares what a browser typed against claimants.mobile, and the two have to
// be brought to the same shape before they can be compared at all.

/**
 * Accepts only a complete E.164 number. Separators a patient might type are
 * stripped, but no country code is inferred — guessing one would silently bind
 * a request to a different number than the caller intended.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const compact = raw.replace(/[\s()\-.]/g, "");
  return /^\+[1-9]\d{9,14}$/.test(compact) ? compact : null;
}
