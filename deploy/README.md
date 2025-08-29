### Deploying n8n with Docker Compose

1. Copy `.env.example` to `.env` and set values.
2. Start n8n:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

3. First run only: Open n8n in the browser, create the owner user and generate an API key. Paste it into `deploy/.env` as `N8N_API_KEY`.

4. Optional: Auto-import/activate workflows via Public API (requires API key):

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile deployer up deployer
```

The importer reads JSON files under `workflows/**` and upserts them by name.

### CI/CD

- Preferred: Connect n8n Source Control (Settings → Environments) to this repo, then use the GitHub Action `.github/workflows/n8n-sync.yml` with `INSTANCE_URL` and `INSTANCE_API_KEY` secrets. On push, it triggers `POST /api/v1/source-control/pull`.
- Fallback: The Action will run `scripts/sync-workflows.mjs --activate` using `N8N_BASE_URL` and `N8N_API_KEY` secrets if the pull fails.

### Credentials Overwrite (optional)

Copy `deploy/credentials-overwrite.example.json` to `deploy/credentials-overwrite.json`, fill values, mount it, and set `CREDENTIALS_OVERWRITE_FILE` in `.env`.
