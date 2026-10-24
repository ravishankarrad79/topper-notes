# Education Helping

A single-service website and API for a shared PDF library. The Node server serves `index.html`, accepts PDF uploads, and stores metadata plus PDF files either locally for development or in Supabase for durable hosting.

## Run locally

Install Node.js 20 or newer, then in this folder run:

```sh
npm start
```

Open http://localhost:3000. Without Supabase environment variables, local uploads are saved under `storage/` and remain on your computer.

## Keep online uploads after Render restarts

Render Free web services have an ephemeral filesystem, so local uploads disappear on spin-down, restart, or redeploy. Configure Supabase cloud storage before uploading PDFs to the live website:

1. Create a Supabase project.
2. In Supabase **SQL Editor**, run the contents of `supabase-setup.sql`.
3. In Supabase **Storage**, create a **private** bucket named `study-pdfs`.
4. In Render service **Settings → Environment**, add:
   - `SUPABASE_URL`: Supabase project URL.
   - `SUPABASE_SECRET_KEY`: a Supabase secret key (`sb_secret_...`). The server also accepts a legacy service-role key.
   - `SUPABASE_BUCKET`: `study-pdfs` (optional; this is the default).
5. Save changes and wait for Render to deploy. Then upload the PDFs again.

The secret key must stay in Render's environment settings. Never put it in GitHub, this README, or browser code. PDFs are served through the backend so the Storage bucket can remain private. If cloud storage is not configured on Render, uploads are blocked with an explanatory message instead of being saved temporarily.

Supabase Free currently includes 1 GB file storage, but may pause a low-activity project after a week. No free hosting plan guarantees permanent availability; keep a separate copy of original PDFs. [Supabase plan limits](https://supabase.com/docs/guides/platform/billing-on-supabase) and [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

The website requires this Node server; opening `index.html` directly or deploying as a static-only site will not enable shared uploads. Uploads require the admin password configured on the server. The sample cards are examples, and checkout for paid documents is still a demo.

## Admin password

Set `ADMIN_PASSWORD` in Render's service environment settings. Do not put the real password in source files or GitHub.
