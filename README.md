# Coraxis Trust

A premium digital banking platform built with React + Vite + TypeScript + Tailwind CSS + Supabase.

This repository is an independent application. It has its own codebase, its own
Supabase project and its own deployment; it does not share a database, Git
remote, or credentials with any other deployment.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend**: Supabase (Auth, PostgreSQL, Storage, RLS, Edge Functions)
- **Design**: Teal institutional theme, Inter + Manrope fonts

## Features

- 🏦 Full banking UI: accounts, transactions, investments, transfers
- 💵 Deposit & Withdraw funds with balance guards
- 💳 Debit card ordering (user requests, admin approves/rejects)
- ⚙️ Admin portal: overview, users, KYC queue, transactions, card requests, add balance
- 🔐 Email + 4-digit PIN authentication (Supabase Auth)
- 📊 Dashboard: overview, deposit/withdraw, transfer, debit card, transactions, investments, profile
- 🌐 Public pages: home, all service pages, contact, investment plans
- 📱 Responsive layout with mobile sheet navigation

## Branding

All user-visible brand strings live in [`src/config/brand.ts`](src/config/brand.ts).
Change the name, domain, contact details or colors there.

## Getting Started

```bash
npm install --legacy-peer-deps
cp .env.example .env   # then fill in your own Supabase project values
npm run build:railway  # vite build
npm run lint
```

`npm run dev` and `npm run build` are intentionally disabled stubs in this
template; use `npm run build:railway` (or `node_modules/.bin/vite build`) and
`npm run lint` instead.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values for **your own** Supabase
project:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

The optional `send-email` Edge Function reads `RESEND_API_KEY`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_FROM_NAME`,
`SMTP_FROM_EMAIL` and `SMTP_REPLY_TO` from its own secrets — never from the
frontend bundle.

## Database

SQL migrations live in [`supabase/migrations`](supabase/migrations). Apply them
in order (00001 → 00015) in a **new** Supabase project's SQL Editor. See the
migration headers for details. Key notes:

- `00008` fixes a `profiles` RLS recursion and must be applied before the app
  can read profiles.
- `00010`/`00012` install `admin_delete_user`, which lets an admin delete a
  user without a service-role key.
- `00011` removes email confirmation from the signup flow.
- Run `NOTIFY pgrst, 'reload schema';` after applying migrations.

## Deployment

Deploys on Railway via the `Dockerfile` (node:22 build → nginx SPA). Point a
Railway service at this repository and set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` for the service. `railway.json` and `nixpacks.toml`
describe the build; use a fresh Railway project and its own domain
(`coraxistrust.online`).
