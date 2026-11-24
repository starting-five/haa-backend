import "dotenv/config";
import { supabase } from "../lib/supabase";

// Creates the Storage bucket the intake flow uploads evidence into.
//
// This is environment provisioning, not a migration. Buckets are owned by the
// Storage API rather than by SQL, so putting a bucket into a numbered migration
// would mean writing to storage.buckets directly and diverging from what the
// Storage service believes it owns. Migration 004 hardens the grants around
// Storage and deliberately stops short of creating anything.
//
// It exists because a fresh project has no bucket at all, and the failure is
// unhelpful: uploads return 500 from createSignedUploadUrl with nothing saying
// the bucket is missing. Running this once makes the environment work.
//
// Safe to run repeatedly. It never widens access: an existing bucket is only
// inspected, and a public one is reported as a problem rather than quietly used.

/** Evidence uploads, signed agreements, and ambassador profile avatars. */
const BUCKETS = ["submissions", "agreements", "profile-avatars"] as const;

async function provision(BUCKET: string): Promise<void> {
  const { data: existing, error: readError } = await supabase.storage.getBucket(BUCKET);

  if (existing) {
    console.log(`Bucket "${BUCKET}" already exists.`);
    console.log(`  public: ${existing.public}`);

    if (existing.public) {
      // Evidence is medical and legal material. A public bucket would serve it
      // to anyone with the object path and no credentials at all.
      throw new Error(
        `Bucket "${BUCKET}" is PUBLIC. Evidence must not be world-readable. ` +
          "Fix this in the Supabase dashboard; this script will not change an existing bucket."
      );
    }

    console.log("Nothing to do.");
    return;
  }

  // Any error other than "not found" is a real failure — a permissions problem
  // or an unreachable project should not be mistaken for an absent bucket.
  const message = readError?.message ?? "";
  if (readError && !/not.?found/i.test(message)) {
    throw new Error(`Could not inspect bucket "${BUCKET}": ${message}`);
  }

  const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (createError) {
    throw new Error(`Could not create bucket "${BUCKET}": ${createError.message}`);
  }

  console.log(`Created bucket "${BUCKET}" (private).`);
}

async function main(): Promise<void> {
  for (const bucket of BUCKETS) await provision(bucket);
  console.log(
    "\nNo Storage policies are added. Row-level security on storage.objects stays " +
      "default-deny. Evidence uploads are authorized by the per-object signed token " +
      "the backend mints in POST /intake/documents/upload-url; signed agreements are " +
      "written and read only with the service-role key, server-side. Avatar policies " +
      "are managed in migration 012_add_profile_avatar_storage_policies.sql."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Storage provisioning failed: ${(error as Error).message}`);
    process.exit(1);
  });
