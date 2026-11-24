# AGENTS.md

## Repository Purpose

This is the HAA backend: a Node.js and TypeScript Express API for claimant intake, authentication, provider and lawyer workflows, review access, case status, documents, and notifications.

## Working Rules

- Use TypeScript and preserve the existing Express, route, middleware, service, and type conventions.
- Keep route handlers thin; place reusable logic in `src/lib` or `src/middleware`.
- Keep request validation, authentication, authorization, and tenant or claimant isolation explicit.
- Never read, print, modify, or commit `.env`, `.env.local`, credentials, tokens, private keys, or service-role secrets.
- Make the smallest change that satisfies the task and do not mix unrelated refactors into it.
- Treat database and storage operations as security-sensitive.

## Security and Data

- Use `requireAuth` and existing role checks at protected boundaries.
- Preserve claimant, lawyer, provider, and patient isolation behavior.
- Do not weaken review-link or signed-document access rules.
- Never log tokens, API keys, OTP values, passwords, or sensitive record data.
- Do not use `db:reset` or other destructive scripts unless the task explicitly requires a disposable local/test database.

## Database Changes

- Inspect existing migrations under `supabase/migrations` before schema changes.
- Follow the repository migration conventions and make data-preserving changes when possible.
- Add or update migration safety tests for consequential schema or data transformations.
- Use `npm run db:migrate` only in the intended environment.

## Validation

Run the narrowest relevant check first, then broaden when needed:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- The most specific script in `package.json` for the affected workflow
- `npm run validate:migration` for migration changes

For release-sensitive changes, inspect `package.json`, migration scripts, and deployment workflows before broader validation.
