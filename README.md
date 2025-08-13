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
