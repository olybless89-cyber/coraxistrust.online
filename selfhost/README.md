# Self-hosting Supabase on Railway for Coraxis Trust

This app talks to Supabase for **auth, Postgres, Row Level Security, storage and
edge functions**. A bare Railway Postgres is not enough — the code never opens a
raw `pg` connection; every call goes through `supabase-js`
(`supabase.from(...)`, `supabase.auth`, `supabase.storage`, `supabase.functions`,
`supabase.rpc`). So the target needs a Supabase-compatible API in front of Postgres.

## Architecture

All services run in one Railway project and talk over the private network. Only
the gateway (Kong) needs a public domain.

```
 browser ──HTTPS──▶ Kong (public domain) ──▶ PostgREST  /rest/v1/    ─┐
                                         ├─▶ GoTrue     /auth/v1/    ├─▶ Postgres (volume)
                                         ├─▶ Storage    /storage/v1/ ─┘
                                         └─▶ Studio     /
```

Services: `supabase/postgres`, `supabase/gotrue`, `postgrest/postgrest`,
`supabase/storage-api`, `supabase/postgres-meta`, `supabase/studio`,
`kong/kong`.

## 1. Deploy the stack

Use Railway's community template and **eject it into your own repo/account**
(Railway recommends ejecting so you own and can edit the config):

- Template: `https://railway.com/deploy/supabase-self-hosted-full-stack`
- Guide: `https://docs.railway.com/guides/supabase`

Eject → deploy. Everything runs in one project with private networking.
Realtime and Edge Functions are **not** in the template (see §7/§8).

## 2. Generate the three secrets

`JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` must be generated **together** —
the two keys are JWTs signed with that secret. Generate them yourself so the
values never leave your machine:

```bash
python3 selfhost/gen-supabase-keys.py > keys.env
```

`keys.env` is gitignored - keep it private, never commit it.

## 3. Set the secrets on every Supabase service

In the Railway project's **shared variables** (applies to all services), set:

```
JWT_SECRET=<from keys.env>
ANON_KEY=<from keys.env>
SERVICE_ROLE_KEY=<from keys.env>
```

A mismatched `JWT_SECRET` between services makes auth fail **silently** — that is
the single most common self-host error. Use shared variables, not per-service
values.

Also set the public URL once the gateway domain exists (§4):

```
SUPABASE_PUBLIC_URL=https://<kong-domain>
API_EXTERNAL_URL=https://<kong-domain>
SITE_URL=https://coraxistrust.online
```

`API_EXTERNAL_URL` is what GoTrue uses to build links; `SITE_URL` is the app's
own origin.

## 4. Expose the gateway

In the Railway project, generate a public domain for the **Kong** service only.
That URL is your `VITE_SUPABASE_URL`. Nothing else should be public.

## 5. Point the frontend at it

Set on the app's Railway service (build-time — Vite inlines `VITE_*`, so
redeploy after changing them):

```
VITE_SUPABASE_URL=https://<kong-domain>
VITE_SUPABASE_ANON_KEY=<ANON_KEY from keys.env>
```

Local dev: same two lines in the repo's `.env`.

## 6. Apply the migrations

Run `supabase/migrations/00001` → `00012` **in order** against the self-hosted
database (Studio's SQL editor, or `psql "$DATABASE_URL" -f ...`). They create the
enums, tables, RLS policies, the `handle_new_user` trigger on `auth.users`, the
`kyc_documents` storage bucket, and the `admin_delete_user` RPC. Finish with:

```sql
NOTIFY pgrst, 'reload schema';
```

## 7. Auth settings (required)

The app assumes signup auto-confirms. In Studio → **Authentication → Providers →
Email**, turn **Confirm email** off (or set `GOTRUE_MAILER_AUTOCONFIRM=true` on
the GoTrue service). Without this, new users are stuck unconfirmed.

Emails: GoTrue sends its own auth mails via SMTP. To enable them set
`GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`, `GOTRUE_SMTP_PASS`,
`GOTRUE_SMTP_SENDER_NAME`. Optional — with confirmation disabled, the app's own
email is handled separately (§8) and login does not depend on mail.

## 8. Edge Functions (optional)

The `send-email` function is invoked non-blockingly and **failure is tolerated**,
so the app works without it. To add it, deploy Supabase Edge Functions
(an `edge-functions` service) and set as its secrets:

```
RESEND_API_KEY=
SUPABASE_URL=https://<kong-domain>
SUPABASE_SERVICE_ROLE_KEY=<from keys.env>
SMTP_FROM_NAME=Coraxis Trust
SMTP_FROM_EMAIL=noreply@coraxistrust.online
SMTP_REPLY_TO=support@coraxistrust.online
```

## 9. Verify

1. `GET https://<kong-domain>/rest/v1/` → JSON (PostgREST up).
2. `GET https://<kong-domain>/auth/v1/health` → healthy (GoTrue up).
3. Register a user in the app → row appears in `auth.users` + `public.profiles`.
4. Upload a KYC doc → object lands in the `kyc_documents` bucket.
5. Log in with the PIN → dashboard loads (RLS satisfied).

## Pitfalls

- **Key mismatch**: regenerate `JWT_SECRET` only together with both keys.
- **Startup order**: GoTrue/PostgREST may restart once or twice until Postgres
  finishes initialising — Railway's restart policy handles it.
- **Volumes**: keep Postgres and Storage on persistent volumes; without them a
  redeploy wipes data.
- **CORS**: requests come from `https://coraxistrust.online`; Kong's CORS plugin
  must allow that origin.
- **Image transform**: disabled on the Railway template (needs a shared volume
  Railway does not support). Not used by this app.
- **Backups**: self-hosting means you own them. Schedule `pg_dump`.

## 10. Deployed instance (coraxistrust.online)

Provisioned with the Railway CLI using the `supabase-self-hosted-full-stack`
template in its own project (`coraxistrust-supabase`), separate from any source
infrastructure.

| Piece | Value |
|---|---|
| Railway project | `coraxistrust-supabase` (production env) |
| Gateway (Kong) | `https://kong-production-f62f.up.railway.app` |
| Web app service | `web` — repo `olybless89-cyber/coraxistrust.online` |
| Web URL | `https://web-production-e23f.up.railway.app` |
| Custom domain | `https://coraxistrust.online` (attached to `web`) |
| Web build vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

Secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`) were generated locally
with `gen-supabase-keys.py` and set only as Railway service variables — they are
not in this repository.

### Database

The `supabase/migrations/*.sql` files were applied in order to the stack's
Postgres (13 tables, RLS enabled, `on_auth_user_created` trigger, and the
`kyc_documents` storage bucket). The public TCP proxy used for the one-off
migration run was deleted afterwards, so Postgres is reachable only over
Railway's private network.

A bootstrap admin is created by `00004_create_admin_user_v2.sql`:
`admin@coraxistrust.online` with login PIN `1234` (password `cxt_1234`).
Change the PIN after first sign-in.

### DNS to finish

Attach these records at the `coraxistrust.online` registrar so the custom domain
verifies and gets a certificate:

```
CNAME   @                 omyg4tub.up.railway.app
TXT     _railway-verify   railway-verify=23f58833b42fc5dbab6f002e50ab607de4b4ae0eabc8a1fbc4e9098a580b8795
```

Until then the app is served from the Railway URL above. Verify with
`railway domain status coraxistrust.online --service web`.
