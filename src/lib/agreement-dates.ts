// The dates the retainer needs, formatted for the patient's language.
//
// Two values are put into the agreement's DocuSign text tabs:
//   - the date of loss, from the accident the patient reported;
//   - the signing date, split into the day, month name and two-digit year the
//     "DATED this __ day of __, 20__" line is typeset for.
//
// Everything here is a pure string transform. DocuSign holds the tabs; this
// only decides what text goes in them, so it is unit-testable without a network.

/** en-US / es-ES drive both month names and the long date format below. */
function localeTag(locale: string): string {
  return locale === "es" ? "es-ES" : "en-US";
}

// The firm executes these agreements from Florida, so the signing date is
// stamped in its timezone rather than the server's. A host running in UTC would
// otherwise roll a late-evening signature to the next day.
const SIGNING_TIME_ZONE = "America/New_York";

/**
 * "September 5, 2026" / "5 de septiembre de 2026" from an ISO `yyyy-mm-dd`.
 * Returns null for anything that is not a plain date, so a missing or malformed
 * value is handled by the caller rather than printed as "Invalid Date".
 */
export function formatDateOfLoss(isoDate: string, locale: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  // A date-only value has no timezone; build and format it in UTC so it can
  // never shift a day the way a local-time Date would west of Greenwich.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(localeTag(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export interface SigningDateParts {
  /** Day of the month, e.g. "5". */
  day: string;
  /** Localized month name, e.g. "September" / "septiembre". */
  month: string;
  /** Two-digit year, e.g. "26" — the line reads "20___". */
  year: string;
}

/**
 * The three pieces of the signing date, for the moment the patient opens the
 * ceremony. Kept separate because the document has three distinct blanks, and a
 * DocuSign Date-Signed tab (one whole date) cannot fill them.
 */
export function signingDateParts(now: Date, locale: string): SigningDateParts {
  const tag = localeTag(locale);
  const day = new Intl.DateTimeFormat(tag, { day: "numeric", timeZone: SIGNING_TIME_ZONE }).format(now);
  const month = new Intl.DateTimeFormat(tag, { month: "long", timeZone: SIGNING_TIME_ZONE }).format(now);
  // Digits are locale-independent; en-US keeps the two-digit year unambiguous.
  const year = new Intl.DateTimeFormat("en-US", { year: "2-digit", timeZone: SIGNING_TIME_ZONE }).format(now);
  return { day, month, year };
}
