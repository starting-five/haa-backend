# haa-backend

Backend API for the HAA (Help After Accident) platform. Handles intake form submissions, stores data to Supabase, and serves as the integration layer between the frontend and the database.

## Tech Stack

- **Node.js** + **TypeScript**
- **Express** — HTTP server
- **Supabase** — PostgreSQL database (via service role client)
- **pg** — direct Postgres connection for migrations

## Project Structure

```
src/
  lib/supabase.ts       — Supabase service-role client
  lib/twilio.ts         — Twilio API sender (server-side)
  lib/case-notifications.ts — case event notification logger/sender (currently intake_started)
  middleware/auth.ts     — requireAuth: verifies a Bearer JWT, attaches req.user
  routes/
    intake.ts            — POST /intake/registration-status, POST /intake/start, POST /intake/documents/upload-url, POST /intake/complete
    agreements.ts        — POST /intake/agreement, GET /intake/agreement/:submissionId
    dev-auth.ts          — POST /intake/verify-otp (development only, see below)
    case.ts              — GET /case/:submissionId, POST /case/:submissionId, GET /case/:submissionId/documents/:documentId (Case Summary)
    portal.ts            — GET /portal/submissions, POST /portal/lawyer/profile, POST /portal/review-decision (all requireAuth;
                           submissions and review-decision also require admin_users)
                           POST /portal/review-access/verify, /portal/review-case, /portal/review-document,
                           /portal/review-retainer, /portal/review-decision-link (the review link's token, no session)
  lib/lawyer-review.ts   — what a review link may see of a case, per assignment state
  lib/patient-identity.ts — resolves which claimant and submission a session may act on
  lib/case-summary.ts    — what Case Summary's Save may change; refuses email and phone
  lib/location-columns.ts — LocationDetails ↔ the incident_/residence_/treatment_area_ columns
  types/intake.ts       — shared TypeScript types
  lib/build-info.ts     — what this build is: version, commit, environment
  scripts/
    migrate.ts          — creates database tables
    reset.ts            — drops and recreates all tables (dev only)
    test-version.ts     — proves GET /version and the version derivation
  app.ts                — Express app setup, GET /health and GET /version
  server.ts             — starts the server
supabase/
  migrations/
    001_create_intake_tables.sql
    ...
    017_create_review_workflow_tables.sql
    ...
    021_create_case_notifications.sql
```

## Setup

**Prerequisites**
- Node.js 26.11.1 (the version in `.nvmrc`, used by CI and the Docker image)
- A Supabase project with tables created (run `npm run db:migrate`)

> **Note:** TypeScript is pinned to 5.8.x for compatibility with `typescript-eslint` in CI. TypeScript 7 cannot be used for linting until `typescript-eslint` adds support for the TS 7 compiler API.

**1. Install dependencies**
```bash
npm install
```

**2. Configure environment**
```bash
cp .env.example .env
```
Fill in all values in `.env` — see `.env.example` for where to find each key.

For intake-start SMS notifications, also set:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (E.164, for example `+14075551234`)
- `INTAKE_ADMIN_NOTIFICATION_TO` (comma-separated E.164 recipients for `intake_started` and `intake_submitted`)
- `INTAKE_LAWYER_NOTIFICATION_TO` (comma-separated E.164 recipients for `attorney_review_ready`)

**3. Create database tables**
```bash
npm run db:migrate
```

**4. Provision Storage buckets**
```bash
npm run db:provision-storage
```

**5. Start the server**
```bash
npm run dev              # development (hot reload)
npm run build            # compile TypeScript
npm start                # production (requires npm run build first)
npm run lint             # ESLint
npm run format           # Prettier
npm run db:migrate       # apply only pending migrations (safe, tracked, transactional)
npm run db:reset         # local development/test databases only (destructive)
npm run db:provision-storage # create required private storage buckets
npm run db:approve-lawyer <email>  # approve a lawyer email for portal sign-up
```

## Docker

Build the image (compiles TypeScript internally via `npm run build`):

```bash
docker build -t haa-backend .
```

Run the container (pass your `.env` values):

```bash
docker run -p 4000:4000 --env-file .env haa-backend
```

Or use the root-level `docker-compose.yml` to run both services together:

```bash
# From GoMAXPAIN-Software/
docker compose up -d --build
```

## Versioning and deployment traceability

Every image answers three questions without a database lookup: which release it is, which commit it
was built from, and which environment it is running in.

### Version format

The public version is the `version` field of `package.json`, exactly as written:
`MAJOR.MINOR.PATCH-rcN` for a release candidate, `MAJOR.MINOR.PATCH-beta` for the public beta, and
`MAJOR.MINOR.PATCH` for a release — `0.1.0-rc8`, then `0.1.0-rc9`, `0.1.0-rc10`, the public beta `0.1.0-beta`,
and eventually `0.1.0`. It is what `GET /version` reports, and it is the same for every
build of a release candidate. The environment is deliberately **not** part of it: one immutable image is
promoted from alpha to beta to production carrying the same version and commit.

```bash
npm run version:print      # the public version, e.g. 0.1.0-rc8
npm run version:build-tag  # the internal build tag, e.g. 0.1.0-rc8.95
```

To cut the next release candidate, change `version` in `package.json` (rc8 → rc9) in its own commit,
together with the root `version` in `package-lock.json`. `HAA_APP_VERSION` overrides it for a build that
has to be labelled by hand, and is held to the same format. The candidate is written `rcN` without a
dot; semver compares that as text (rc10 sorts before rc9, and beta before rc10), and nothing in this pipeline sorts
versions.

The **build number** is internal and is never part of the public version. It counts commits from the
one that set the current version up to the commit being built, so the bump commit is build 1 and the
count restarts with every release candidate. Nobody edits it, and two people building the same commit
get the same answer. CI tags each image with its commit SHA and with the build tag
`<version>.<build number>`, and records the build tag as the image label
`com.helpafteraccident.build-tag`, so an image always traces to one commit. Deriving the number needs
full history, so CI checks out with `fetch-depth: 0`; a shallow clone fails loudly unless
`HAA_BUILD_NUMBER` is set.

**haa-frontend versions independently.** Both repositories use this scheme, each with its own
`package.json` version and its own build count. They are on the same release candidate today, but a
deployment is described by both endpoints together, never by one number.

### Build metadata

Supplied to `docker build` and frozen into the image — the container never runs git and never needs
the repository:

| Build argument | Runtime variable | Example |
|---|---|---|
| `APP_VERSION` | `HAA_APP_VERSION` | `0.1.0-rc8` |
| `GIT_SHA` | `HAA_GIT_SHA` | `231ff968…` (40 hex) |
| `BUILD_ID` | `HAA_BUILD_ID` | `gha-17482912-1` |
| `BUILT_AT` | `HAA_BUILT_AT` | `2026-09-22T09:15:00Z` |

### Deployment configuration

Set where the container runs, never at build time:

| Variable | Values |
|---|---|
| `HAA_ENVIRONMENT` | `local`, `alpha`, `beta`, `staging`, `production` |
| `HAA_IMAGE_DIGEST` | the ECR digest the container was started from (optional) |

`.github/workflows/deploy-ecr.yml` writes `HAA_ENVIRONMENT` into the rendered ECS task definition
from the environment chosen for the run. Hosts that run the container directly (Alpha, Beta) set it
in `/opt/haa/secrets/backend.env`.

### ECR tags

Each build pushes the **same image** under two tags, and neither is `latest`:

```
haa-backend:0.1.0-rc8.95                                 # how a human asks for it (build tag)
haa-backend:231ff968d2de03db6895122e52a9388b6efb834f     # source traceability, used by deployments
```

The digest (`sha256:…`) is resolved after the push and recorded in the workflow summary, so version,
commit and digest are readable together without querying the registry. Deployments reference the
digest or the SHA tag; the version tag is a convenience, not the deployment identity.

### Reading a deployment

```bash
curl -s https://haaaaaaaa.com/api/backend/version              # alpha
curl -s https://beta.helpafteraccident.com/api/backend/version # beta
```

The running environment is the source of truth. The newest image in ECR is not necessarily the one
deployed anywhere.

## Authorization

Every route that reads or writes one patient's case requires `Authorization: Bearer <supabase-jwt>`,
verified by `requireAuth` (`src/middleware/auth.ts`).

A submission id identifies a case; it never authorizes access to one. Each protected handler resolves
the caller's own claimant from `JWT.sub` and confirms the submission belongs to it before doing
anything, so a valid session for one patient reaches nothing belonging to another. `src/lib/patient-identity.ts`
holds that logic and documents the chain. A submission the caller does not own answers exactly like one
that does not exist — `404 submission_not_found` — because distinguishing the two would confirm another
patient's case exists.

| Route | Session required |
|---|---|
| `GET /health` | no |
| `POST /intake/verify-otp` | no — it issues the session (development builds only) |
| `POST /intake/registration-status` | no — it runs before a session exists |
| `POST /intake/start` | yes |
| `POST /intake/documents/upload-url` | yes |
| `POST /intake/agreement` | yes |
| `GET /intake/agreement/:submissionId` | yes |
| `GET /patient/dashboard` | yes |
| `GET /portal/submissions` | yes (admins: `admin_users`) |
| `POST /portal/lawyer/profile` | yes (lawyers) |
| `POST /portal/review-decision` | yes (admins: `admin_users`) |
| `POST /portal/review-access/verify` | no — the review link's token |
| `POST /portal/review-case` | no — the review link's token |
| `POST /portal/review-document` | no — the review link's token |
| `POST /portal/review-retainer` | no — the review link's token |
| `POST /portal/review-decision-link` | no — the review link's token |
| `POST /intake/complete` | yes |
| `GET /case/:submissionId` | yes |
| `POST /case/:submissionId` | yes |
| `GET /case/:submissionId/documents/:documentId` | yes |

`GET /case/:submissionId` is patient-owned rather than a public status page: it carries the patient's
name, phone, email and where and how they were hurt. `POST /case/:submissionId` resolves ownership the
same way before it reads the body, so another patient's case answers `404` whether the edit is valid or not.

`POST /intake/complete` rewrites the claimant, the accident and the submission's status in one pass, so
ownership is settled before the first write. Evidence metadata is checked too — a `documents` entry whose
`storagePath` falls outside the caller's own submission is refused with `403 document_outside_submission`,
so a case cannot be made to carry another patient's evidence.

### Two actors, one session type

Patients and lawyers authenticate through the same Supabase project into the same `auth.users` table, so
`requireAuth` alone cannot tell them apart. Until Phase 2E a patient's session satisfied the portal routes
and read every patient's name, phone, email and address.

`denyPatientSession` (`src/middleware/portal.ts`) closes the half of this the data model can decide on its
own: a caller who owns a claimant is a patient, and a patient is never a portal actor.

**It does not establish that a caller is a lawyer.** `lawyers` rows are self-served by
`POST /portal/lawyer/profile`, so membership grants nothing. The two routes that read or decide on every
patient's case — `GET /portal/submissions` and `POST /portal/review-decision` — therefore also require
the caller to be in `admin_users` (`requireAdminUser`), the table the Admin Dashboard's own database
access is scoped by; anyone else gets `403 admin_only`. Lawyers reach a case only through a review link
(see "Lawyer case review"). A real lawyer actor model — an approval flow, or a role claim in the JWT —
is still an open product decision.

## API Endpoints

### `GET /health`
Returns server status.

### `GET /version`
Which build is running here, and where. No authentication, no database query, no git: the version and
commit are baked into the image at build time and the environment comes from deployment configuration,
so the answer is safe to expose and cannot drift from the artefact.

**Response:**

```json
{
  "application": "haa-backend",
  "version": "0.1.0-rc8",
  "gitSha": "231ff968d2de03db6895122e52a9388b6efb834f",
  "environment": "alpha",
  "buildId": "gha-17482912-1",
  "builtAt": "2026-09-22T09:15:00.000Z",
  "imageDigest": "sha256:…"
}
```

`buildId`, `builtAt` and `imageDigest` are present only when the deployment supplied them. Anything
absent or malformed reads as `"unknown"` rather than being echoed back — see
[Versioning](#versioning-and-deployment-traceability).

### `POST /intake/verify-otp`
**Development builds only.** Mounted solely when `DEV_OTP_BRIDGE=enabled` and `NODE_ENV` is not
`production`; in production the route does not exist. It checks a fixed development code server-side and
returns a real Supabase session for the phone, so the rest of the stack can rely on ordinary
authentication while the production OTP provider is still pending. It is not authentication and must
never be treated as such — `src/lib/dev-auth.ts` explains why at length.

**Request body:** `{ "phone": "+15550001234", "code": "111111" }`

**Response:** `{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }`

**Errors:** `400 missing_phone_or_code`, `400 invalid_phone`, `401 invalid_code`, `502 session_unavailable`.

### `POST /intake/registration-status`
The front door of the new-patient flow, and the only intake route that runs before a session exists.
It answers one question about one phone number: can this person already sign in?

- **`existing`** — a claimant holds this number *and* has at least one submitted case, whatever stage
  it has reached since (`submitted`, `retainer_pending_signature`, `signed`, `attorney`, `qualified`,
  `not_qualified`, `doctor`). The frontend
  stops the flow, sends no verification code, creates nothing, and offers the patient the login screen.
- **`new`** — anything else, including a claimant whose intake was abandoned before submission.
  Those patients can still sign in nowhere, so sending them to a login would strand them, and letting
  them continue registers nothing twice: `POST /intake/start` resumes the submission they abandoned
  rather than creating another.

The number is normalised before it is compared, so `+14075551234`, `+1 (407) 555-1234` and
`+1 407.555.1234` cannot answer differently.

This is a gate, not the guarantee. `POST /intake/start` resolves the claimant from the verified session
and remains the only thing that decides whether a patient is registered, so a caller who skips this
route or races it gains nothing. Answering it does confirm to an unauthenticated caller that a number
belongs to a patient — that is the cost of telling a real patient why they were stopped, and the reason
the response carries that single bit and no name, email, case or identifier.

**Request body:** `{ "phone": "+15550001234" }`

**Response:** `{ "status": "new" }` or `{ "status": "existing" }`

**Errors:** `400 invalid_phone`, `500 registration_lookup_failed`.

### `POST /intake/start`
Called right after verification, with everything the claimant has entered so far. **Requires a session.**
The claimant is resolved from the verified user, never from the request body:

- **The caller has a claimant with a submitted case** (or one whose case has moved past intake) → returns `{ "existing": true }` immediately, no writes. The frontend treats this as a returning patient and sends them to their dashboard. Whether one patient may hold several cases is an open product decision.
- **The caller has a claimant whose intake was abandoned before submission** → resumes that `intake` submission instead of creating another; it does not need an accident row, because the case is opened at verification and the accident arrives later. The route first re-claims the submission only while it is still in intake, so a start that overlaps `POST /intake/complete` is answered `{ "existing": true }` rather than rewriting a case that has just been submitted. It then updates the claimant's name, email and preferred language, the submission's locale and, when one is sent, the accident, and returns `200 { "existing": false, "submissionId": "uuid" }` with the existing id.
- **The caller has a claimant but no submission at all** → the claimant's details are refreshed from this request and a case is opened exactly as for a new claimant. This is what a first start leaves behind when it creates the claimant and then fails to open the case. It used to be answered `{ "existing": true }`, which sent the patient to attorney matching with no case behind it, on every retry.
- **No claimant yet** → creates the claimant with `user_id` set to the verified user and an `intake_submissions` row (`status: "intake"`), then returns `201 { "existing": false, "submissionId": "uuid" }`.

The accident is optional. A call without one opens or resumes the case and writes no accident; a call with a complete one (type and location) writes it, updating the existing row rather than adding a second. A half-answered accident is treated as none.

Concurrent starts for one patient end with one claimant and one case. `claimants.user_id` and `claimants.mobile` are unique, so one claimant insert wins and the loser re-reads the winner's row. Migration 016 allows one `intake` submission per claimant, so when two starts both find no case and both try to open one, the later insert is refused and that request returns the case the earlier one opened (`200`) — never a second one.

A claimant that predates authentication is adopted by matching phone, but only while it is still unowned.
One already owned by a different user is refused rather than reassigned.

The `mobile` in the body is intake data, not identity. It must match the phone in the session; a
disagreement is refused instead of being resolved in the caller's favour.

**Errors:** `401` (no or invalid session), `403 phone_mismatch`, `403 claimant_owned_by_another_user`.

### Case SMS notifications

The backend emits case notification events and attempts Twilio SMS delivery on key state transitions:

- `intake_started` when `POST /intake/start` successfully opens or resumes a submission
- `intake_submitted` when `POST /intake/complete` successfully marks a submission `submitted`
- `patient_intake_started` when `POST /intake/start` succeeds (patient-facing onboarding reminder SMS)
- `patient_intake_submitted` when `POST /intake/complete` succeeds (patient-facing case-ready update SMS)
- `patient_retainer_ready` when `POST /portal/review-decision` is called with `approve_for_retainer`
  (patient-facing retainer-ready notification with a dashboard link)
- `retainer_signed` when the case moves from `retainer_pending_signature` to `signed`: the moment the backend confirms
  with DocuSign that the patient's envelope is completed, during `POST /intake/agreement` or
  `GET /intake/agreement/:submissionId`. The message tells the admins the case is ready for review and links the
  Admin Dashboard; it names no one. Approving the retainer, creating the envelope, opening the signing page, an
  envelope still out for signing and dashboard reads send nothing.
- `attorney_review_ready` when a case is handed to a lawyer: automatically, straight after `retainer_signed`, or by
  `POST /portal/review-decision` with `pass_to_lawyer` (see [Lawyer case review](#lawyer-case-review)). It carries the
  lawyer's review link and names no one. After an automatic handoff this message is the only place the link exists.
- `ambassador_patient_onboarded` when `POST /intake/complete` succeeds for a patient who came in through a brand
  ambassador's referral link: to that ambassador, linking their dashboard (`FRONTEND_URL` + `/en/ambassadors/dashboard`)
  and naming no one. Always enabled when Twilio is configured and a valid referral/recipient is resolved — see
  [Ambassador texts are always enabled](#ambassador-texts-are-always-enabled).

Recipients are configured by event:

- `INTAKE_ADMIN_NOTIFICATION_TO` for admin intake events and `retainer_signed`
- `INTAKE_LAWYER_NOTIFICATION_TO` for `attorney_review_ready`
- the claimant's verified mobile (from the authenticated intake session) for patient-facing
  `patient_intake_started` and `patient_intake_submitted` confirmations
- claimant mobile resolved server-side in `review-decision` for `patient_retainer_ready`

- Delivery is non-blocking for intake flow (case creation still succeeds even if SMS fails).
- Sends are idempotent per `(submission_id, event_type, channel, recipient)` when status is `sent`.
- `retainer_signed` is sent once per case even under retries and concurrent reconciliations: the status update is
  conditional on `retainer_pending_signature`, so only the request that actually makes the case `signed` notifies. A
  failed send is recorded as `failed` and is not retried; the case still goes on to the lawyer.
- `attorney_review_ready` is sent once per handoff: only the request that creates the case's review assignment and
  moves it from `signed` to `attorney` sends it, so repeated or concurrent completions and admin clicks send nothing
  more. A failed send is recorded as `failed` and is not retried; the case stays with the lawyer.
- `patient_retainer_ready` is sent only after `approve_for_retainer` has moved the case to `retainer_pending_signature`;
  a refused or repeated approval sends nothing. The three patient texts go to the claimant's own number only, never to
  the admin or lawyer lists; `test:case-notifications` (run in CI against a local Supabase stack) checks each by the
  number it was sent to.

**Patient texts are always enabled.** These are the case-update texts sent to patients beyond the one-time
verification code. There is no runtime environment toggle for them; when Twilio is configured and a valid
recipient exists, delivery is attempted.

Known gaps to track:

- **Consent and messaging compliance.** `intake_submissions.communication_consent` defaults to `true` and nothing sets
  or reads it, and the phone screen's disclosure mentions only a verification code. Whether the current disclosure
  covers case-update texts, and whether the Twilio sender's registered (A2P 10DLC) campaign covers these message
  types, needs legal/compliance confirmation. That confirmation has not been obtained.
- **Language.** All three patient messages are English, whatever the case's locale; only the dashboard link follows
  it.
- **Phone source.** `patient_intake_submitted` is addressed to the session's phone (`req.user.phone`); the other two
  use `claimants.mobile`. They agree today — `/intake/start` refuses a claimant mobile that differs from the verified
  phone — but they should come from one place.
- Delivery attempts are logged in `case_notifications` for audit and troubleshooting.

`test:case-notifications` covers patient-event delivery and idempotency through the intake and retainer flow.

### Ambassador texts are always enabled

`ambassador_patient_onboarded` tells a brand ambassador that a patient who came in through their link has submitted
their intake:

> HelpAfterAccident: A new patient just onboarded using your link, visit your dashboard at
> <FRONTEND_URL>/en/ambassadors/dashboard for more details. Reply STOP to opt out.

**When.** Only after `POST /intake/complete` has stored the intake as `submitted` — never when a referral link is
opened or an intake is started. It is not awaited: a failed lookup or send never touches the submitted intake.

**Who.** The referral provider's own attribution decides, never anything in the request. At verification the
frontend records the patient as a Dub lead with the submission id as its external id (`/api/intake/dub-lead`), and
the browser's attribution cookies are cleared. At completion the backend asks Dub for that customer
(`GET /customers?externalId=<submissionId>&includeExpandedFields=true`, `lib/referrals.ts`
`findReferralForSubmission`), matches its `link.id` to exactly one `ambassador_profiles.provider_link_id` (or, with
no link, its `partner.id` to `provider_partner_id`), and texts that ambassador's verified sign-in phone
(`auth.users.phone`). Nothing is sent when Dub has no referral for the submission, when no single ambassador
matches, when the ambassador has no phone, when the patient was referred through their own link, or when Dub cannot
be reached; the log says which (`ambassador onboarded notification skipped`, with a reason and no personal data).

**Once.** The text goes through `notifyCaseEvent`, so it is sent at most once per submission and ambassador: a
repeated `/intake/complete` (a submitted case may complete again) finds it already `sent` in
`case_notifications` and sends nothing more. A failed send is recorded as `failed`; nothing retries it, but a later
completion of the same intake tries once more, as for every case notification.

**Setting.** There is no runtime toggle for ambassador texts. Delivery is attempted whenever Twilio is configured and
the referral lookup resolves one eligible ambassador recipient. It needs `DUB_API_KEY`. Patient, admin and lawyer
texts follow their own recipient rules.

**Opt-out and consent.** The backend has no inbound SMS webhook and stores no SMS consent or opt-out for
ambassadors. STOP is handled by Twilio's default opt-out for the sending number: a send to a number that has replied
STOP is refused by Twilio (error 21610) and recorded as `failed`. Whether ambassadors have consented to
these texts, and whether the sender's registered A2P 10DLC campaign covers them, is not established here.

`test:case-notifications` section J covers it: the referred ambassador texted once at submission (not at start)
with the dashboard link; no text without a referral, for an unknown link, for a self-referral, when Dub is down, or
for a repeated completion sending nothing more; and a Twilio failure or
an opted-out number recorded as failed while the intake stays submitted.

**Request body:**
```json
{
  "locale": "en",
  "claimant": {
    "firstName": "John",
    "lastName": "Doe",
    "mobile": "+15550001234",
    "email": "john@example.com"
  },
  "accident": {
    "incidentType": "motor-vehicle-accident",
    "incidentLocation": "Los Angeles, CA"
  }
}
```

### `POST /intake/documents/upload-url`
**Requires a session.** Issues a short-lived token for one evidence file. The `submissions` bucket is private and has no anonymous policy, so the browser cannot upload on its own; it calls this first, then uploads the bytes straight to Storage with the token. Files never pass through this API.

**Request body:**
```json
{
  "submissionId": "uuid",
  "fileName": "accident report scan.png",
  "category": "accidentReport"
}
```

Ownership is settled before the token is minted, not after: a signed upload URL is a capability, and one
must not exist for a submission the caller does not own.

Each call mints a **new** object key — a short random token is inserted before the extension — and the
token is issued with `upsert: false`. Two files sharing a name (phones produce `IMG_0001.jpg` constantly)
therefore land on separate objects instead of the second silently replacing the first, and a retry writes
to a fresh key rather than needing permission to overwrite. Store the returned `storagePath`; it is not
the name the caller sent.

The object key is built from the submission the server verified, so nothing the caller sends can steer it.
`fileName` is sanitised — any directory component is dropped and characters outside `A-Za-z0-9._-` become
`_` — and `category` is sanitised the same way, defaulting to `uncategorized`. A `storagePath` in the
request body is ignored. Store the returned `storagePath` rather than rebuilding it, since the name may
have changed.

**Errors:** `400 Missing submissionId or fileName`, `400 Invalid fileName`, `401` (no or invalid session), `404 Submission not found`.

**Response:**
```json
{
  "bucket": "submissions",
  "storagePath": "uuid/accidentReport/accident_report_scan.png",
  "token": "..."
}
```

**Errors:** `400` missing `submissionId`/`fileName` or an unusable name, `404` unknown submission.

### `POST /intake/complete`
Called after "My treatment location", for first-time claimants only. Fills in everything gathered since `/start` and marks the submission `submitted`.

**Request body:**
```json
{
  "submissionId": "uuid",
  "claimant": {
    "residence": "Los Angeles, CA 90001"
  },
  "accident": {
    "role": "driver",
    "description": "..."
  },
  "treatmentArea": "Los Angeles, CA 90001",
  "companions": [
    {
      "firstName": "Jane",
      "lastName": "Doe",
      "relation": "passenger",
      "cellNumber": "+15550001111",
      "email": "jane@example.com"
    }
  ],
  "documents": [
    {
      "fileName": "photo.jpg",
      "storagePath": "uuid/accidentReport/photo.jpg",
      "mimeType": "image/jpeg",
      "fileSize": 204800
    }
  ]
}
```

**Response:** `{ "submissionId": "uuid" }`

A case can be completed while it is in intake and again while it waits for review, which is what a
retried submit does. Once the Admin Dashboard has decided on it — accepted, turned down, or later — it is
refused with `409 case_already_reviewed` and nothing is written: completing it again would put it back in
review and rewrite the facts the decision, and any signed retainer, rest on.

**Errors:** `400 Missing submissionId`, `401` (no or invalid session), `403 document_outside_submission`,
`404 Submission not found`, `409 case_already_reviewed`.

### `GET /case/:submissionId`
The patient's own case, as the Case Summary screen shows it. Requires the patient's session; a case
belonging to anyone else answers `404 Case not found`, exactly like one that does not exist.

**Response:**
```json
{
  "submissionId": "uuid",
  "status": "submitted",
  "submittedAt": "2026-08-12T00:00:00Z",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+15551234567",
  "email": "john@example.com",
  "incidentType": "car",
  "incidentDate": "2026-08-10",
  "incidentLocation": "Los Angeles, CA, USA",
  "incidentLocationDetails": { "text": "Los Angeles, CA, USA", "placeId": "…", "city": "Los Angeles", "state": "CA", "source": "autosuggest", "precision": "city_estimate" },
  "role": "driver",
  "injuries": "back,neck",
  "treatmentArea": "Los Angeles, CA 90012",
  "treatmentAreaLocationDetails": null,
  "companions": [{ "id": "uuid", "firstName": "Ana", "lastName": "Doe", "relation": "passenger", "cellNumber": "(555) 123-4568", "email": null }],
  "documents": [{ "id": "uuid", "fileName": "police-report.pdf", "mimeType": "application/pdf", "category": "police-report" }],
  "editable": true
}
```

- `incidentType`, `incidentLocation` are `""` and the accident fields `null` while the accident screens
  are unanswered; a case is opened at verification and the accident arrives later.
- `*LocationDetails` is `null` for a place stored without them (typed by hand, or before migration 008).
- Companions carry their id and the cell number and email the patient gave for them, so Case Summary can
  edit them. They are returned only to the patient who owns the case.
- `editable` is `canEditCaseSummary(status)` (`lib/case-status.ts`): `true` for every submitted case,
  whatever its stage; `false` for an intake that was never submitted.

### `POST /case/:submissionId`
Case Summary's Save. The patient corrects their own case.

**Edit policy.** Every submitted case can be changed, at every stage — `submitted`,
`retainer_pending_signature`, `signed`, `attorney`, `qualified`, `not_qualified`, `doctor` (a product
decision of 2026-10-09). An edit after approval or signing changes facts the admin reviewed, the retainer
was issued on and, after the handoff, what the lawyer was given; this route notifies none of them. The
route never writes the case's status, so a save cannot move a case between stages. An intake that was
never submitted is edited through the intake screens and answers `409 case_locked` here.

**The patient's email and phone cannot be changed here.** They are the patient's sign-in identity and
contact; changing either needs its own verified flow. A body that names `email`, `phone` or `mobile` — at
the top level or inside `claimant` or `accident` — is refused with `400 field_not_editable` and nothing is
written. A companion's `cellNumber` and `email` are different: they describe someone else, and the patient
may correct them like any other answer.

**Request body** — every group is optional and replaces what is stored for it; at least one is required:
```json
{
  "claimant": { "firstName": "John", "lastName": "Doe" },
  "accident": {
    "incidentType": "car",
    "incidentDate": "2026-08-10",
    "incidentLocation": "Los Angeles, CA, USA",
    "incidentLocationDetails": { "text": "Los Angeles, CA, USA", "source": "autosuggest", "precision": "city_estimate" },
    "role": "driver"
  },
  "injuries": "back,neck",
  "treatmentArea": "Los Angeles, CA 90012",
  "treatmentAreaLocationDetails": null,
  "companions": [
    { "id": "uuid", "firstName": "Ana", "lastName": "Doe", "relation": "passenger", "cellNumber": "5551234568", "email": null },
    { "firstName": "Luis", "lastName": "", "relation": "driver", "cellNumber": "(555) 123-4569" }
  ],
  "documents": {
    "add": [{ "storagePath": "<submissionId>/insuranceCard/card-1a2b3c4d.jpg", "fileName": "card.jpg", "mimeType": "image/jpeg", "fileSize": 182344, "category": "insuranceCard" }],
    "remove": ["uuid"]
  }
}
```

- `companions` is the whole list as it should now be. An entry with an `id` is that companion, updated;
  one without is added; a stored companion the list leaves out is removed; `[]` removes everyone. Writes
  go insert → update → delete, each scoped to this case, so a failure part-way never loses a companion the
  patient kept. An `id` that is not one of this case's companions is refused before anything is written.
- `documents.add` records files the screen has already uploaded through `POST /intake/documents/upload-url`.
  Each key must be inside this case's own folder (`<submissionId>/<category>/<name>`), must not already be
  recorded, and must exist in Storage — a row is never written for a file that is not there.
  `documents.remove` takes this case's document ids; the row is deleted first, then the stored file, so a
  failed Storage delete leaves an orphaned object, never a listed document without a file.

Values are checked at runtime, unlike the intake routes (`lib/case-summary.ts`):
- keys are allowlisted at every level — anything else (`status`, `submissionId`, …) is `400 unknown_field`;
- names follow the name screen's rule (letters, spaces, hyphens, apostrophes), up to 100 characters —
  `400 invalid_name`;
- `incidentType` and `role` must be values the intake screens offer, and all of `accident` is required
  when it is sent — `400 invalid_accident`;
- `incidentDate` is `YYYY-MM-DD`, a real date, not after tomorrow in UTC (the screen refuses a future date
  in the patient's own timezone) — `400 invalid_incident_date`;
- `injuries` and `treatmentArea` must be non-empty; details without a `treatmentArea` are refused —
  `400 invalid_injuries` / `400 invalid_treatment_area`;
- location details carry only the `LocationDetails` fields with in-range coordinates — `400 invalid_location_details`;
- a companion needs a first name and a relation the intake offers (`passenger`, `driver`, `other`), a
  ten-digit US cell number (a leading `1` is dropped; it is stored as `(555) 123-4567`), and an email only
  if it is a valid one; up to 20 — `400 invalid_companions`;
- a document added is an image or a PDF in one of the four evidence categories, 1 byte to 25 MB; up to 20
  changes per save — `400 invalid_documents`;
- `{}` is `400 no_changes`.

**Responses:** `200` with the updated summary (the `GET` shape) · `400 <code>` as above ·
`401` without a session · `404 Case not found` for a case the caller does not own · `409 case_locked`
for an intake that was never submitted · `500` on a failed write. The writes are sequential like `/intake/complete`'s, so a
failure after the first can leave part of an edit applied; the response says so with a `500`.

### `GET /case/:submissionId/documents/:documentId`
One file of the patient's own case, for Case Summary's thumbnails. The `submissions` bucket has no read
policy, so a patient's session cannot read even its own uploads; this route reads with the service role
after the same ownership check as `GET /case/:submissionId`, and only an object inside the case's own
folder. It is served the way `POST /portal/review-document` serves a lawyer's: an image or a PDF inline
with a type chosen here (never the one the upload claimed), anything else as an `application/octet-stream`
download, with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

**Responses:** `200` with the file · `401` without a session · `404 Document not found` for a case the
caller does not own, a document of another case, or an id that is not a document.

### `POST /intake/agreement`
**Requires a session.** Creates the patient's DocuSign agreement, or returns the one already in play. The patient is the only signer.

Signing follows the Admin Dashboard's approval, not submission. Only a case the admin has approved for
the retainer (`POST /portal/review-decision` with `approve_for_retainer`, which sets
`retainer_pending_signature`) may open a signing session. A case still in review (`submitted`), turned
down (`not_qualified`), already `signed` or at any later stage is refused with `409 case_not_approved`
before any agreement row is written or DocuSign is called. When the agreement completes, the case moves
from `retainer_pending_signature` to `signed` — only from there, so a case the admin never approved cannot
reach `signed` — and is handed straight to a lawyer (`attorney`; see [Lawyer case review](#lawyer-case-review)).
The rule lives in `src/lib/case-status.ts`, and `GET /patient/dashboard` reports it as `awaitingSignature`.

The agreement row is reserved **before** DocuSign is called, so two simultaneous taps contend on the partial unique index rather than both creating an envelope. A request that loses the race reuses the winner; a create that fails marks its reservation `voided`, which frees a retry.

`clientUserId` is the agreement row id, never the submission id. The envelope id and template id never leave the backend.

**Request body:** `{ "submissionId": "uuid" }`

**Response (201 created / 200 reused):**
```json
{
  "status": "sent",
  "signingUrl": "https://demo.docusign.net/signing/..."
}
```

`signingUrl` is single-use and short-lived, and is omitted once `status` is `completed`.

**Errors:** `400 missing_submission_id`, `401` (no or invalid session), `404 submission_not_found`, `409 submission_not_submitted`, `409 case_not_approved`, `409 agreement_in_progress`, `409 date_of_loss_missing`, `500 agreement_not_configured`, `502 envelope_creation_failed`, `502 signing_url_failed`.

A patient is identified by phone and a verification code, and email is optional
throughout intake, so **signing never requires an email address**. DocuSign's
`templateRoles` schema wants one, but an embedded recipient — one carrying a
`clientUserId` — is never mailed: the ceremony is reached through the recipient
view. The address is therefore a recipient key rather than a mailbox, derived
from the agreement row in a domain reserved by RFC 2606 that can never receive
mail. It is server-side only and never reaches the browser.

Ownership is checked before the agreement is reserved, so a request for another patient's submission
creates no reservation, no envelope and no status change.

The retainer is chosen by the patient's own locale: `en` uses `DOCUSIGN_TEMPLATE_ID_EN`, `es` uses `DOCUSIGN_TEMPLATE_ID_ES`, both signed by the `DOCUSIGN_TEMPLATE_ROLE_NAME` role. A missing template for the language a patient needs fails with a named configuration error rather than falling back to a default or the other-language retainer.

The backend fills only the two values it holds, under data labels the templates share. The **date of loss** comes from the reported accident (`accidents.incident_date`), formatted long-form in the patient's language, so the required locked field is never blank; a submission with no date of loss is refused (`409 date_of_loss_missing`) rather than sent as an unsignable document. The **signing date** — the three separate `day / month / 20__` boxes of "DATED this __ day of __, 20__", which a single Date-Signed tab cannot fill — is stamped when the ceremony is opened and re-stamped each time it reopens, so a patient returning on a later day signs a document dated that day. Everything else is left alone: the client name auto-fills from the recipient, signatures and date-signed are the template's own tabs, and every patient choice (SSN, date of birth, authorized contact, initials, guardian) stays blank for the patient to enter during signing — none is collected by HAA or prefilled here.

### `GET /intake/agreement/:submissionId`
**Requires a session.** The authoritative signing status. A non-terminal status is refreshed from DocuSign server-side before the response is sent.

No query parameter is read. DocuSign appends an event to its return URL, but that is a browser-controlled value and is never treated as status.

**Response:** `{ "status": "completed" }` — one of `created`, `sent`, `delivered`, `completed`, `declined`, `voided`. The envelope id is never returned.

**Errors:** `401` (no or invalid session), `404 submission_not_found`, `404 agreement_not_found`, `409 submission_not_submitted`.

The owner can read this at every stage after intake, including once the case has been approved, signed or
passed on; `409 submission_not_submitted` is only for a case still in intake.

When this route observes an envelope reaching `completed` it also fetches the
signed PDF from DocuSign server-side and stores it privately, recording the key
on `agreements.signed_document_path`. That is idempotent: a recorded path
short-circuits it, the object key is derived from the submission and agreement
rather than generated, and the upload refuses to replace an existing object — so
a refresh, a re-opened return URL or two concurrent polls all leave exactly one
document. A completed agreement whose retrieval failed is retried by the next
reconciliation. The path is never returned to the browser.

### `GET /patient/dashboard`
**Requires a session.** The signed-in patient's own cases, newest first, resolved from the session — no
identifier is read from the request. Only submitted cases are returned; a patient with none gets
`409 intake_incomplete`.

Each case carries `agreementStatus` — the stored status of its active agreement (`created`, `sent`,
`delivered` or `completed`), or `null` when there is none — and `awaitingSignature`, which is true when the
case is `retainer_pending_signature` and its agreement is not completed. The frontend sends the patient to the agreement
screen on `awaitingSignature`. `agreementStatus` is not refreshed from DocuSign here;
`GET /intake/agreement/:submissionId` is the authoritative read.

Each case also carries `providers: { lawyer: { matched }, doctor: { matched } }`, worked out in
`src/lib/provider-matches.ts` and nowhere else; the patient app's team cards are drawn from it.
- `lawyer.matched` is true when a lawyer accepted the case through their review link: an `accepted`
  `review_assignments` row with `accepted_at`, not revoked. The link expiring afterwards does not undo it; the case being
  closed `not_qualified` does. The case status alone never makes a match — the Admin Dashboard can set `qualified`
  without a lawyer, and `attorney` only means the case was passed to one.
- `doctor.matched` is always `false`: nothing in the schema records a doctor for a case yet. The two are worked out
  independently, so doctor matching can be added without touching the lawyer rule.

Only the caller's own cases are read, so no other patient's lawyer state can reach the response.

**Errors:** `401` (no or invalid session), `409 intake_incomplete`, `500 identity_lookup_failed`,
`500 dashboard_lookup_failed`.

---

### `GET /portal/submissions`
Returns all submissions with claimant + accident details. Admins only (`admin_users`); any other session gets
`403 admin_only`.

### `POST /portal/lawyer/profile`
Upserts the calling lawyer's profile (`user_id` comes from the verified JWT, not the request body).

**Request body:** `{ firstName?, lastName?, email?, practice?, role? }`

**Response:** `{ status: "ok" }`

### Lawyer case review

A case goes to a lawyer as soon as its retainer is signed. The request that moves it to `signed` — the one that
learns from DocuSign the envelope is completed — hands it on in the same step (`src/lib/lawyer-handoff.ts`): it
mints a review link, `/en/review/<claimantUserId>?submissionId=<submissionId>&t=<token>`, records a pending
`invite_link` assignment and a `pass_to_lawyer` decision event marked `automatic`, sets `attorney`, and sends
the link in `attorney_review_ready`. Nobody has to act. There are no lawyer accounts in this flow; the link is
the lawyer's credential.

A handoff needs the completed agreement's signed PDF in storage; one that cannot be retrieved yet leaves the case
`signed`. So does a case signed before the handoff was automatic — later reads never hand those on. For both, the
Admin Dashboard's `pass_to_lawyer` runs the same handoff and returns the link. However many requests try at once,
one succeeds: the database allows one pending assignment per case and the status moves only from `signed`.
 Only the SHA-256 of the token is stored
(`review_assignments.review_link_token_hash`), and the review routes find the assignment by that hash and
the submission, never by an id the caller names.

#### `POST /portal/review-decision`
The Admin Dashboard's decision on a case. Requires a session whose user is in `admin_users`; anyone else
gets `403 admin_only`, so no other account can mint a review link or decide a case.

**Request body:** `{ claimantUserId, submissionId, action }`, where `action` is `approve_for_retainer`,
`pass_to_lawyer`, `accept_case` or `reject_case`.

- `approve_for_retainer` — only from `submitted`; sets `retainer_pending_signature`, which opens the
  patient's retainer.
- `pass_to_lawyer` — only from `signed`, and only with a completed agreement whose signed PDF is stored
  (retrieved from DocuSign here if it is missing); sets `attorney` and mints the review link. Signing does this
  automatically, so it is for a case that is `signed` but not with a lawyer.
- `accept_case` / `reject_case` — from any status; set `qualified` / `not_qualified`.

A transition from the wrong status is refused with `409 status_transition_not_allowed`
(`{ error, action, fromStatus }`); `pass_to_lawyer` without a completed agreement with
`409 retainer_not_completed`, without its signed PDF with `409 retainer_document_unavailable`, for a case another
request has just handed on with `409 already_passed_to_lawyer`, and `500 retainer_lookup_failed` if the agreement
check cannot be made.

**Response:** `{ ok: true, action, status, submissionId, assignmentId, decisionLogged, reviewLink }`, where
`reviewLink` is set for `pass_to_lawyer`, which creates a pending `invite_link` assignment that expires in
14 days. A submission can hold only one pending assignment.

#### `POST /portal/review-access/verify`
Opens the link. The frontend's `/api/review/unlock-link` calls it, then keeps the token in an HttpOnly
cookie for the review page. Each call counts as one use of the link (`token_max_uses`, 20 by default).

**Request body:** `{ claimantUserId, submissionId, token }`

**Response:** `{ ok: true, assignmentId, submissionId, claimantUserId, status, canDecide, expiresAt, remainingUses }`

**Errors:** `400 invalid_payload`, `404 claimant_not_found` / `submission_not_found`, `401 invalid_token` /
`token_revoked` / `token_expired` / `token_usage_exceeded`.

#### `POST /portal/review-case`
The case as the link may see it. The review page calls it server-side on every render; it is not on the
frontend proxy's allowlist. It does not count as a use of the link.

**Request body:** `{ claimantUserId, submissionId, token }`

**Response** (pending):

```json
{
  "ok": true,
  "access": "masked",
  "review": { "status": "pending", "canDecide": true, "responseDeadline": "2026-10-13T12:00:00.000Z" },
  "caseFacts": {
    "incidentType": "car",
    "role": "driver",
    "injuries": "headNeck,back",
    "story": "A pickup ran the red light… call me at •••",
    "language": "en",
    "companionRelations": ["passenger"],
    "documentCounts": [{ "category": "incidentPhotos", "count": 2 }]
  },
  "patient": null,
  "incident": { "date": "2026-09-28", "location": "Winter Park, FL" },
  "companions": null,
  "documents": [
    {
      "id": "0d9f6a2e-1c3b-4e5d-8f70-9a1b2c3d4e5f",
      "category": "incidentPhotos",
      "fileName": null,
      "mimeType": "image/webp",
      "fileSize": 19354,
      "kind": "image",
      "available": true
    }
  ]
}
```

Before acceptance the link shows what is needed to judge the case — the case facts, the accident's date and
place, and the files, which it can open — and nothing that identifies or reaches the patient:
- `patient` (name, phone, email, residence, treatment area) and `companions` (their names and contact details)
  are `null`; those columns are not selected.
- `fileName` is `null`: patients often name a file after themselves, and the column is not selected.
- The story and injuries have email addresses and phone-length numbers, numeric dates included, replaced with
  `•••`. A date typed into the story may be a birth date, so it stays hidden even though the accident's date is
  shown in `incident`. Names, street names and dates written in words are not detected.

Only an assignment that is `accepted`, with `accepted_at` recorded, not revoked and before `expires_at`,
returns `access: "full"`: `patient` and `companions` are filled, every `fileName` is set, and the story and
injuries are returned as written.

**Files.** `documents` lists every file of the case while the link may open them: while it is pending and
before `expires_at`, and after acceptance. After a rejection, once the link has expired, or for an accepted
status without `accepted_at`, `documents` is `null` and only `caseFacts.documentCounts` remains.
- There is no URL. Each file is fetched by its `id` from `POST /portal/review-document` with the same token, so
  no Storage URL or object path — which is built from the patient's file name — leaves the backend.
- `kind` comes from the content type Storage serves the object as, not the type the upload claimed in the
  documents row; the bucket accepts any type. `image` covers JPEG, PNG, GIF, WebP and BMP and `pdf` covers
  PDFs; both open inline. Everything else is `file` and is only ever a download. That covers HEIC, SVG, HTML,
  unknown types, and a `.pdf` that is really something else.
- `available` is `false` for a row whose object is outside the submission's own folder, or that Storage does
  not hold. Such a file cannot be opened.

| Assignment | `review.status` | `access` | `incident` | `documents` | `canDecide` |
|---|---|---|---|---|---|
| `pending`, before `expires_at` | `pending` | masked | yes | listed, can be opened | `true` |
| `accepted` with `accepted_at`, before `expires_at` | `accepted` | full | yes | listed, can be opened | `false` |
| `accepted` without `accepted_at` | `accepted` | masked | yes | `null` | `false` |
| `rejected` | `rejected` | masked | yes | `null` | `false` |
| any status once `expires_at` has passed, or `expired` | `expired` | masked | yes | `null` | `false` |
| `revoked_at` set, `revoked`, or a status the code does not know | none: `401 token_revoked` | none | none | none | none |

The `storage_path` column and the GPS and place columns are never returned in any state.

**Signed retainer.** `signedRetainer` is `{ signed, available }` in every state, and nothing else: no agreement id,
URL or path. `signed` is whether the case has a completed agreement. `available` is `true` only for an accepted
link (`access: "full"`) when Storage holds the signed PDF at the case's own path; the document itself is fetched
from `POST /portal/review-retainer`. Before acceptance only the agreement's status is selected.

**Errors:**
- `400 invalid_payload`: a missing field, or an id that is not a UUID.
- `401 invalid_token`: no assignment for this submission has the token, or the user id is not the
  submission's claimant.
- `401 token_revoked`.

#### `POST /portal/review-document`
One file of the case, for the frontend's `/api/review/documents/<id>` route to stream to the lawyer. It takes the
same credential as `/portal/review-case` and does not count as a use of the link.

**Request body:** `{ claimantUserId, submissionId, token, documentId }` — nothing else is read. A path, bucket or
second id in the body is ignored.

**Response:** the file's bytes.
- `Content-Type`: the image type for an image, `application/pdf` for a PDF, `application/octet-stream` for
  everything else, whatever Storage holds.
- `Content-Disposition`: `inline` for an image or a PDF, `attachment` for everything else. Before acceptance
  the name is neutral: category and the start of the document id, such as `drivers-license-0d9f6a2e.webp`.
  After acceptance it is the patient's own file name.
- `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.

The document has to be a documents row of this submission, and its object must be inside the submission's own
folder. Access is checked on every request, so a rejection, an expiry or a revocation stops a file opening even on
a page that is already open.

**Errors:**
- `400 invalid_payload`: a missing field, or an id that is not a UUID.
- `401 invalid_token`: no assignment for this submission has the token, or the user id is not the submission's
  claimant.
- `401 token_revoked`.
- `403 documents_unavailable`: the link was rejected, has expired, or is accepted without `accepted_at`.
- `404 document_not_found`: the id is not a file of this case, the row points outside the case's folder, or
  Storage does not hold the object. These are indistinguishable on purpose.

#### `POST /portal/review-retainer`
The patient's signed retainer, for the frontend's `/api/review/retainer` route to stream to a lawyer who has
accepted the case. Same credential as `/portal/review-case`; does not count as a use of the link.

**Request body:** `{ claimantUserId, submissionId, token }` — there is no document id. The retainer is resolved
from the submission's completed agreement and served only from the path it was stored under,
`agreements/<submissionId>/<agreementId>.pdf`. An agreement row naming any other object is not followed, and any
id, path or bucket in the body is ignored.

**Response:** the signed PDF as stored after DocuSign completed it — nothing is written and DocuSign is not called.
`Content-Type: application/pdf`, `Content-Disposition: inline; filename="Signed Retainer.pdf"`,
`X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Bytes that are not a PDF are not served.

**Errors:**
- `400 invalid_payload`: a missing field, or an id that is not a UUID.
- `401 invalid_token`: no assignment for this submission has the token, or the user id is not the submission's
  claimant.
- `401 token_revoked`.
- `403 retainer_unavailable`: the link is pending, rejected, expired, or accepted without `accepted_at`.
- `404 retainer_not_found`: no completed agreement, no stored PDF, or a row that points anywhere but the case's
  own path.

#### `POST /portal/review-decision-link`
The lawyer's accept or reject, from the review page.

**Request body:** `{ claimantUserId, submissionId, token, action }`, where `action` is `accept_case` or
`reject_case`. The assignment is the one the token belongs to; an `assignmentId` in the body is ignored.

**Response:** `{ ok: true, action, status, submissionId, assignmentId, canDecide: false }`, where `status` is
the submission's new status, `qualified` or `not_qualified`. The assignment becomes `accepted` or `rejected`
with its time recorded, and a `review_decision_events` row is written with actor role `lawyer` and
`metadata.source` `review_link`.

**Errors:**
- `400 invalid_payload` or `invalid_action`.
- `404 claimant_not_found` or `submission_not_found`.
- `401 invalid_token`.
- `409 decision_already_submitted`.
- `401 assignment_not_active`: revoked, or past `expires_at`. The update itself checks both again, so a
  decision racing the deadline is refused.

**Known limits:**
- **The story is free text.** Before acceptance, email addresses and phone-length numbers in it are
  replaced with `•••`. A name, a street or a date written in words is still shown. Read the story before
  passing a case on.
- **The deadline is the link's own expiry.** `responseDeadline` is `review_assignments.expires_at`, 14 days
  after pass-to-lawyer. There is no separate response-time rule yet. Once the link expires, the case
  masks again, even after an acceptance.
- **The link is a bearer credential.** Whoever holds it is treated as the lawyer, including anyone it is
  forwarded to.

## Database Schema

Pre-first-release, so schema changes are made directly in `supabase/migrations/001_create_intake_tables.sql` rather than via incremental migrations.

- **`claimants`** — identity, one row per phone number (`mobile` is unique). `user_id` is a nullable FK to `auth.users`, reserved for once real phone OTP auth is wired up on the frontend — always null today.
- **`intake_submissions`** — one row per accident/case; many can belong to the same claimant (`claimant_id`). `status` is `in_progress` until `/intake/complete` sets it to `submitted`. `communication_consent` defaults to `true` and is currently hardcoded (no real consent checkbox on the frontend yet).
- **`accidents`** — incident details per submission (`incident_type`, `incident_location`, `description`, `role`).
- **`submission_companions`** — people who were with the claimant for a submission (name, phone, relation/role, optional email).
- **`documents`** — uploaded file metadata (files live in Supabase Storage).
- **`lawyers`** — profile data linked to `auth.users`, for the lawyer onboarding flow (not yet reachable from the frontend).
- **`agreements`** — one DocuSign envelope per submission (migration 006). `envelope_id` is null while a row is reserved but the envelope has not been created (migration 007). A partial unique index allows at most one agreement per submission that is not `declined` or `voided`.

## Database Scripts

```bash
npm run db:migrate   # apply only pending migrations (safe, tracked, transactional)
npm run db:reset     # local development/test databases only (destructive)
```

> ⚠️ `db:reset` requires `ALLOW_DB_RESET=true` and `NODE_ENV=development|test`.
>
> By default it only allows localhost database URLs. Remote resets are blocked unless you explicitly set:
> - `ALLOW_REMOTE_DB_RESET=true`
> - `RESET_CONFIRM_HOST=<exact DATABASE_URL host>`
>
> Example for a Supabase pooler host:
> - `ALLOW_REMOTE_DB_RESET=true`
> - `RESET_CONFIRM_HOST=aws-0-us-east-2.pooler.supabase.com`

Applied migrations are recorded in `haa_schema_migrations` with their filename and SHA-256 checksum. Deployments take an advisory lock, run only pending migrations in one transaction, and stop on any failure or historical-file checksum mismatch.

> `DATABASE_URL` is only used for migrations (`npm run db:migrate`). The running backend does not need it. For **GitHub Actions**, use the **Session Pooler** URI (Supabase Dashboard → Connect → Session pooler, port 5432). The direct `db.*.supabase.co` host is often IPv6-only and fails on GitHub runners with `ENETUNREACH`.

## Swapping the Database

All database logic is isolated to `src/lib/supabase.ts` and the query calls in `src/routes/`. To replace Supabase with another database, update those files only — the Express server, types, and scripts are database-agnostic.
