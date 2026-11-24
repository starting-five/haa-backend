const REVIEW_LINK_TTL_DAYS = 14;
const REVIEW_DECISION_TTL_MINUTES = 30;
const REVIEW_LINK_TIME_ZONE = "America/New_York";
const REVIEW_LINK_BUSINESS_START_HOUR = 8;
const REVIEW_LINK_AFTER_HOURS_START_HOUR = 22;

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function localPartsFor(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const valueFor = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };

  return {
    year: valueFor("year"),
    month: valueFor("month"),
    day: valueFor("day"),
    hour: valueFor("hour"),
    minute: valueFor("minute"),
    second: valueFor("second"),
  };
}

function localDatePlusDays(parts: LocalDateTimeParts, days: number): Pick<LocalDateTimeParts, "year" | "month" | "day"> {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function zonedLocalTimeToUtc(
  localDate: Pick<LocalDateTimeParts, "year" | "month" | "day">,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const utcGuess = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day, hour, minute, 0));
  const guessParts = localPartsFor(utcGuess, timeZone);
  const wantedUtc = Date.UTC(localDate.year, localDate.month - 1, localDate.day, hour, minute, 0);
  const guessedUtc = Date.UTC(
    guessParts.year,
    guessParts.month - 1,
    guessParts.day,
    guessParts.hour,
    guessParts.minute,
    guessParts.second
  );

  return new Date(utcGuess.getTime() + (wantedUtc - guessedUtc));
}

export function calculateReviewLinkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + REVIEW_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function calculateReviewDecisionExpiry(now: Date = new Date()): Date {
  const localNow = localPartsFor(now, REVIEW_LINK_TIME_ZONE);
  const isAfterHours =
    localNow.hour >= REVIEW_LINK_AFTER_HOURS_START_HOUR || localNow.hour < REVIEW_LINK_BUSINESS_START_HOUR;

  if (!isAfterHours) {
    return new Date(now.getTime() + REVIEW_DECISION_TTL_MINUTES * 60 * 1000);
  }

  const expiryDate =
    localNow.hour < REVIEW_LINK_BUSINESS_START_HOUR
      ? localNow
      : localDatePlusDays(localNow, 1);

  return zonedLocalTimeToUtc(
    expiryDate,
    REVIEW_LINK_BUSINESS_START_HOUR,
    REVIEW_DECISION_TTL_MINUTES,
    REVIEW_LINK_TIME_ZONE
  );
}
