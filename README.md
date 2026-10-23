# Topper Notes

A single-service website and API for a shared PDF library. The Node server serves `index.html`, accepts PDF uploads, and stores the PDF files plus metadata in `STORAGE_DIR`.

## Run locally

Install Node.js 20 or newer, then in this folder run:

```sh
npm start
```

No `npm install` is needed; the server uses Node.js built-in modules.

Open http://localhost:3000. Uploads are saved under `storage/` and persist between restarts on your computer.

## Publish online with persistent uploads

This project includes `render.yaml` for Render. Push this folder to a GitHub repository, then in Render choose **New → Blueprint**, connect the repository, review the service and persistent disk configuration, and deploy. The disk stores the uploaded PDFs across deploys. Use the generated `*.onrender.com` link to open the site.

The website needs to be served by this Node server; opening `index.html` directly or deploying it as a static-only site will not enable shared uploads. Uploads require the admin password configured in the server environment. Public visitors can browse and open PDFs but cannot upload. The sample cards are examples, and checkout for paid documents is still a demo.

For local development, set an admin password before starting the server in PowerShell:

```powershell
$env:ADMIN_PASSWORD = "choose-a-long-private-password"
npm start
```

On Render, set the `ADMIN_PASSWORD` environment variable in the service settings (the Blueprint prompts for it). Do not put the real password in source files or GitHub.
