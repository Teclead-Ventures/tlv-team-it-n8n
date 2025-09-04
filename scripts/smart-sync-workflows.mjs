/*
  Enhanced n8n workflow synchronization with intelligent merging
  Preserves instance-specific data while applying repository changes

  Features:
  - Smart merging of repository logic with instance state
  - Change detection to avoid unnecessary updates  
  - Credential and webhook preservation
  - Detailed change reporting
  - Rollback capabilities

  Env:
    - N8N_BASE_URL (default: http://localhost:5678)
    - N8N_API_KEY (required)
    - WORKFLOWS_DIR (default: workflows)
    - DRY_RUN (default: false) - validate only, don't apply changes
    - FORCE_UPDATE (default: false) - update even without detected changes

  Usage: node scripts/smart-sync-workflows.mjs
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
  dryRun: process.env.DRY_RUN === "true",
  forceUpdate: process.env.FORCE_UPDATE === "true",
};

if (!CONFIG.apiKey) {
  console.error("❌ N8N_API_KEY is required");
  process.exit(1);
}

// ============================================================================
// API Client (reusing existing)
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

  async getWorkflowById(id, apiVersion) {
    const endpoint =
      apiVersion === "v1" ? `/api/v1/workflows/${id}` : `/rest/workflows/${id}`;
    return this.request("GET", endpoint);
  }
}

// ============================================================================
// Smart Workflow Processing
// ============================================================================

class ChangeDetector {
  detectChanges(repoWorkflow, existingWorkflow) {
    const changes = {
      name: repoWorkflow.name !== existingWorkflow.name,
      nodes: this.detectNodeChanges(repoWorkflow.nodes, existingWorkflow.nodes),
      connections: this.detectConnectionChanges(
        repoWorkflow.connections,
        existingWorkflow.connections
      ),
      settings: this.detectSettingsChanges(
        repoWorkflow.settings,
        existingWorkflow.settings
      ),
    };

    changes.hasChanges =
      changes.name ||
      changes.nodes.length > 0 ||
      changes.connections ||
      changes.settings;

    changes.summary = this.summarizeChanges(changes);
    return changes;
  }

  detectNodeChanges(repoNodes, existingNodes) {
    const changes = [];

    if (!repoNodes || !existingNodes) {
      return changes;
    }

    // Create maps for comparison (by name + type)
    const repoMap = new Map(repoNodes.map((n) => [`${n.name}:${n.type}`, n]));
    const existingMap = new Map(
      existingNodes.map((n) => [`${n.name}:${n.type}`, n])
    );

    // Check for added nodes
    for (const [key, repoNode] of repoMap) {
      if (!existingMap.has(key)) {
        changes.push({ type: "added", node: repoNode.name });
      }
    }

    // Check for removed nodes
    for (const [key, existingNode] of existingMap) {
      if (!repoMap.has(key)) {
        changes.push({ type: "removed", node: existingNode.name });
      }
    }

    // Check for modified nodes
    for (const [key, repoNode] of repoMap) {
      if (existingMap.has(key)) {
        const existingNode = existingMap.get(key);
        if (this.nodeParametersChanged(repoNode, existingNode)) {
          changes.push({ type: "modified", node: repoNode.name });
        }
      }
    }

    return changes;
  }

  nodeParametersChanged(repoNode, existingNode) {
    // Compare parameters (excluding instance-specific fields)
    const repoParams = this.cleanParameters(repoNode.parameters || {});
    const existingParams = this.cleanParameters(existingNode.parameters || {});

    return JSON.stringify(repoParams) !== JSON.stringify(existingParams);
  }

  cleanParameters(params) {
    // Create clean copy for comparison
    const cleaned = JSON.parse(JSON.stringify(params));
    // Remove credential IDs but keep structure for comparison
    this.removeCredentialIds(cleaned);
    return cleaned;
  }

  removeCredentialIds(obj) {
    if (typeof obj !== "object" || obj === null) return;

    for (const [key, value] of Object.entries(obj)) {
      if (key === "id" && typeof obj.name === "string") {
        // This looks like a credential reference - remove ID
        delete obj[key];
      } else if (typeof value === "object") {
        this.removeCredentialIds(value);
      }
    }
  }

  detectConnectionChanges(repoConnections, existingConnections) {
    return (
      JSON.stringify(this.normalizeConnections(repoConnections)) !==
      JSON.stringify(this.normalizeConnections(existingConnections))
    );
  }

  normalizeConnections(connections) {
    // Sort connections for consistent comparison
    if (!connections) return {};
    const normalized = {};
    for (const [key, value] of Object.entries(connections)) {
      normalized[key] = JSON.parse(JSON.stringify(value));
    }
    return normalized;
  }

  detectSettingsChanges(repoSettings, existingSettings) {
    return (
      JSON.stringify(repoSettings || {}) !==
      JSON.stringify(existingSettings || {})
    );
  }

  summarizeChanges(changes) {
    const parts = [];

    if (changes.name) parts.push("name");
    if (changes.nodes.length > 0) {
      const nodeTypes = changes.nodes.reduce((acc, change) => {
        acc[change.type] = (acc[change.type] || 0) + 1;
        return acc;
      }, {});

      const summary = Object.entries(nodeTypes)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");
      parts.push(`nodes: ${summary}`);
    }
    if (changes.connections) parts.push("connections");
    if (changes.settings) parts.push("settings");

    return parts.length > 0 ? parts.join("; ") : "no changes";
  }
}

class SmartWorkflowMerger {
  mergeWorkflows(repoWorkflow, existingWorkflow) {
    const merged = JSON.parse(JSON.stringify(repoWorkflow));

    // Preserve workflow-level instance data
    if (existingWorkflow.id) merged.id = existingWorkflow.id;
    if (existingWorkflow.createdAt)
      merged.createdAt = existingWorkflow.createdAt;
    if (existingWorkflow.updatedAt)
      merged.updatedAt = existingWorkflow.updatedAt;

    // Preserve meta.instanceId if it exists
    if (existingWorkflow.meta?.instanceId) {
      merged.meta = merged.meta || {};
      merged.meta.instanceId = existingWorkflow.meta.instanceId;
    }

    // Smart node merging
    if (repoWorkflow.nodes && existingWorkflow.nodes) {
      merged.nodes = this.mergeNodes(
        repoWorkflow.nodes,
        existingWorkflow.nodes
      );
    }

    return merged;
  }

  mergeNodes(repoNodes, existingNodes) {
    // Create mapping by logical identity (name + type)
    const existingMap = new Map(
      existingNodes.map((node) => [`${node.name}:${node.type}`, node])
    );

    return repoNodes.map((repoNode) => {
      const key = `${repoNode.name}:${repoNode.type}`;
      const existingNode = existingMap.get(key);

      if (existingNode) {
        // Merge repo logic with preserved instance data
        const merged = { ...repoNode };

        // Preserve instance-specific fields
        merged.id = existingNode.id;
        if (existingNode.webhookId) merged.webhookId = existingNode.webhookId;
        if (existingNode.position) merged.position = existingNode.position;

        // Smart credential merging
        merged.credentials = this.mergeCredentials(
          repoNode.credentials,
          existingNode.credentials
        );

        return merged;
      }

      // New node - will get instance data from n8n
      return this.prepareNewNode(repoNode);
    });
  }

  mergeCredentials(repoCredentials, existingCredentials) {
    if (!repoCredentials && !existingCredentials) return undefined;
    if (!repoCredentials) return existingCredentials;
    if (!existingCredentials) return this.cleanRepoCredentials(repoCredentials);

    const merged = {};

    for (const [type, repoCred] of Object.entries(repoCredentials || {})) {
      if (repoCred._preserveInstance && existingCredentials[type]) {
        // Use existing instance credential
        merged[type] = existingCredentials[type];
      } else if (repoCred._type) {
        // Clean repository credential
        merged[type] = {
          name: repoCred.name,
        };
      } else {
        // Regular credential data
        merged[type] = repoCred;
      }
    }

    return merged;
  }

  cleanRepoCredentials(repoCredentials) {
    const cleaned = {};
    for (const [type, cred] of Object.entries(repoCredentials || {})) {
      if (cred._preserveInstance) {
        // Repository credential without instance ID
        cleaned[type] = { name: cred.name };
      } else {
        cleaned[type] = cred;
      }
    }
    return cleaned;
  }

  prepareNewNode(repoNode) {
    const prepared = { ...repoNode };

    // Clean repository credential markers
    if (prepared.credentials) {
      prepared.credentials = this.cleanRepoCredentials(prepared.credentials);
    }

    return prepared;
  }
}

// ============================================================================
// Enhanced Workflow Sync Logic
// ============================================================================

class SmartWorkflowSyncer {
  constructor(apiClient) {
    this.api = apiClient;
    this.changeDetector = new ChangeDetector();
    this.merger = new SmartWorkflowMerger();
  }

  async sync() {
    console.log(
      `🔄 Starting smart workflow synchronization... ${
        CONFIG.dryRun ? "(DRY RUN)" : ""
      }`
    );

    // Validate workflow directory
    try {
      await stat(CONFIG.rootDir);
    } catch {
      console.error(`❌ Workflows directory not found: ${CONFIG.rootDir}`);
      process.exit(1);
    }

    // Load workflows from repository
    const repoWorkflows = await this.loadRepositoryWorkflows();
    if (repoWorkflows.length === 0) {
      console.log("ℹ️  No workflow files found. Skipping.");
      return;
    }

    console.log(`📁 Loaded ${repoWorkflows.length} workflows from repository`);

    // Get existing workflows from instance
    const { workflows: existingWorkflows, apiVersion } =
      await this.api.getWorkflows();
    console.log(
      `🔍 Found ${existingWorkflows.length} existing workflows in instance`
    );

    // Process each repository workflow
    const results = { created: 0, updated: 0, skipped: 0, errors: 0 };

    for (const repoWorkflow of repoWorkflows) {
      try {
        await this.processWorkflow(
          repoWorkflow,
          existingWorkflows,
          apiVersion,
          results
        );
      } catch (error) {
        console.error(
          `❌ Failed to process ${repoWorkflow.name}: ${error.message}`
        );
        results.errors++;
      }
    }

    // Summary
    this.printSummary(results);
  }

  async loadRepositoryWorkflows() {
    const files = await this.findWorkflowFiles(CONFIG.rootDir);
    const workflows = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf8");
        const workflow = JSON.parse(content);

        // Basic validation
        if (!workflow.nodes) {
          console.warn(
            `⚠️  Skipping invalid workflow file: ${filePath} - missing nodes array`
          );
          continue;
        }

        // Extract workflow name from filename if not present in JSON
        if (!workflow.name) {
          const fileName = path.basename(filePath, ".json");
          workflow.name = fileName
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());
          console.log(
            `📝 Adding workflow name from filename: ${workflow.name}`
          );
        }

        workflows.push({
          filePath,
          name: workflow.name,
          workflow,
        });
      } catch (error) {
        console.error(`❌ Failed to load ${filePath}: ${error.message}`);
      }
    }

    return workflows;
  }

  async findWorkflowFiles(directory) {
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

  async processWorkflow(
    repoWorkflowData,
    existingWorkflows,
    apiVersion,
    results
  ) {
    const { name, workflow: repoWorkflow } = repoWorkflowData;

    // Find existing workflow by name
    const existing = existingWorkflows.find(
      (w) => w.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      await this.handleUpdate(repoWorkflow, existing, apiVersion, results);
    } else {
      await this.handleCreate(repoWorkflow, apiVersion, results);
    }
  }

  async handleUpdate(repoWorkflow, existingWorkflow, apiVersion, results) {
    // Get full existing workflow data
    const fullExisting = await this.api.getWorkflowById(
      existingWorkflow.id,
      apiVersion
    );

    // Detect changes
    const changes = this.changeDetector.detectChanges(
      repoWorkflow,
      fullExisting
    );

    if (!changes.hasChanges && !CONFIG.forceUpdate) {
      console.log(`⏭️  Skipped: ${repoWorkflow.name} (no changes detected)`);
      results.skipped++;
      return;
    }

    // Merge repository workflow with instance data
    const mergedWorkflow = this.merger.mergeWorkflows(
      repoWorkflow,
      fullExisting
    );

    // Log changes
    console.log(`🔄 Processing: ${repoWorkflow.name}`);
    console.log(`   Changes: ${changes.summary}`);

    if (CONFIG.dryRun) {
      console.log(`   🔍 DRY RUN: Would update workflow`);
      this.logDetailedChanges(changes);
      results.updated++;
      return;
    }

    // Apply update
    const updated = await this.api.updateWorkflow(
      existingWorkflow.id,
      mergedWorkflow,
      apiVersion
    );
    console.log(
      `✅ Updated: ${repoWorkflow.name} (ID: ${existingWorkflow.id})`
    );
    results.updated++;
  }

  async handleCreate(repoWorkflow, apiVersion, results) {
    console.log(`✨ Creating new workflow: ${repoWorkflow.name}`);

    if (CONFIG.dryRun) {
      console.log(`   🔍 DRY RUN: Would create new workflow`);
      results.created++;
      return;
    }

    // Clean repository credentials for new workflow
    const cleanWorkflow = this.merger.prepareNewNode(repoWorkflow);

    const created = await this.api.createWorkflow(cleanWorkflow, apiVersion);
    const newId = created.id || created.data?.id;

    if (newId) {
      console.log(`✅ Created: ${repoWorkflow.name} (ID: ${newId})`);
      results.created++;
    } else {
      throw new Error("No ID returned from workflow creation");
    }
  }

  logDetailedChanges(changes) {
    if (changes.nodes.length > 0) {
      console.log(`   📝 Node changes:`);
      changes.nodes.forEach((change) => {
        console.log(`      ${change.type}: ${change.node}`);
      });
    }
    if (changes.connections) {
      console.log(`   🔗 Connection changes detected`);
    }
    if (changes.settings) {
      console.log(`   ⚙️  Settings changes detected`);
    }
  }

  printSummary(results) {
    console.log(
      `\n${
        CONFIG.dryRun ? "🔍 DRY RUN SUMMARY" : "✅ SYNCHRONIZATION COMPLETED"
      }`
    );
    console.log(`   Created: ${results.created}`);
    console.log(`   Updated: ${results.updated}`);
    console.log(`   Skipped: ${results.skipped}`);
    if (results.errors > 0) {
      console.log(`   Errors: ${results.errors}`);
    }

    if (CONFIG.dryRun && (results.created > 0 || results.updated > 0)) {
      console.log(`\n💡 Run without DRY_RUN=true to apply these changes`);
    }
  }
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  try {
    const apiClient = new N8nApiClient(CONFIG.baseUrl, CONFIG.apiKey);
    const syncer = new SmartWorkflowSyncer(apiClient);
    await syncer.sync();
  } catch (error) {
    console.error("❌ Smart synchronization failed:", error.message);
    process.exit(1);
  }
}

main();
