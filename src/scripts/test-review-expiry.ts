import { calculateReviewDecisionExpiry, calculateReviewLinkExpiry } from "../lib/review-expiry";

type Case = {
  name: string;
  now: string;
  expected: string;
};

const cases: Case[] = [
  {
    name: "during business hours uses 30 minutes",
    now: "2026-01-15T21:00:00.000Z", // 4:00 PM New York
    expected: "2026-01-15T21:30:00.000Z",
  },
  {
    name: "after 10 PM waits until next 8:30 AM",
    now: "2026-01-16T03:15:00.000Z", // 10:15 PM New York on Jan 15
    expected: "2026-01-16T13:30:00.000Z",
  },
  {
    name: "early morning waits until same-day 8:30 AM",
    now: "2026-01-15T08:00:00.000Z", // 3:00 AM New York
    expected: "2026-01-15T13:30:00.000Z",
  },
  {
    name: "just before 8 AM still waits until 8:30 AM",
    now: "2026-01-15T12:50:00.000Z", // 7:50 AM New York
    expected: "2026-01-15T13:30:00.000Z",
  },
  {
    name: "after 8 AM uses 30 minutes",
    now: "2026-01-15T13:05:00.000Z", // 8:05 AM New York
    expected: "2026-01-15T13:35:00.000Z",
  },
];

let failed = 0;

for (const kase of cases) {
  const actual = calculateReviewDecisionExpiry(new Date(kase.now)).toISOString();
  if (actual !== kase.expected) {
    failed += 1;
    console.error(`FAIL ${kase.name}: expected ${kase.expected}, got ${actual}`);
  } else {
    console.log(`PASS ${kase.name}`);
  }
}

const linkNow = new Date("2026-01-15T21:00:00.000Z");
const linkActual = calculateReviewLinkExpiry(linkNow).toISOString();
const linkExpected = "2026-01-29T21:00:00.000Z";
if (linkActual !== linkExpected) {
  failed += 1;
  console.error(`FAIL link expires in 14 days: expected ${linkExpected}, got ${linkActual}`);
} else {
  console.log("PASS link expires in 14 days");
}

if (failed > 0) {
  process.exit(1);
}
