import "dotenv/config";
import { strict as assert } from "assert";
import { createHash, randomBytes, randomInt, randomUUID } from "crypto";
import type { AddressInfo } from "net";

// Proves who may open a patient's signed retainer through a lawyer's review
// link, against the real routes, database and Storage: only a link whose lawyer
// has accepted, for that case, and only that case's own retainer. Before
// acceptance the link learns that a retainer is signed and nothing that would
// locate it. DocuSign is stubbed and every call to it counted, so "served as
// stored, DocuSign not asked again" is an observation.
//
// Writes rows and Storage objects, all marked and removed afterwards. Runs only
// against the project TEST_SUPABASE_PROJECT_REF names, or "local" for a
// Supabase CLI stack on a loopback address.

type Json = Record<string, unknown>;

const TEST_MARKER = "LawyerRetainerFixture";

async function main(): Promise<void> {
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF?.trim();
  if (!expectedRef) throw new Error("TEST_SUPABASE_PROJECT_REF is required.");
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

  // Every DocuSign request is counted and refused; Supabase passes through.
  const original = globalThis.fetch;
  let docusignCalls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/docusign\.(net|com)/.test(url)) {
      docusignCalls += 1;
      return new Response("{}", { status: 500 });
    }
    return original(input, init);
  }) as typeof fetch;

  const { supabase } = await import("../lib/supabase");
  const { app } = await import("../app");
  const { AGREEMENTS_BUCKET, signedDocumentPath } = await import("../lib/agreement-document");

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const checks: [string, boolean][] = [];
  const record = (label: string, passed: boolean) => checks.push([label, passed]);

  const post = async (path: string, payload: unknown) => {
    const response = await original(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let body: Json = {};
    try {
      body = JSON.parse(bytes.toString("utf8")) as Json;
    } catch {
      // a PDF
    }
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString("latin1"), body };
  };

  const created: { userIds: string[]; submissionIds: string[]; objects: string[] } = {
    userIds: [],
    submissionIds: [],
    objects: [],
  };

  type Kase = { label: string; userId: string; submissionId: string; agreementId: string | null; pdf: Buffer | null };

  /** A submitted case; with "signed" its retainer is a completed agreement whose PDF Storage holds. */
  const makeCase = async (label: string, agreement: "signed" | "sent" | "none"): Promise<Kase> => {
    const phone = `+1555${randomInt(1_000_000, 9_999_999)}`;
    const { data: user, error: userError } = await supabase.auth.admin.createUser({
      phone,
      phone_confirm: true,
      user_metadata: { suite: TEST_MARKER },
    });
    if (userError || !user.user) throw new Error(`createUser failed: ${userError?.message}`);
    created.userIds.push(user.user.id);

    const { data: claimant, error: claimantError } = await supabase
      .from("claimants")
      .insert({ user_id: user.user.id, first_name: label, last_name: TEST_MARKER, mobile: phone })
      .select("id")
      .single();
    if (claimantError || !claimant) throw new Error(`claimant insert failed: ${claimantError?.message}`);

    const submissionId = randomUUID();
    const { error: submissionError } = await supabase
      .from("intake_submissions")
      .insert({ id: submissionId, claimant_id: claimant.id, status: "signed", locale: "en" });
    if (submissionError) throw new Error(`submission insert failed: ${submissionError.message}`);
    created.submissionIds.push(submissionId);
    await supabase.from("accidents").insert({
      submission_id: submissionId,
      incident_type: "car",
      incident_location: "Austin, TX",
      incident_date: "2026-09-20",
    });

    if (agreement === "none") return { label, userId: user.user.id, submissionId, agreementId: null, pdf: null };

    const agreementId = randomUUID();
    const path = signedDocumentPath(submissionId, agreementId);
    const { error: agreementError } = await supabase.from("agreements").insert({
      id: agreementId,
      submission_id: submissionId,
      envelope_id: `retainer-fixture-${randomUUID()}`,
      status: agreement === "signed" ? "completed" : "sent",
      locale: "en",
      recipient_client_user_id: agreementId,
      signed_document_path: agreement === "signed" ? path : null,
      completed_at: agreement === "signed" ? new Date().toISOString() : null,
    });
    if (agreementError) throw new Error(`agreement insert failed: ${agreementError.message}`);

    if (agreement !== "signed") return { label, userId: user.user.id, submissionId, agreementId, pdf: null };

    const pdf = Buffer.from(`%PDF-1.4\n% Signed retainer fixture for ${label} ${randomUUID()}\n%%EOF\n`, "latin1");
    const upload = await supabase.storage
      .from(AGREEMENTS_BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });
    if (upload.error) throw new Error(`retainer upload failed: ${upload.error.message}`);
    created.objects.push(path);
    return { label, userId: user.user.id, submissionId, agreementId, pdf };
  };

  /** A review link for a case, in the given state; the token is what the lawyer holds. */
  const makeLink = async (kase: Kase, state: Json = {}) => {
    const token = randomBytes(24).toString("base64url");
    const { error } = await supabase.from("review_assignments").insert({
      submission_id: kase.submissionId,
      assigned_by_user_id: randomUUID(),
      assignment_mode: "invite_link",
      status: "pending",
      review_link_token_hash: createHash("sha256").update(token).digest("hex"),
      expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      decision_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      ...state,
    });
    if (error) throw new Error(`assignment insert failed: ${error.message}`);
    return token;
  };

  const credential = (kase: Kase, token: string) => ({
    claimantUserId: kase.userId,
    submissionId: kase.submissionId,
    token,
  });
  const reviewCase = (kase: Kase, token: string) => post("/portal/review-case", credential(kase, token));
  const retainer = (kase: Kase, token: string, extra: Json = {}) =>
    post("/portal/review-retainer", { ...credential(kase, token), ...extra });
  const objectsUnder = async (submissionId: string) =>
    ((await supabase.storage.from(AGREEMENTS_BUCKET).list(submissionId, { limit: 100 })).data ?? []).length;

  try {
    const A = await makeCase("RetainerA", "signed");
    const B = await makeCase("RetainerB", "signed");
    const C = await makeCase("RetainerC", "none");
    const D = await makeCase("RetainerD", "sent");
    const tokenA = await makeLink(A);
    const tokenB = await makeLink(B);
    const tokenC = await makeLink(C);
    const tokenD = await makeLink(D);
    const locators = (kase: Kase) =>
      [kase.agreementId ?? "@@", signedDocumentPath(kase.submissionId, kase.agreementId ?? "@@"), "agreements/"].filter(
        Boolean
      );

    // ── before acceptance ────────────────────────────────────────────────────
    const pendingA = await reviewCase(A, tokenA);
    const pendingRetainer = (pendingA.body.signedRetainer ?? {}) as Json;
    record(
      "1. pending: the lawyer is told a retainer is signed, and that it is not available yet",
      pendingA.status === 200 && pendingRetainer.signed === true && pendingRetainer.available === false
    );
    record(
      "2. pending: the case response holds no agreement id, retainer path or URL",
      !locators(A).some((value) => pendingA.text.includes(value)) &&
        !/\/storage\/v1\/|signedUrl|token=/i.test(pendingA.text)
    );
    record(
      "2. pending: the retainer object is exactly { signed, available }",
      Object.keys(pendingRetainer).join() === "signed,available"
    );
    const earlyA = await retainer(A, tokenA);
    record(
      "3–4. pending: the retainer endpoint refuses (403) and returns no PDF bytes",
      earlyA.status === 403 && earlyA.body.error === "retainer_unavailable" && !earlyA.text.includes("%PDF")
    );
    const guessed = await post("/portal/review-document", { ...credential(A, tokenA), documentId: A.agreementId });
    record(
      "5. pending: the agreement id used as a document id opens nothing (404)",
      guessed.status === 404 && !guessed.text.includes("%PDF")
    );
    const crossCase = await retainer(B, tokenA);
    record(
      "6. A's link for B's case is a bad token (401)",
      crossCase.status === 401 && !crossCase.text.includes("%PDF")
    );
    const crossPatient = await post("/portal/review-retainer", {
      claimantUserId: B.userId,
      submissionId: A.submissionId,
      token: tokenA,
    });
    record("7. A's case named with B's patient is a bad token (401)", crossPatient.status === 401);
    record("no agreement: not signed", ((await reviewCase(C, tokenC)).body.signedRetainer as Json)?.signed === false);
    record(
      "agreement still out for signing: not signed",
      ((await reviewCase(D, tokenD)).body.signedRetainer as Json)?.signed === false
    );

    // ── the lawyer accepts ───────────────────────────────────────────────────
    const accept = await post("/portal/review-decision-link", { ...credential(A, tokenA), action: "accept_case" });
    record("the lawyer accepts A through the link", accept.status === 200);

    const acceptedA = await reviewCase(A, tokenA);
    const acceptedRetainer = (acceptedA.body.signedRetainer ?? {}) as Json;
    record(
      "11. accepted: the Signed Retainer is offered",
      acceptedA.body.access === "full" && acceptedRetainer.signed === true && acceptedRetainer.available === true
    );
    record(
      "accepted: the case response still holds no agreement id, retainer path or URL",
      !locators(A).some((value) => acceptedA.text.includes(value)) && !/\/storage\/v1\//.test(acceptedA.text)
    );

    const objectsBefore = await objectsUnder(A.submissionId);
    const agreementsBefore = (await supabase.from("agreements").select("id").eq("submission_id", A.submissionId)).data
      ?.length;
    const openA = await retainer(A, tokenA);
    record("12. accepted: the retainer opens (200)", openA.status === 200);
    record("13. it is this case's own signed retainer, byte for byte", Boolean(A.pdf) && openA.bytes.equals(A.pdf!));
    record("13. and not another case's", Boolean(B.pdf) && !openA.bytes.equals(B.pdf!));
    record(
      "14. served as an inline PDF under a neutral name, not cached, not sniffed",
      openA.headers.get("content-type") === "application/pdf" &&
        /^inline; filename="Signed Retainer\.pdf"/.test(openA.headers.get("content-disposition") ?? "") &&
        openA.headers.get("x-content-type-options") === "nosniff" &&
        openA.headers.get("cache-control") === "private, no-store"
    );
    record(
      "15. accepted A's link still cannot open B's retainer",
      (await retainer(B, tokenA)).status === 401 && (await retainer(B, tokenB)).status === 403
    );
    const tampered = await retainer(A, tokenA, {
      agreementId: B.agreementId,
      documentId: B.agreementId,
      path: signedDocumentPath(B.submissionId, B.agreementId!),
      objectPath: signedDocumentPath(B.submissionId, B.agreementId!),
      bucket: "submissions",
    });
    record(
      "16. ids, paths and buckets in the request are ignored: A's own retainer comes back",
      tampered.bytes.equals(A.pdf!)
    );
    record(
      "16. malformed ids are refused (400)",
      (await post("/portal/review-retainer", { ...credential(A, tokenA), submissionId: "../x" })).status === 400
    );

    // A row edited to point at another case's retainer is not followed.
    await supabase
      .from("agreements")
      .update({ signed_document_path: signedDocumentPath(B.submissionId, B.agreementId!) })
      .eq("id", A.agreementId!);
    const redirected = await retainer(A, tokenA);
    const redirectedCase = await reviewCase(A, tokenA);
    record(
      "16. an agreement row pointing at another case's object serves nothing (404)",
      redirected.status === 404 && !redirected.bytes.equals(B.pdf!) && !redirected.text.includes("%PDF")
    );
    record("…and the review page does not offer it", (redirectedCase.body.signedRetainer as Json)?.available === false);
    await supabase
      .from("agreements")
      .update({ signed_document_path: signedDocumentPath(A.submissionId, A.agreementId!) })
      .eq("id", A.agreementId!);

    record("17. opening it wrote nothing to Storage", (await objectsUnder(A.submissionId)) === objectsBefore);
    record(
      "18. no agreement or envelope was created, and DocuSign was never asked",
      (await supabase.from("agreements").select("id").eq("submission_id", A.submissionId)).data?.length ===
        agreementsBefore && docusignCalls === 0
    );

    // ── other states of a link to the same case ──────────────────────────────
    const revoked = await makeLink(A, { status: "revoked", revoked_at: new Date().toISOString() });
    record("8. a revoked link cannot open it (401)", (await retainer(A, revoked)).status === 401);
    const rejected = await makeLink(A, { status: "rejected", rejected_at: new Date().toISOString() });
    record("9. a rejected link cannot open it (403)", (await retainer(A, rejected)).status === 403);
    const expired = await makeLink(A, { expires_at: new Date(Date.now() - 60_000).toISOString() });
    record("10. an expired link cannot open it (403)", (await retainer(A, expired)).status === 403);
    const acceptedExpired = await makeLink(A, {
      status: "accepted",
      accepted_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    record(
      "an accepted link past its expiry cannot open it (403)",
      (await retainer(A, acceptedExpired)).status === 403
    );
    const acceptedUnrecorded = await makeLink(A, { status: "accepted", accepted_at: null });
    record(
      "an accepted link without an acceptance time cannot open it (403)",
      (await retainer(A, acceptedUnrecorded)).status === 403
    );
    record(
      "no session-free caller can open it with a made-up token (401)",
      (await retainer(A, randomBytes(24).toString("base64url"))).status === 401
    );

    // ── accepted, nothing to open ────────────────────────────────────────────
    await post("/portal/review-decision-link", { ...credential(C, tokenC), action: "accept_case" });
    const acceptedC = await reviewCase(C, tokenC);
    record(
      "accepted with no signed retainer: nothing offered, and the endpoint answers 404",
      (acceptedC.body.signedRetainer as Json)?.signed === false && (await retainer(C, tokenC)).status === 404
    );
    await post("/portal/review-decision-link", { ...credential(D, tokenD), action: "accept_case" });
    record("accepted with the agreement still out for signing: 404", (await retainer(D, tokenD)).status === 404);
  } finally {
    if (created.objects.length) await supabase.storage.from(AGREEMENTS_BUCKET).remove(created.objects);
    for (const submissionId of created.submissionIds) {
      await supabase.from("intake_submissions").delete().eq("id", submissionId);
    }
    await supabase.from("claimants").delete().eq("last_name", TEST_MARKER);
    for (const userId of created.userIds) await supabase.auth.admin.deleteUser(userId);
    server.close();
    globalThis.fetch = original;
  }

  const failed = checks.filter(([, passed]) => !passed);
  for (const [label, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) throw new Error(`${failed.length} signed retainer check(s) failed`);
}

main()
  .then(() => {
    console.log("\nPASS: only an accepted link opens the case's own signed retainer");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nFAIL: ${(error as Error).message}`);
    process.exit(1);
  });
