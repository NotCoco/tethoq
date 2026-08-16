# Tethoq web

The public website and account dashboard for Tethoq. It is a standard Next.js App Router project and can run on Vercel or any compatible Node host. It contains no Sites, Vinext, Wrangler, Cloudflare Worker, or platform-specific build layer.

## Local development

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

The marketing site and installer page build without credentials. Authentication controls clearly report that setup is unavailable until the two public Supabase variables are configured.

The checked-in auth pages are not by themselves evidence that a deployment's
login is active. Each installation needs its public variables, database
migration, Supabase Google provider, and exact redirect allowlist configured.
Native phone/Desktop sign-in and account-backed no-QR enrollment are a
separate control-plane milestone; see
[`docs/ACCOUNT_ACCESS.md`](../../docs/ACCOUNT_ACCESS.md).

## Supabase setup

1. Create a Supabase project and run `supabase/migrations/202608120001_initial_tethoq.sql` in the SQL editor or through the Supabase CLI.
2. Copy the project URL and publishable key into `.env.local` and the production host.
3. Enable Email auth. For Google auth, configure a Google OAuth client in Supabase and add the Supabase callback URL shown by its Google provider settings to Google Cloud.
4. Add `http://localhost:3000/auth/callback` and the production `https://your-domain/auth/callback` to Supabase's redirect allow list. Add the exact native deep-link redirect only when the signed phone/Desktop clients implement that callback; do not use a broad production wildcard.
5. Set `NEXT_PUBLIC_SITE_URL` to the canonical production origin.

No service-role key is used by the website. Browser and server requests run as the signed-in user and are constrained by Postgres RLS.

## Installer and deployment

Set `NEXT_PUBLIC_DESKTOP_WINDOWS_DOWNLOAD_URL` and `NEXT_PUBLIC_BRIDGE_WINDOWS_DOWNLOAD_URL` to the direct HTTPS release assets after publishing them. Optional `NEXT_PUBLIC_DESKTOP_CHECKSUM_URL` and `NEXT_PUBLIC_BRIDGE_CHECKSUM_URL` values expose checksum links. A missing or non-HTTPS value leaves only that product&apos;s button disabled, so the site never serves a placeholder artifact. The older `NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL` remains a Bridge-only fallback for existing deployments.

For Vercel, import this repository, set Root Directory to `apps/web`, add the environment variables above, and deploy. No Vercel-specific code or config is required.

## Checks

```powershell
npm run verify
```
