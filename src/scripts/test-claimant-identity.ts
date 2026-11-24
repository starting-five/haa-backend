import "dotenv/config";
import { strict as assert } from "assert";
import { randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// Proves that the claimant a request acts on comes from the verified session
// and from nothing else. Two independent patients are created through the real
// endpoints, with real Supabase sessions, and every identifier the browser
// could tamper with is tried against them.
//
// This does not test agreement or storage authorization — those routes are
// still open, and closing them is Phase 2D.

const checks: [string, boolean][] = [];
const record = (label: string, passed: boolean) => checks.push([label, passed]);

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) {
    throw new Error(
      "TEST_SUPABASE_PROJECT_REF is required. Set it to the ref of a Supabase project " +
        "you own and are willing to have identities and claimants created in."
    );
  }
  // "local" names a Supabase CLI stack on this machine, and only on a loopback address.
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const configuredRef =
    expectedRef === "local"
      ? /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(supabaseUrl)
        ? "local"
        : undefined
      : supabaseUrl.match(/^https:\/\/([a-z]{20})\.supabase\.co/)?.[1];
  assert(
    configuredRef === expectedRef,
    "Refusing to run: SUPABASE_URL does not point at the project named by TEST_SUPABASE_PROJECT_REF"
  );

  process.env.DEV_OTP_BRIDGE = "enabled";
  delete process.env.NODE_ENV;

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const phones = new Set<string>();
  const newPhone = () => {
    const value = `+1555${randomInt(1_000_000, 9_999_999)}`;
    phones.add(value);
    return value;
  };

  const login = async (phone: string): Promise<string> => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(`${base}/intake/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: "111111" }),
      });
      if (response.ok) return ((await response.json()) as { accessToken: string }).accessToken;
      // Supabase burst-limits token verification; that is its quota, not our logic.
      if (response.status !== 502 || attempt === 4) throw new Error(`login failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw new Error("unreachable");
  };

  const start = (token: string | null, body: Record<string, unknown>) =>
    fetch(`${base}/intake/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const intake = (mobile: string, extra: Record<string, unknown> = {}) => ({
    locale: "en",
    claimant: { firstName: "Case", lastName: "Tester", mobile, ...extra },
    accident: { incidentType: "car", incidentLocation: "San Diego, CA", incidentDate: "2026-09-05" },
  });

  // Every value differs from anything the other helpers store, so a write would show.
  const mustNotApply = (mobile: string) => ({
    locale: "es",
    claimant: { firstName: "MustNotApply", lastName: "MustNotApply", mobile, email: "must-not-apply@example.com" },
    accident: { incidentType: "other", incidentLocation: "Must Not Apply", incidentDate: "2020-01-01" },
  });

  const phoneA = newPhone();
  const phoneB = newPhone();
  const orphanPhone = newPhone();
  const strandedPhone = newPhone();

  try {
    const tokenA = await login(phoneA);
    const tokenB = await login(phoneB);

    // ── authentication is required at all ───────────────────────────────────
    record("missing JWT is rejected", (await start(null, intake(phoneA))).status === 401);
    record("invalid JWT is rejected", (await start("not.a.token", intake(phoneA))).status === 401);

    const { data: afterUnauthenticated } = await supabase.from("claimants").select("id").eq("mobile", phoneA);
    record("a rejected request creates no claimant", (afterUnauthenticated ?? []).length === 0);

    // ── Case D: no claimant yet, one is created and bound ───────────────────
    const createdA = await start(tokenA, intake(phoneA));
    const bodyA = (await createdA.json()) as { existing?: boolean; submissionId?: string };
    const { data: claimantA } = await supabase
      .from("claimants")
      .select("id, user_id")
      .eq("mobile", phoneA)
      .maybeSingle();
    const { data: userA } = await supabase.auth.getUser(tokenA);

    record("Case D creates a claimant", createdA.status === 201 && Boolean(claimantA));
    record("Case D binds claimant.user_id to the session user", claimantA?.user_id === userA.user?.id);
    record("Case D returns a submission", Boolean(bodyA.submissionId));

    const { data: submissionA } = await supabase
      .from("intake_submissions")
      .select("claimant_id")
      .eq("id", bodyA.submissionId!)
      .maybeSingle();
    record("the submission belongs to the resolved claimant", submissionA?.claimant_id === claimantA?.id);

    // ── Case A: the same user again resolves to the same claimant ───────────
    // Their first intake was never submitted, so starting again resumes it with
    // what they have just entered rather than opening a second case.
    const claimantRowA = async () =>
      (
        await supabase
          .from("claimants")
          .select("first_name, last_name, email, preferred_language")
          .eq("id", claimantA!.id)
          .maybeSingle()
      ).data;
    const submissionRowsA = async () =>
      (await supabase.from("intake_submissions").select("id, status, locale").eq("claimant_id", claimantA!.id)).data ??
      [];
    const accidentRowsA = async () =>
      (
        await supabase
          .from("accidents")
          .select("incident_type, incident_location, incident_date, incident_lat, incident_place_id")
          .eq("submission_id", bodyA.submissionId!)
      ).data ?? [];

    const repeatA = await start(tokenA, {
      locale: "es",
      claimant: { firstName: "Resumed", lastName: "Again", mobile: phoneA, email: "resumed@example.com" },
      accident: {
        incidentType: "truck",
        incidentLocation: "Tampa, FL",
        incidentDate: "2026-09-06",
        incidentLocationDetails: {
          text: "Tampa, FL",
          latitude: 27.95,
          longitude: -82.46,
          placeId: "place-case-a",
          city: "Tampa",
          state: "FL",
          postalCode: "33602",
          source: "autosuggest",
          precision: "city_estimate",
        },
      },
    });
    const repeatBodyA = (await repeatA.json()) as { existing?: boolean; submissionId?: string };
    const { data: claimantsForA } = await supabase.from("claimants").select("id").eq("mobile", phoneA);
    const resumedClaimantA = await claimantRowA();
    const resumedSubmissionsA = await submissionRowsA();
    const resumedAccidentsA = await accidentRowsA();
    record("Case A creates no second claimant", (claimantsForA ?? []).length === 1);
    record(
      "Case A resumes the unsubmitted intake",
      repeatA.status === 200 && repeatBodyA.existing === false && repeatBodyA.submissionId === bodyA.submissionId
    );
    record("Case A creates no second submission", resumedSubmissionsA.length === 1);
    record(
      "Case A refreshes the claimant from the new answers",
      resumedClaimantA?.first_name === "Resumed" &&
        resumedClaimantA?.last_name === "Again" &&
        resumedClaimantA?.email === "resumed@example.com" &&
        resumedClaimantA?.preferred_language === "es"
    );
    record("Case A refreshes the submission's locale", resumedSubmissionsA[0]?.locale === "es");
    record(
      "Case A refreshes the accident without adding one",
      resumedAccidentsA.length === 1 &&
        resumedAccidentsA[0]?.incident_type === "truck" &&
        resumedAccidentsA[0]?.incident_location === "Tampa, FL" &&
        resumedAccidentsA[0]?.incident_date === "2026-09-06" &&
        resumedAccidentsA[0]?.incident_lat === 27.95 &&
        resumedAccidentsA[0]?.incident_place_id === "place-case-a"
    );

    // What the new intake leaves out is cleared, as a first start would store it.
    const clearedA = await start(tokenA, {
      locale: "en",
      claimant: { firstName: "Resumed", lastName: "Cleared", mobile: phoneA },
      accident: { incidentType: "car", incidentLocation: "San Diego, CA", incidentLocationDetails: null },
    });
    const clearedClaimantA = await claimantRowA();
    const clearedAccidentsA = await accidentRowsA();
    record(
      "a resume clears what the new answers leave out",
      clearedA.status === 200 &&
        clearedClaimantA?.last_name === "Cleared" &&
        clearedClaimantA?.email === null &&
        clearedAccidentsA[0]?.incident_date === null &&
        clearedAccidentsA[0]?.incident_lat === null &&
        clearedAccidentsA[0]?.incident_place_id === null
    );

    // ── Patient B is entirely separate ──────────────────────────────────────
    const createdB = await start(tokenB, intake(phoneB));
    const bodyB = (await createdB.json()) as { submissionId?: string };
    const { data: claimantB } = await supabase
      .from("claimants")
      .select("id, user_id")
      .eq("mobile", phoneB)
      .maybeSingle();
    const { data: userB } = await supabase.auth.getUser(tokenB);

    record("Patient B gets their own claimant", createdB.status === 201 && Boolean(claimantB));
    record("A and B are different auth identities", userA.user?.id !== userB.user?.id);
    record("A and B are different claimants", claimantA?.id !== claimantB?.id);
    record("B's claimant is bound to B", claimantB?.user_id === userB.user?.id);

    // ── nothing in the body can select another patient ──────────────────────
    const forgedIds = await start(tokenA, {
      locale: "es",
      claimant: { firstName: "Forged", lastName: "Request", mobile: phoneA },
      accident: { incidentType: "bus", incidentLocation: "Forged City" },
      user_id: userB.user?.id,
      claimantId: claimantB?.id,
      claimant_id: claimantB?.id,
      submissionId: bodyB.submissionId,
    });
    const forgedBody = (await forgedIds.json()) as { existing?: boolean; submissionId?: string };
    const { data: claimantAAfter } = await supabase
      .from("claimants")
      .select("id, user_id")
      .eq("mobile", phoneA)
      .maybeSingle();
    const { data: claimantBAfterForged } = await supabase
      .from("claimants")
      .select("user_id, first_name, preferred_language")
      .eq("id", claimantB!.id)
      .maybeSingle();
    const { data: accidentBAfterForged } = await supabase
      .from("accidents")
      .select("incident_type, incident_location")
      .eq("submission_id", bodyB.submissionId!)
      .maybeSingle();
    record(
      "A supplying B's identifiers resumes only A's own intake",
      forgedIds.status === 200 && forgedBody.existing === false && forgedBody.submissionId === bodyA.submissionId
    );
    record("A's claimant is still A's after the forged request", claimantAAfter?.user_id === userA.user?.id);
    record(
      "B's claimant was neither reassigned nor rewritten",
      claimantBAfterForged?.user_id === userB.user?.id &&
        claimantBAfterForged?.first_name === "Case" &&
        claimantBAfterForged?.preferred_language === "en"
    );
    record(
      "B's accident was not rewritten",
      accidentBAfterForged?.incident_type === "car" && accidentBAfterForged?.incident_location === "San Diego, CA"
    );

    // ── a phone that disagrees with the session is refused ──────────────────
    const forgedPhone = await start(tokenA, intake(phoneB));
    record("A sending B's phone is refused", forgedPhone.status === 403);
    const { data: claimantBAfter } = await supabase
      .from("claimants")
      .select("user_id")
      .eq("mobile", phoneB)
      .maybeSingle();
    record("the refusal left B's claimant untouched", claimantBAfter?.user_id === userB.user?.id);

    // ── a submitted case is not resumed, and nothing is written ─────────────
    await supabase.from("intake_submissions").update({ status: "submitted" }).eq("id", bodyA.submissionId!);
    const beforeSubmittedStart = {
      claimant: await claimantRowA(),
      submissions: await submissionRowsA(),
      accidents: await accidentRowsA(),
    };
    const afterSubmit = await start(tokenA, mustNotApply(phoneA));
    const afterSubmitBody = (await afterSubmit.json()) as { existing?: boolean; submissionId?: string };
    const afterSubmittedStart = {
      claimant: await claimantRowA(),
      submissions: await submissionRowsA(),
      accidents: await accidentRowsA(),
    };
    record(
      "a claimant with a submitted case is still answered existing",
      afterSubmit.status === 200 && afterSubmitBody.existing === true && !afterSubmitBody.submissionId
    );
    record("a submitted case gets no second submission", afterSubmittedStart.submissions.length === 1);
    record(
      "starting again with a submitted case writes nothing",
      JSON.stringify(afterSubmittedStart) === JSON.stringify(beforeSubmittedStart)
    );

    // ── Case B: a claimant created before authentication existed ────────────
    await supabase.from("claimants").insert({
      first_name: "Legacy",
      last_name: "Record",
      mobile: orphanPhone,
      preferred_language: "en",
    });
    const tokenOrphan = await login(orphanPhone);
    const { data: userOrphan } = await supabase.auth.getUser(tokenOrphan);
    const adopted = await start(tokenOrphan, intake(orphanPhone));
    const adoptedBody = (await adopted.json()) as { existing?: boolean; submissionId?: string };
    const { data: claimantOrphan } = await supabase
      .from("claimants")
      .select("id, user_id, first_name")
      .eq("mobile", orphanPhone)
      .maybeSingle();
    const { data: orphanSubmissions } = await supabase
      .from("intake_submissions")
      .select("id")
      .eq("claimant_id", claimantOrphan!.id);
    record("Case B adopts the unowned claimant", claimantOrphan?.user_id === userOrphan.user?.id);
    // It holds no case, so it is given one. It used to be answered `existing`
    // and nothing was written, which sent the patient to attorney matching with
    // no case behind it; see test-stranded-claimant.ts.
    record(
      "Case B, holding no case, is given one with the details just entered",
      adopted.status === 201 &&
        adoptedBody.existing === false &&
        (orphanSubmissions ?? []).length === 1 &&
        orphanSubmissions?.[0]?.id === adoptedBody.submissionId &&
        claimantOrphan?.first_name === "Case"
    );
    const { data: orphanClaimants } = await supabase.from("claimants").select("id").eq("mobile", orphanPhone);
    record("Case B creates no duplicate claimant", (orphanClaimants ?? []).length === 1);

    // A legacy claimant that already holds an unsubmitted intake is adopted and resumes it.
    const legacyResumePhone = newPhone();
    const { data: legacyClaimant } = await supabase
      .from("claimants")
      .insert({ first_name: "Legacy", last_name: "Intake", mobile: legacyResumePhone, preferred_language: "en" })
      .select("id")
      .single();
    const legacySubmissionId = randomUUID();
    await supabase
      .from("intake_submissions")
      .insert({ id: legacySubmissionId, claimant_id: legacyClaimant!.id, status: "intake", locale: "en" });
    await supabase
      .from("accidents")
      .insert({ submission_id: legacySubmissionId, incident_type: "car", incident_location: "Legacy City" });
    const tokenLegacy = await login(legacyResumePhone);
    const { data: userLegacy } = await supabase.auth.getUser(tokenLegacy);
    const legacyStart = await start(tokenLegacy, {
      ...intake(legacyResumePhone),
      claimant: { firstName: "Adopted", lastName: "Intake", mobile: legacyResumePhone },
    });
    const legacyBody = (await legacyStart.json()) as { existing?: boolean; submissionId?: string };
    const { data: legacyAfter } = await supabase
      .from("claimants")
      .select("user_id, first_name")
      .eq("id", legacyClaimant!.id)
      .maybeSingle();
    record(
      "a legacy claimant with an unsubmitted intake is adopted and resumes it",
      legacyAfter?.user_id === userLegacy.user?.id &&
        legacyAfter?.first_name === "Adopted" &&
        legacyStart.status === 200 &&
        legacyBody.existing === false &&
        legacyBody.submissionId === legacySubmissionId
    );

    // ── Case C: a claimant already owned by somebody else ───────────────────
    // Constructed directly, because the application cannot produce it: a
    // claimant whose mobile belongs to one patient while its user_id belongs to
    // another. claimants.user_id is unique, so the owner must be a user holding
    // no other claimant.
    const { data: otherOwner } = await supabase.auth.admin.createUser({
      phone: newPhone(),
      phone_confirm: true,
    });
    await supabase.from("claimants").insert({
      user_id: otherOwner.user!.id,
      first_name: "Stranded",
      last_name: "Record",
      mobile: strandedPhone,
      preferred_language: "en",
    });

    const tokenStranded = await login(strandedPhone);
    const stranded = await start(tokenStranded, intake(strandedPhone));
    const { data: strandedAfter } = await supabase
      .from("claimants")
      .select("user_id")
      .eq("mobile", strandedPhone)
      .maybeSingle();

    record("Case C refuses a claimant owned by another user", stranded.status === 403);
    record("Case C leaves the existing owner in place", strandedAfter?.user_id === otherOwner.user!.id);

    // ── concurrent first-time start for one session ─────────────────────────
    const racePhone = newPhone();
    const tokenRace = await login(racePhone);
    const raced = await Promise.all([start(tokenRace, intake(racePhone)), start(tokenRace, intake(racePhone))]);
    const { data: racedClaimants } = await supabase.from("claimants").select("id").eq("mobile", racePhone);
    const { data: userRace } = await supabase.auth.getUser(tokenRace);
    record(
      "concurrent starts both answer",
      raced.every((r) => r.status === 200 || r.status === 201)
    );
    record("concurrent starts create exactly one claimant", (racedClaimants ?? []).length === 1);
    const { data: racedOwned } = await supabase
      .from("claimants")
      .select("user_id")
      .eq("mobile", racePhone)
      .maybeSingle();
    record("the raced claimant is owned by the session user", racedOwned?.user_id === userRace.user?.id);

    // ── concurrent resumes of one abandoned intake ──────────────────────────
    const resumePhone = newPhone();
    const tokenResume = await login(resumePhone);
    const firstResume = (await (await start(tokenResume, intake(resumePhone))).json()) as { submissionId?: string };
    const resumed = await Promise.all([
      start(tokenResume, intake(resumePhone)),
      start(tokenResume, intake(resumePhone)),
    ]);
    const resumedBodies = (await Promise.all(resumed.map((response) => response.json()))) as {
      existing?: boolean;
      submissionId?: string;
    }[];
    const { data: resumeClaimant } = await supabase
      .from("claimants")
      .select("id")
      .eq("mobile", resumePhone)
      .maybeSingle();
    const { data: resumeSubmissions } = await supabase
      .from("intake_submissions")
      .select("id")
      .eq("claimant_id", resumeClaimant!.id);
    const { data: resumeAccidents } = await supabase
      .from("accidents")
      .select("id")
      .eq("submission_id", firstResume.submissionId!);
    record(
      "concurrent resumes both return the abandoned submission",
      resumedBodies.every((body) => body.existing === false && body.submissionId === firstResume.submissionId)
    );
    record("concurrent resumes create no second submission", (resumeSubmissions ?? []).length === 1);
    record("concurrent resumes add no accident", (resumeAccidents ?? []).length === 1);

    // ── a submitted case beside an unsubmitted one is never resumed ─────────
    // Whether one patient may hold several cases is an open product decision, so a
    // claimant with any submitted case is answered existing and nothing of theirs is
    // rewritten, even when an in-progress submission also exists.
    const mixedPhone = newPhone();
    const tokenMixed = await login(mixedPhone);
    const mixedFirst = (await (await start(tokenMixed, intake(mixedPhone))).json()) as { submissionId?: string };
    await supabase.from("intake_submissions").update({ status: "submitted" }).eq("id", mixedFirst.submissionId!);
    const { data: mixedClaimant } = await supabase
      .from("claimants")
      .select("id")
      .eq("mobile", mixedPhone)
      .maybeSingle();
    const mixedInProgressId = randomUUID();
    await supabase
      .from("intake_submissions")
      .insert({ id: mixedInProgressId, claimant_id: mixedClaimant!.id, status: "intake", locale: "en" });
    await supabase
      .from("accidents")
      .insert({ submission_id: mixedInProgressId, incident_type: "car", incident_location: "Second Case" });
    const mixedSnapshot = async () => ({
      claimant: (
        await supabase
          .from("claimants")
          .select("first_name, last_name, email, preferred_language")
          .eq("id", mixedClaimant!.id)
          .maybeSingle()
      ).data,
      submissions: (
        await supabase
          .from("intake_submissions")
          .select("id, status, locale")
          .eq("claimant_id", mixedClaimant!.id)
          .order("id")
      ).data,
      accident: (
        await supabase
          .from("accidents")
          .select("incident_type, incident_location, incident_date")
          .eq("submission_id", mixedInProgressId)
          .maybeSingle()
      ).data,
    });
    const mixedBefore = await mixedSnapshot();
    const mixedStart = await start(tokenMixed, mustNotApply(mixedPhone));
    const mixedBody = (await mixedStart.json()) as { existing?: boolean; submissionId?: string };
    const mixedAfter = await mixedSnapshot();
    record(
      "a claimant with a submitted and an unsubmitted case is answered existing",
      mixedStart.status === 200 && mixedBody.existing === true && !mixedBody.submissionId
    );
    record(
      "neither of that claimant's cases, nor the claimant, is rewritten",
      JSON.stringify(mixedAfter) === JSON.stringify(mixedBefore)
    );

    // ── one claimant, one unsubmitted intake ────────────────────────────────
    // This used to insert a second unsubmitted intake and check the newer was
    // the one resumed. Migration 016 allows one per claimant, so that state can
    // no longer be written; the database refusing it is what is checked now.
    const severalPhone = newPhone();
    const tokenSeveral = await login(severalPhone);
    const openSubmission = (await (await start(tokenSeveral, intake(severalPhone))).json()) as {
      submissionId?: string;
    };
    const { data: severalClaimant } = await supabase
      .from("claimants")
      .select("id")
      .eq("mobile", severalPhone)
      .maybeSingle();
    const { error: secondOpenError } = await supabase.from("intake_submissions").insert({
      id: randomUUID(),
      claimant_id: severalClaimant!.id,
      status: "intake",
      locale: "en",
    });
    const severalStart = await start(tokenSeveral, {
      ...intake(severalPhone),
      accident: { incidentType: "truck", incidentLocation: "Resumed Open" },
    });
    const severalBody = (await severalStart.json()) as { existing?: boolean; submissionId?: string };
    const { data: severalSubmissions } = await supabase
      .from("intake_submissions")
      .select("id")
      .eq("claimant_id", severalClaimant!.id);
    const { data: openAccident } = await supabase
      .from("accidents")
      .select("incident_location")
      .eq("submission_id", openSubmission.submissionId!)
      .maybeSingle();
    record("a second unsubmitted intake for one claimant is refused", secondOpenError?.code === "23505");
    record(
      "the one unsubmitted intake is the one resumed",
      severalBody.existing === false &&
        severalBody.submissionId === openSubmission.submissionId &&
        (severalSubmissions ?? []).length === 1 &&
        openAccident?.incident_location === "Resumed Open"
    );

    // ── an intake without its accident row is resumed, not abandoned ────────
    // This used to be refused: every case was opened with an accident, so one
    // without meant a start that had failed part-way. The case is now opened
    // when the number is verified and the accident arrives afterwards, so this
    // is the ordinary state of an intake between the code screen and the
    // location screen. Refusing it would strand the patient it exists to help.
    const pendingPhone = newPhone();
    const tokenPending = await login(pendingPhone);
    const pendingSubmission = (await (await start(tokenPending, intake(pendingPhone))).json()) as {
      submissionId?: string;
    };
    await supabase.from("accidents").delete().eq("submission_id", pendingSubmission.submissionId!);
    const pendingStart = await start(tokenPending, intake(pendingPhone, { firstName: "Resumed" }));
    const pendingBody = (await pendingStart.json()) as { existing?: boolean; submissionId?: string };
    const { data: pendingAccidents } = await supabase
      .from("accidents")
      .select("id")
      .eq("submission_id", pendingSubmission.submissionId!);
    record(
      "an unsubmitted intake without its accident is resumed, and the accident attaches to it",
      pendingStart.status === 200 &&
        pendingBody.existing === false &&
        pendingBody.submissionId === pendingSubmission.submissionId &&
        (pendingAccidents ?? []).length === 1
    );
  } finally {
    server.close();

    // Remove only what this run created, in dependency order.
    for (const phone of phones) {
      const { data: claimant } = await supabase.from("claimants").select("id").eq("mobile", phone).maybeSingle();
      if (claimant) {
        const { data: submissions } = await supabase
          .from("intake_submissions")
          .select("id")
          .eq("claimant_id", claimant.id);
        for (const submission of submissions ?? []) {
          await supabase.from("accidents").delete().eq("submission_id", submission.id);
          await supabase.from("intake_submissions").delete().eq("id", submission.id);
        }
        await supabase.from("claimants").delete().eq("id", claimant.id);
      }

      const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      for (const user of users.users ?? []) {
        if (user.phone === phone.replace("+", "")) await supabase.auth.admin.deleteUser(user.id);
      }
    }

    let leftovers = 0;
    for (const phone of phones) {
      const { data } = await supabase.from("claimants").select("id").eq("mobile", phone);
      leftovers += (data ?? []).length;
    }
    record("every record created by this test was removed", leftovers === 0);
  }

  console.log("Authenticated claimant identity:");
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) throw new Error(`${failed} claimant identity check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: the session decides the claimant, and nothing in the body can");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
