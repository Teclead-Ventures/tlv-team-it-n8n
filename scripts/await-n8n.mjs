/*
  Waits until an n8n instance is responsive. Treats HTTP 200-499 as ready.
  Env:
    - N8N_BASE_URL (default: http://localhost:5678)
    - N8N_API_KEY (optional)
    - TIMEOUT_SECONDS (default: 180)
    - INTERVAL_MS (default: 2000)
*/

const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
const apiKey = process.env.N8N_API_KEY;
const timeoutSeconds = Number(process.env.TIMEOUT_SECONDS || 180);
const intervalMs = Number(process.env.INTERVAL_MS || 2000);

const target = new URL("/api/v1/workflows?limit=1", baseUrl).toString();

const start = Date.now();

async function once() {
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: apiKey ? { "X-N8N-API-KEY": apiKey } : undefined,
    });
    // Any HTTP response means the server is up (401 is fine if API key not set)
    if (res.status >= 200 && res.status < 500) return true;
  } catch (_) {
    // ignore
  }
  return false;
}

while (true) {
  const ready = await once();
  if (ready) {
    console.log(`n8n is ready at ${baseUrl}`);
    break;
  }
  if (Date.now() - start > timeoutSeconds * 1000) {
    console.error(`Timed out waiting for n8n at ${baseUrl}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
