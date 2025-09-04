### Docker Compose (Local)

1. Copy and edit env:

```bash
cp deploy/.env.example deploy/.env
# open deploy/.env and set GENERIC_TIMEZONE; leave N8N_API_KEY empty for now
```

2. Start n8n:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

3. Create API key in n8n UI:

- Open http://localhost:5678
- Create the owner user if prompted
- Go to Settings → Users → API Keys → Create → copy the key
- Paste into `deploy/.env` as `N8N_API_KEY=...`

4. Import workflows (one-time or on demand):

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile deployer up --force-recreate --no-deps deployer
```

Notes:

- The importer reads all JSON under `workflows/**` and upserts by name.
- The new smart sync script automatically handles activation as needed.

### Credentials Overwrite (optional)

1. Create `deploy/credentials-overwrite.json` (based on `.example`) with client IDs/secrets (no API keys).
2. Mount the file and set `CREDENTIALS_OVERWRITE_FILE` in environment:

- Compose: set in `deploy/.env` and mount the file in `docker-compose.yml` if needed.
- Helm/ECS: add file to a Secret and mount or expose as env.

Security tips:

- Never commit API keys/tokens. Use Secrets (K8s Secrets, AWS Secrets Manager, GitHub Actions Secrets).
- Restrict inbound access to n8n and rotate keys periodically.
