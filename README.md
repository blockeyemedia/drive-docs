# Self-hosted Drive Doc Generator API (starter)

This Node.js 20 service implements the HTTP contract used by the supplied WooCommerce plugin and persists accepted jobs in SQLite. `Idempotency-Key` is required on job creation; the plugin copy sends a stable order-scoped key so repeating a timed-out request returns the same job instead of creating another Drive folder.

## Current scope

- `POST /v1/jobs`: validates the existing plugin payload, writes one durable pending job, returns `202 { success, data: { id, status, progress, generatedFiles } }`.
- `GET /v1/jobs/:id`: returns status in the `data` envelope expected by the plugin.
- `GET /v1/jobs/:id/download`: serves the completed ZIP by unguessable UUID job ID.
- Worker creates `jobs/job-<UUID>/<product-folder>/...` and recursively copies each product's Drive folder. It uses the plugin's `zipMapping` path when supplied and otherwise uses the source product-folder name.
- Google Docs support `{{field}}` text variables, image alt-text tokens such as `logoMain`, and the six documented brand-color sentinels. Google Slides/Sheets and Office DOCX/XLSX/PPTX support text replacement; plain text, CSV, HTML, JSON, and XML support text replacement. Output files retain product-folder paths in the ZIP.
- Native Google Docs, Sheets, and Slides remain editable in Drive. ZIP export converts those to DOCX, XLSX, and PPTX respectively; other files are included in their existing format.
- Logs include request IDs and job IDs; the bearer token is redacted.

This is a **starter implementation, not a production-ready replacement yet**. The admin documentation and plugin code establish the expected folder structure, `{{variable}}` text tokens, image alt-text tokens, six exact color markers, and `zipMapping` semantics. These handlers were added from that specification but have not been exercised against real templates. PPTX replacement currently expects a marker to remain within one XML text run. PDF and standalone image files are copied as-is. A failed/partially processed job requires inspection; automatic regeneration is intentionally not enabled because that could duplicate Drive files.

## Local / cPanel configuration

1. Use Node.js 20 and run `npm install` in this directory.
2. Copy `.env.example` to `.env`; set a random `API_KEY`, a persistent writable `DATABASE_PATH` and `WORK_DIR`, and `GOOGLE_DRIVE_OUTPUT_FOLDER_ID`.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the base64-encoded service-account JSON. Enable the Drive, Docs, Slides, and Sheets APIs in Google Cloud. Share the template folders and output parent folder with the service-account email, with permission to create/edit files.
4. In cPanel Setup Node.js App, select Node 20, use this directory as the application root, and set the startup file to `src/server.js`. Keep the SQLite database and work directory on persistent local storage and outside deployment cleanup paths.
5. Configure WooCommerce > Settings > Integration > Drive Doc Generator with the app URL and the same API key.

The runtime process runs the API and its durable queue worker together. Keep `MAX_PARALLEL_JOBS=1` until large collections have been validated. Do not use a process manager or Passenger configuration that starts multiple independent apps against different copies of the SQLite database.

## Notes before production

- The order-scoped idempotency key means a deliberate second generation for the same order needs an explicit new generation key and corresponding plugin retry behavior. That operator flow is not wired in this starter.
- The API treats each `templateIds` value as a Drive folder ID. It creates one output job folder, then one product folder per template ID using `zipMapping` or the source folder name, and copies the folder contents recursively.
- Download URLs are bearer-token-free because the current plugin emails the URL directly to the customer. The job UUID is the download capability; ensure order metadata and logs are access controlled.
- Validate sharing, shared-drive access, field replacement, export formats, and the expected customer deliverable against copies of your actual templates before enabling this endpoint on staging.
