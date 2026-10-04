# Project Notes — Coraxis Trust (banking app)

## Stack
- React 18 + Vite (rolldown-vite) + TypeScript + Tailwind + shadcn/ui
- Supabase (Auth, Postgres, RLS, Edge Functions, Storage)
- Deploy: Railway via Dockerfile (node:22 build → nginx SPA)

## Build / lint
- `npm install --legacy-peer-deps` (pnpm lockfile present but nixpacks/Dockerfile use npm)
- Build: `npm run build:railway` → `vite build` (package.json `build`/`dev` are intentionally disabled stubs)
- Type check: `npx tsgo -p tsconfig.check.json`
- Lint: `npm run lint`

## Branding
- Single source of truth: `src/config/brand.ts` (name, domain, emails, address, account prefix `CXT`).
- Brand strings are also inlined in `index.html`, `src/components/layouts/*`, `src/pages/*`,
  `public/og-image.svg` and the `send-email` Edge Function templates.

## Auth model
- Supabase Auth email + password. The 4-digit login PIN is the password, stored as `cxt_<pin>`
  (prefix exists only to satisfy Supabase's 6-char minimum).
- Profile auto-created via `handle_new_user` trigger.
- Role gating: `profile.role === 'admin'`. RLS admin policies grant full access.
- Users cannot change their own role (RLS WITH CHECK on profiles).

## Backend
- Migrations `00001`–`00012` in `supabase/migrations`. Apply in order in a new project's SQL Editor.
- `00008` fixes a `profiles` RLS recursion (42P17) — required before profiles can be read.
- `00011` auto-confirms new users; also disable Auth → Providers → Email → "Confirm email".
- Account numbers use the `CXT` prefix (`generate_account_number()`).
- `send-email` Edge Function sends via Resend; it is optional — the app degrades gracefully
  with built-in Secure Mail (`messages` table) when it is not deployed.

## Gotchas
- tsconfig uses `@typescript/native-preview` (tsgo). Use `tsgo`, not `npx tsc`.
- `.rules/check.sh` runs ast-grep rules; `.rules/testBuild.sh` runs a full vite build.
- `public/images/logo/*` assets were removed (they carried a third-party wordmark); the UI
  renders the logo mark with a lucide icon and the brand text from `src/config/brand.ts`.

## Independence
- This repo must never point at another deployment's Supabase project, Railway service,
  database, SMTP credentials, or Git remote. Configure fresh credentials via `.env` / Railway.

## Self-hosting
- The app requires a Supabase-compatible API (auth + PostgREST + storage), not a bare
  Postgres. Self-hosted Railway deployment: see `selfhost/README.md`.
- Generate `JWT_SECRET` / `ANON_KEY` / `SERVICE_ROLE_KEY` with
  `python3 selfhost/gen-supabase-keys.py`; they must be signed with the same secret.
- `VITE_SUPABASE_URL` is the public gateway (Kong) domain; the anon key goes in
  `VITE_SUPABASE_ANON_KEY`. Both are build-time inlined by Vite.
