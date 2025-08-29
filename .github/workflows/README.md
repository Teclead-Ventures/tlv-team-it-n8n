### GitHub Actions (CI-only, no Business plan)

1. In GitHub repo settings → Secrets and variables → Actions → New repository secret:

- `N8N_BASE_URL` (e.g., `https://n8n.example.com`)
- `N8N_API_KEY` (from n8n)

2. Ensure workflow `.github/workflows/n8n-sync.yml` exists. It runs:

```yaml
node scripts/sync-workflows.mjs --activate
```

3. On pushes to `workflows/**`, Actions imports/activates your workflows into the instance.

Notes:

- Instance must be reachable from GitHub Actions or use a self-hosted runner.
- If you prefer manual activation, remove `--activate`.
