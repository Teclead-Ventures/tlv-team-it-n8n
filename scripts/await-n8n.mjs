/*
  Waits until /healthz/readiness responds with HTTP 200.
  Env:
    - N8N_BASE_URL (default: http://localhost:5678)
    - TIMEOUT_MS (default: 180000)  // prefers milliseconds
      (fallback: TIMEOUT_SECONDS, deprecated)
    - INTERVAL_MS (default: 2000)
*/

const baseUrl = process.env.N8N_BASE_URL || "http://localhost:5678";
const timeoutMs = Number(
  process.env.TIMEOUT_MS || Number(process.env.TIMEOUT_SECONDS || 180) * 1000
);
const intervalMs = Number(process.env.INTERVAL_MS || 2000);

const target = new URL("/healthz/readiness", baseUrl).toString();

const start = Date.now();

async function once() {
  try {
    const res = await fetch(target, { method: "GET" });
    // Only consider n8n ready when /healthz returns 200
    if (res.status === 200) return true;
  } catch (_) {
    // ignore
  }
  return false;
}

const deadline = start + timeoutMs;
while (Date.now() < deadline) {
  const ready = await once();
  if (ready) {
    console.log(`n8n is ready at ${baseUrl}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
console.error(`Timed out waiting for n8n at ${baseUrl}`);
process.exit(1);
