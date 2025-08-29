### AWS ECS (Fargate)

Prereqs:

- A VPC/subnets/security groups and an ALB or exposed service.
- Update `aws/ecs-taskdef.json` placeholders (region, ARNs, repo URL).

1. Deploy n8n service initially (without importer secrets):

- Register the task definition from `aws/ecs-taskdef.json`.
- Create the service in ECS.

2. Create API key in n8n UI and store it in AWS Secrets Manager (e.g., name `n8n-api-key`).

3. Update the task definition importer container to reference the secret:

- Replace the plain `N8N_API_KEY` env with a `secrets` entry:

```json
"secrets": [
  { "name": "N8N_API_KEY", "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:n8n-api-key-xxxxx" }
]
```

4. Redeploy the service:

- The `n8n` container has a health check; the `importer` waits for healthy, clones the repo, and runs the importer with `--activate`.

Notes:

- The importer runs once per task start; subsequent deploys will upsert.
- Ensure the task has outbound internet to reach Git.
