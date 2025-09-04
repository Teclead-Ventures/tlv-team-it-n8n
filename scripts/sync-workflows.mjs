/*
  Syncs workflows from a directory into n8n via Public API.
  - If a workflow with the same name exists, it will be updated.
  - Handles Execute Workflow dependencies automatically.

  Env:
    - N8N_BASE_URL (default: http://localhost:5678)
    - N8N_API_KEY (required)
    - WORKFLOWS_DIR (default: workflows)

  Usage:
    node scripts/sync-workflows.mjs
*/

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Configuration
const CONFIG = {
  baseUrl: (process.env.N8N_BASE_URL || "http://localhost:5678").replace(
    /\/$/,
    ""
  ),
  apiKey: process.env.N8N_API_KEY || "",
  rootDir: process.env.WORKFLOWS_DIR || "workflows",
};

if (!CONFIG.apiKey) {
  console.error("❌ N8N_API_KEY is required");
  process.exit(1);
}

// ============================================================================
// API Client
// ============================================================================

class N8nApiClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.headers = {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
    };
  }

  async request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `${method} ${path} -> ${response.status} ${response.statusText} ${text}`
        );
      }

      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("application/json")
        ? response.json()
        : response.text();
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }

  async getWorkflows() {
    // Try Public API first, fallback to REST API
    try {
      const data = await this.request("GET", "/api/v1/workflows?limit=250");
      return {
        workflows: Array.isArray(data) ? data : data.data || [],
        apiVersion: "v1",
      };
    } catch {
      const data = await this.request("GET", "/rest/workflows");
      return {
        workflows: Array.isArray(data) ? data : data.data || [],
        apiVersion: "rest",
      };
    }
  }

  async createWorkflow(workflow, apiVersion) {
    const endpoint =
      apiVersion === "v1" ? "/api/v1/workflows" : "/rest/workflows";
    return this.request("POST", endpoint, workflow);
  }

  async updateWorkflow(id, workflow, apiVersion) {
    const endpoint =
      apiVersion === "v1" ? `/api/v1/workflows/${id}` : `/rest/workflows/${id}`;
    return this.request("PUT", endpoint, workflow);
  }
}

// ============================================================================
// Workflow Processing
// ============================================================================

class WorkflowProcessor {
  static sanitizeWorkflow(workflow, filePath) {
    const allowed = ["name", "nodes", "connections", "settings"];
    const sanitized = {};

    // Copy allowed fields
    for (const key of allowed) {
      if (key in workflow) sanitized[key] = workflow[key];
    }

    // Ensure required fields
    sanitized.name =
      sanitized.name || path.basename(filePath, ".json") || "Imported Workflow";
    sanitized.settings = sanitized.settings || {};
    sanitized.connections = sanitized.connections || {};

    // Remove node IDs to avoid conflicts
    if (Array.isArray(sanitized.nodes)) {
      sanitized.nodes = sanitized.nodes.map(({ id, ...node }) => node);
    }

    return sanitized;
  }

  static extractDependencies(workflow) {
    const dependencies = new Set();

    if (!workflow.nodes || !Array.isArray(workflow.nodes)) return dependencies;

    for (const node of workflow.nodes) {
      if (node.type === "n8n-nodes-base.executeWorkflow") {
        const params = node.parameters || {};
        const workflowParam = params.workflowId || params.workflow;

        if (workflowParam?.cachedResultName) {
          dependencies.add(workflowParam.cachedResultName.toLowerCase());
        }
      }
    }

    return dependencies;
  }

  static updateWorkflowReferences(workflow, nameToIdMap) {
    if (!workflow.nodes || !Array.isArray(workflow.nodes)) return false;

    let updated = false;

    for (const node of workflow.nodes) {
      if (node.type === "n8n-nodes-base.executeWorkflow") {
        const params = node.parameters || {};
        const workflowParam = params.workflowId || params.workflow;

        if (workflowParam?.cachedResultName) {
          const dependencyName = workflowParam.cachedResultName.toLowerCase();
          const dependencyId = nameToIdMap.get(dependencyName);

          if (dependencyId && workflowParam.value !== dependencyId) {
            workflowParam.value = dependencyId;
            updated = true;
          }
        }
      }
    }

    return updated;
  }
}

// ============================================================================
// Dependency Resolution
// ============================================================================

class DependencyResolver {
  static sortByDependencies(workflows) {
    const workflowMap = new Map(workflows.map((wf) => [wf.nameLower, wf]));
    const visited = new Set();
    const visiting = new Set();
    const sorted = [];

    const visit = (nameLower) => {
      if (visited.has(nameLower)) return;
      if (visiting.has(nameLower)) {
        console.warn(
          `⚠️  Circular dependency detected involving: ${nameLower}`
        );
        return;
      }

      const workflow = workflowMap.get(nameLower);
      if (!workflow) return;

      visiting.add(nameLower);

      // Visit dependencies first
      for (const depName of workflow.dependencies) {
        if (workflowMap.has(depName)) {
          visit(depName);
        }
      }

      visiting.delete(nameLower);
      visited.add(nameLower);
      sorted.push(workflow);
    };

    // Visit all workflows
    for (const workflow of workflows) {
      visit(workflow.nameLower);
    }

    return sorted;
  }
}

// ============================================================================
// File Operations
// ============================================================================

class FileLoader {
  static async findWorkflowFiles(directory) {
    const files = [];

    const processDirectory = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await processDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          files.push(fullPath);
        }
      }
    };

    await processDirectory(directory);
    return files;
  }

  static async loadWorkflow(filePath) {
    try {
      const content = await readFile(filePath, "utf8");
      const workflow = JSON.parse(content);
      const sanitized = WorkflowProcessor.sanitizeWorkflow(workflow, filePath);
      const dependencies = WorkflowProcessor.extractDependencies(sanitized);

      return {
        filePath,
        name: sanitized.name,
        nameLower: sanitized.name.toLowerCase(),
        workflow: sanitized,
        dependencies,
      };
    } catch (error) {
      throw new Error(`Failed to load ${filePath}: ${error.message}`);
    }
  }
}

// ============================================================================
// Main Sync Logic
// ============================================================================

class WorkflowSyncer {
  constructor(apiClient) {
    this.api = apiClient;
  }

  async sync() {
    console.log("🔄 Starting workflow synchronization...");

    // Validate workflow directory
    try {
      await stat(CONFIG.rootDir);
    } catch {
      console.error(`❌ Workflows directory not found: ${CONFIG.rootDir}`);
      process.exit(1);
    }

    // Load workflows from disk
    const files = await FileLoader.findWorkflowFiles(CONFIG.rootDir);
    if (files.length === 0) {
      console.log("ℹ️  No workflow JSON files found. Skipping.");
      return;
    }

    console.log(`📁 Found ${files.length} workflow files`);

    // Load and parse workflows
    const workflows = [];
    for (const file of files) {
      try {
        const workflow = await FileLoader.loadWorkflow(file);
        workflows.push(workflow);
      } catch (error) {
        console.error(`❌ ${error.message}`);
      }
    }

    if (workflows.length === 0) {
      console.log("❌ No valid workflows loaded");
      return;
    }

    // Get existing workflows from n8n
    const { workflows: existingWorkflows, apiVersion } =
      await this.api.getWorkflows();
    const existingByName = new Map(
      existingWorkflows.map((wf) => [
        wf.name.toLowerCase(),
        { id: wf.id || wf._id },
      ])
    );

    console.log(
      `🔍 Found ${existingWorkflows.length} existing workflows in n8n`
    );

    // Sort workflows by dependencies
    const sortedWorkflows = DependencyResolver.sortByDependencies(workflows);
    console.log(
      `📋 Processing ${sortedWorkflows.length} workflows in dependency order`
    );

    // Track name-to-ID mapping for dependency resolution
    const nameToIdMap = new Map();

    // Initialize with existing workflows
    for (const [name, info] of existingByName) {
      nameToIdMap.set(name, info.id);
    }

    // Process workflows in dependency order
    const results = { created: 0, updated: 0, errors: 0 };

    for (const workflowData of sortedWorkflows) {
      try {
        await this.processWorkflow(
          workflowData,
          existingByName,
          nameToIdMap,
          apiVersion,
          results
        );
      } catch (error) {
        console.error(
          `❌ Failed to process ${workflowData.name}: ${error.message}`
        );
        results.errors++;
      }
    }

    // Summary
    console.log("\n✅ Synchronization completed!");
    console.log(`   Created: ${results.created}`);
    console.log(`   Updated: ${results.updated}`);
    if (results.errors > 0) {
      console.log(`   Errors: ${results.errors}`);
    }
  }

  async processWorkflow(
    workflowData,
    existingByName,
    nameToIdMap,
    apiVersion,
    results
  ) {
    const { name, nameLower, workflow } = workflowData;

    // Update workflow references with current ID mapping
    WorkflowProcessor.updateWorkflowReferences(workflow, nameToIdMap);

    const existing = existingByName.get(nameLower);

    if (existing) {
      // Update existing workflow
      await this.api.updateWorkflow(existing.id, workflow, apiVersion);
      console.log(`📝 Updated: ${name}`);
      results.updated++;
    } else {
      // Create new workflow
      const created = await this.api.createWorkflow(workflow, apiVersion);
      const newId = created.id || created.data?.id;

      if (newId) {
        nameToIdMap.set(nameLower, newId);
        console.log(`✨ Created: ${name} (ID: ${newId})`);
        results.created++;
      } else {
        throw new Error("No ID returned from workflow creation");
      }
    }
  }
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  try {
    const apiClient = new N8nApiClient(CONFIG.baseUrl, CONFIG.apiKey);
    const syncer = new WorkflowSyncer(apiClient);
    await syncer.sync();
  } catch (error) {
    console.error("❌ Synchronization failed:", error.message);
    process.exit(1);
  }
}

main();
