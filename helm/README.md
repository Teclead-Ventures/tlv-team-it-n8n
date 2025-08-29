### Kubernetes (Helm)

Prereqs:

- You have a working cluster and Helm chart for n8n (e.g., 8gears).
- Update `helm/values.n8n.yaml` with your domain and repo URL.

1. Install n8n:

```bash
helm upgrade --install n8n oci://8gears.container-registry.com/library/n8n -n <namespace> -f helm/values.n8n.yaml
```

2. Create API key in n8n UI (visit your ingress URL) and store it as a Secret:

```bash
kubectl -n <namespace> create secret generic n8n-secrets \
  --from-literal=apiKey='<YOUR_API_KEY>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

3. Trigger importer Job (runs post-install hook on upgrade):

```bash
helm upgrade n8n oci://8gears.container-registry.com/library/n8n -n <namespace> -f helm/values.n8n.yaml
```

Notes:

- The Job clones your repo, waits for n8n readiness, then runs the importer with `--activate`.
- For private repos, use a deploy key or token and adjust the Job command accordingly.
