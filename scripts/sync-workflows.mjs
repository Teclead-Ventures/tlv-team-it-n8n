/*
  Syncs workflows from a directory into n8n via Public API.
  - If a workflow with the same name exists, it will be updated.
  - Optionally activates workflows with --activate.

  Env:
    - N8N_BASE_URL (default: http://localhost:5678)
    - N8N_API_KEY (required)
    - WORKFLOWS_DIR (default: workflows)

  Usage:
    node scripts/sync-workflows.mjs [--activate]
*/

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.N8N_BASE_URL || "http://localhost:5678").replace(
  /\/$/,
  ""
);
const apiKey = process.env.N8N_API_KEY || "";
const rootDir = process.env.WORKFLOWS_DIR || "workflows";
const shouldActivate = process.argv.includes("--activate");

if (!apiKey) {
  console.error("N8N_API_KEY is required");
  process.exit(1);
}

function headers(json = true) {
  const h = { "X-N8N-API-KEY": apiKey };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function listFilesRecursive(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

async function request(method, urlPath, body) {
  const url = `${baseUrl}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${method} ${url} -> ${res.status} ${res.statusText} ${text}`
    );
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}

async function listExistingWorkflows() {
  // Prefer Public API
  try {
    const data = await request("GET", "/api/v1/workflows?limit=250");
    const items = Array.isArray(data)
      ? data
      : data.data || data.workflows || [];
    const map = new Map();
    for (const w of items) map.set((w.name || "").toLowerCase(), w);
    return { map, variant: "apiV1", items };
  } catch (_) {
    // Fallback to /rest (embed)
    const data = await request("GET", "/rest/workflows");
    const items = Array.isArray(data)
      ? data
      : data.data || data.workflows || [];
    const map = new Map();
    for (const w of items) map.set((w.name || "").toLowerCase(), w);
    return { map, variant: "rest", items };
  }
}

async function createWorkflow(variant, payload) {
  if (variant === "apiV1") return request("POST", "/api/v1/workflows", payload);
  return request("POST", "/rest/workflows", payload);
}

async function updateWorkflow(variant, id, payload) {
  // Try PUT first, then PATCH if needed
  try {
    if (variant === "apiV1")
      return await request("PUT", `/api/v1/workflows/${id}`, payload);
    return await request("PUT", `/rest/workflows/${id}`, payload);
  } catch (err) {
    if (variant === "apiV1") throw err;
    return request("PATCH", `/rest/workflows/${id}`, payload);
  }
}

async function setActive(variant, id, active, basePayload) {
  if (variant === "apiV1") {
    if (active) {
      return request("POST", `/api/v1/workflows/${id}/activate`, {});
    }
    return request("POST", `/api/v1/workflows/${id}/deactivate`, {});
  }
  // /rest supports PATCH with just { active }
  return request("PATCH", `/rest/workflows/${id}`, { active });
}

function sanitizeWorkflow(wf, filePath) {
  // Minimal payload accepted by Public API v1
  const allowed = ["name", "nodes", "connections", "settings"];
  const out = {};
  for (const k of allowed) if (k in wf) out[k] = wf[k];
  // Ensure name
  if (!out.name)
    out.name =
      (filePath && path.basename(filePath, ".json")) || "Imported Workflow";
  // Ensure required fields for API schema
  if (!out.settings || typeof out.settings !== "object") out.settings = {};
  if (!out.connections || typeof out.connections !== "object")
    out.connections = {};
  // Remove IDs from nodes to avoid collisions
  if (Array.isArray(out.nodes)) {
    out.nodes = out.nodes.map((n) => {
      const { id, ...rest } = n;
      return rest;
    });
  }
  return out;
}

async function main() {
  // Ensure rootDir exists
  try {
    await stat(rootDir);
  } catch {
    console.error(`Workflows dir not found: ${rootDir}`);
    process.exit(1);
  }

  const files = await listFilesRecursive(rootDir);
  if (files.length === 0) {
    console.log("No workflow JSON files found. Skipping.");
    return;
  }

  const {
    map: existingByName,
    variant,
    items: existingItems,
  } = await listExistingWorkflows();
  const usedIds = new Set();

  for (const file of files) {
    try {
      const raw = await readFile(file, "utf8");
      const wf = JSON.parse(raw);
      const payload = sanitizeWorkflow(wf, file);
      const key = (payload.name || "").toLowerCase();
      let existing = existingByName.get(key);
      if (existing) {
        const id =
          existing.id ||
          existing._id ||
          existing.workflowId ||
          existing.data?.id;
        if (!id)
          throw new Error(
            `Cannot determine ID for existing workflow: ${payload.name}`
          );
        await updateWorkflow(variant, id, payload);
        console.log(`Updated workflow: ${payload.name}`);
        if (shouldActivate) {
          await setActive(variant, id, true, payload);
          console.log(`Activated workflow: ${payload.name}`);
        }
      } else {
        // Fallback: try rename an existing "Imported Workflow" once
        const imported = existingItems.find(
          (w) =>
            (w.name || "").toLowerCase() === "imported workflow" &&
            !usedIds.has(w.id)
        );
        if (imported && (imported.id || imported._id)) {
          const id = imported.id || imported._id;
          usedIds.add(id);
          await updateWorkflow(variant, id, payload);
          console.log(`Renamed workflow to: ${payload.name}`);
          if (shouldActivate) {
            await setActive(variant, id, true, payload);
            console.log(`Activated workflow: ${payload.name}`);
          }
        } else {
          const created = await createWorkflow(variant, payload);
          const id = created?.id || created?.data?.id;
          console.log(
            `Created workflow: ${payload.name} (id=${id ?? "unknown"})`
          );
          if (shouldActivate && id) {
            await setActive(variant, id, true, payload);
            console.log(`Activated workflow: ${payload.name}`);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to sync ${file}:`, err.message || err);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
