## Team IT TANSS Classification (n8n)

Automated ticket enrichment and routing for TANSS helpdesk using n8n and LLMs. The main workflow fetches recently modified tickets, collects related mails, documents and screenshots, summarizes their content, and produces a structured classification that is written back to TANSS as an internal comment and ticket update.

### Workflows

- `workflows/main-workflows/main_tanss_classification.json`

  - Orchestrates the flow on a schedule (default: every 10s)
  - Fetches recent tickets from TANSS (last 200 minutes, `companies: [7]` by default)
  - Calls sub-workflows to enrich the ticket with mails, document summaries and image summaries
  - Uses an LLM to extract a final classification and updates the ticket (department, priority, internal marker, and comment)

- `workflows/sub-workflows/sub_tanss_login.json`

  - Logs into TANSS (`POST /backend/api/v1/login`) using HTTP Custom Auth
  - Stores `apiKey` and its expiry in workflow static data for reuse

- `workflows/sub-workflows/sub_tanss_mails.json`

  - Retrieves ticket history and extracts inbound/outbound mails

- `workflows/sub-workflows/sub_tanss_get_documents.json`

  - Lists documents on the ticket, fetches file content and summarizes it

- `workflows/sub-workflows/sub_tanss_images.json`
  - Lists screenshots/images on the ticket, fetches the files and summarizes visible content

### Required Credentials (n8n → Settings → Credentials)

- Header Auth (type: HTTP Header Auth)

  - Name: `Header Auth account`
  - Purpose: Auth for all TANSS API requests after login (documents, screenshots, tickets, comments, updates)
  - Configure a header your TANSS instance expects for authenticated calls, for example:
    - Header name: `X-Api-Key` (or `Authorization`)
    - Header value: your current TANSS API key/token
  - Note: The login sub-workflow retrieves a fresh `apiKey`. If your n8n allows expressions in credential fields, you can reference the stored value (e.g. from workflow static data). If not, keep a valid key here or switch the HTTP Request nodes to add a dynamic header from the login output.

- TANSS API Credentials (type: HTTP Custom Auth)

  - Name: `TANSS API Credentials`
  - Used by: `sub_tanss_login.json` (Login node)
  - Configure this credential to send your TANSS login parameters with the request to `POST /backend/api/v1/login` (e.g., username/email and password) according to your TANSS instance requirements. Ensure the request body or headers produced by this credential match what TANSS expects.

- Mistral Cloud API (type: Mistral Cloud API)

  - Name: `Mistral Cloud account`
  - Used by: document and image summarization nodes
  - Requirement: a valid Mistral API key

- OpenRouter API (type: OpenRouter API)
  - Name: `OpenRouter account`
  - Used by: final ticket classification LLM (`meta-llama/llama-3.3-70b-instruct`)
  - Requirement: a valid OpenRouter API key

### Community Nodes / Dependencies

These workflows use the n8n LangChain community nodes. In n8n:

1. Go to Settings → Community Nodes
2. Install `@n8n/n8n-nodes-langchain`

### Import and Wiring

1. Import all JSON files in `workflows/main-workflows/` and `workflows/sub-workflows/` via n8n → Import from File.
2. Open the main workflow and re-select each Execute Workflow node so it points to the imported sub-workflows:
   - Login → `sub_tanss_login`
   - Mails → `sub_tanss_mails`
   - Documents → `sub_tanss_get_documents`
   - Images → `sub_tanss_images`
     (IDs referenced in JSON will differ after import.)
3. Create and assign the credentials listed above to the relevant nodes if they are not already mapped after import.

### Configuration

- TANSS API base: `https://helpdesk.team-it-group.de/backend/api/v1`
- Main ticket fetch window: last 200 minutes (adjust in the main workflow HTTP Request body)
- Company filter: `companies: [7]` by default (adjust as needed)
- Schedule: default 10 seconds (adjust the `Schedule Trigger` in the main workflow for production)
- Ticket update flag: the workflow marks classified tickets via `internalContent: "X-AUTO-CLASSIFIED"` to avoid re-processing

### How to Test

1. Run `sub_tanss_login` once and confirm it returns an `apiKey` and sets expiry in static data.
2. Execute `sub_tanss_mails`, `sub_tanss_get_documents`, and `sub_tanss_images` individually with a known ticket ID to verify TANSS connectivity and summarization.
3. Run the main workflow manually; confirm it:
   - Fetches tickets
   - Adds mails/documents/images
   - Produces a JSON classification output
   - Updates the ticket (priority/department) and posts an internal comment

### Notes and Troubleshooting

- If TANSS calls fail with 401/403, verify:
  - `Header Auth account` header name/value
  - `TANSS API Credentials` produce the right login payload
  - The `apiKey` has not expired and is injected where needed
- If LLM nodes fail, check Mistral/OpenRouter keys and tenant quotas.
- After import, if Execute Workflow nodes reference old names like `test_tanss_*`, re-point them to the `sub_tanss_*` workflows.

### Security

- Keep all secrets in n8n Credentials; do not commit keys/tokens.
- Restrict access to n8n and rotate API keys regularly.

## Deployment & CI/CD Plan (n8n)

Below is a minimal-effort, environment-agnostic plan to deploy self-hosted n8n with these workflows and keep them in sync with Git on every push.

- Source of truth: This repo (`workflows/**`) remains canonical.
- One-click/local: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d` brings up n8n and auto-imports workflows.
- CI/CD: On push, GitHub Actions can trigger your n8n instance to pull from Git via n8n Source Control, or fall back to importing via the Public API using a script.
- Environments: Works for Docker local, servers/VMs, Kubernetes (Helm values), and AWS ECS (task def skeleton).

### Preferred sync method: n8n Source Control

1. In your n8n instance: connect to your Git repo (Settings → Environments → Connect). Choose your branch per environment and enable Protected instance in prod.
2. CI/CD: Configure the GitHub Action in `.github/workflows/n8n-sync.yml` with `INSTANCE_URL` and `INSTANCE_API_KEY` secrets. On each push, the action calls `POST /api/v1/source-control/pull` to fetch the latest commit.
3. Access control: Keep this repo private; use deploy keys from within n8n.

Reference: n8n Source Control Pull API `POST /api/v1/source-control/pull` and example GitHub Action from the n8n docs.

### Fallback sync method: Public API import

For instances without Source Control enabled, a Node script (`scripts/smart-sync-workflows.mjs`) intelligently syncs `workflows/**/*.json` via the n8n Public API, preserving instance-specific data. You can:

- Run it locally after startup (Compose includes an optional `deployer` service for one-click).
- Run it in CI (GitHub Action step) using `N8N_BASE_URL` and `N8N_API_KEY` secrets.

### Artifacts added in this repo

- `deploy/docker-compose.yml`: Production-leaning local stack (n8n + optional importer) with persistent volume.
- `deploy/.env.example`: Copy to `deploy/.env` and fill instance-specific values (timezone, API key, etc.).
- `scripts/await-n8n.mjs`: Waits for n8n readiness using the Public API.
- `scripts/smart-sync-workflows.mjs`: Intelligently syncs workflows via Public API while preserving instance data.
- `.github/workflows/n8n-smart-sync.yml`: Intelligent workflow synchronization via API.
- `helm/values.n8n.yaml`: Example values for the 8gears Helm chart.
- `aws/ecs-taskdef.json`: ECS Fargate task definition skeleton.
- `deploy/credentials-overwrite.example.json`: Shows how to provision client IDs/secrets via overwrite file.

### Usage

- Local one-click:

  1. Copy `deploy/.env.example` → `deploy/.env` and set `GENERIC_TIMEZONE`, `N8N_API_KEY`, etc.
  2. Run:

  ```bash
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
  ```

  3. First run only: open n8n, create owner user, create an API key, and put it into `deploy/.env`. Restart `deployer` service or re-run the command above to import workflows.

- CI (Source Control):  
  Add `INSTANCE_URL` (like `https://n8n.example.com/api/v1`) and `INSTANCE_API_KEY` as GitHub repo secrets. On push, the action triggers `source-control/pull`.

- CI (API Import fallback):  
  Add `N8N_BASE_URL` (like `https://n8n.example.com`) and `N8N_API_KEY` as secrets. Add a step to run `node scripts/smart-sync-workflows.mjs`.

### Security & credentials

- Prefer n8n Credentials for secrets; do not commit secrets.
- If you must provision client IDs/secrets at deploy time, use the overwrite file pattern (see `deploy/credentials-overwrite.example.json`) and mount it, setting `CREDENTIALS_OVERWRITE_FILE`.

### Tests & checks

- Smoke test: `GET /api/v1/workflows?limit=1` should respond 200 with Public API key.
- After import: ensure main workflow is set to active; scheduled triggers run as configured.
- Metrics/health: optionally enable `/metrics` and `/healthz` via envs.
