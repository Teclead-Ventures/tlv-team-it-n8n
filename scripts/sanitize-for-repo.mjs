/*
  Sanitizes n8n workflow exports for repository storage
  Removes instance-specific data while preserving logical structure

  Usage: node scripts/sanitize-for-repo.mjs --input <workflow.json> --output <sanitized.json>
  Or: node scripts/sanitize-for-repo.mjs --directory workflows/raw/ --output workflows/
*/

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

class WorkflowSanitizer {
  constructor() {
    this.instanceSpecificFields = {
      workflow: ["id", "createdAt", "updatedAt"],
      node: ["id", "webhookId"],
      meta: ["instanceId"],
    };
  }

  sanitize(workflow) {
    const sanitized = JSON.parse(JSON.stringify(workflow));

    // Remove workflow instance data
    this.instanceSpecificFields.workflow.forEach((field) => {
      delete sanitized[field];
    });

    // Remove meta instance data
    if (sanitized.meta) {
      this.instanceSpecificFields.meta.forEach((field) => {
        delete sanitized.meta[field];
      });
    }

    // Sanitize nodes
    if (sanitized.nodes) {
      sanitized.nodes = sanitized.nodes.map((node) => this.sanitizeNode(node));
      // Sort nodes by name for consistent diffs
      sanitized.nodes.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Clean pinData (test/debug data)
    sanitized.pinData = {};

    return sanitized;
  }

  sanitizeNode(node) {
    const sanitized = { ...node };

    // Remove instance-specific node fields
    this.instanceSpecificFields.node.forEach((field) => {
      delete sanitized[field];
    });

    // Sanitize credentials - preserve type and name, mark for instance preservation
    if (sanitized.credentials) {
      sanitized.credentials = Object.fromEntries(
        Object.entries(sanitized.credentials).map(([type, cred]) => [
          type,
          {
            name: cred.name,
            _type: type,
            _preserveInstance: true, // Marker for sync script
          },
        ])
      );
    }

    // Remove position for cleaner diffs (will be preserved during sync)
    delete sanitized.position;

    return sanitized;
  }

  // Generate change summary for commit messages
  generateChangeSummary(original, sanitized) {
    const changes = [];

    if (original.nodes && sanitized.nodes) {
      const originalNodeNames = new Set(original.nodes.map((n) => n.name));
      const sanitizedNodeNames = new Set(sanitized.nodes.map((n) => n.name));

      const added = [...sanitizedNodeNames].filter(
        (n) => !originalNodeNames.has(n)
      );
      const removed = [...originalNodeNames].filter(
        (n) => !sanitizedNodeNames.has(n)
      );

      if (added.length) changes.push(`+${added.length} nodes`);
      if (removed.length) changes.push(`-${removed.length} nodes`);
    }

    return changes.length ? changes.join(", ") : "structure updates";
  }
}

// CLI functionality
async function main() {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf("--input");
  const outputFlag = args.indexOf("--output");
  const directoryFlag = args.indexOf("--directory");

  const sanitizer = new WorkflowSanitizer();

  if (directoryFlag !== -1) {
    // Process entire directory
    const inputDir = args[directoryFlag + 1];
    const outputDir = args[outputFlag + 1];

    const files = await readdir(inputDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    console.log(`🔄 Processing ${jsonFiles.length} workflow files...`);

    for (const file of jsonFiles) {
      const inputPath = join(inputDir, file);
      const outputPath = join(outputDir, file);

      try {
        const workflow = JSON.parse(await readFile(inputPath, "utf8"));
        const sanitized = sanitizer.sanitize(workflow);

        await writeFile(outputPath, JSON.stringify(sanitized, null, 2));
        console.log(`✅ Sanitized: ${file}`);
      } catch (error) {
        console.error(`❌ Failed to process ${file}: ${error.message}`);
      }
    }
  } else if (inputFlag !== -1 && outputFlag !== -1) {
    // Process single file
    const inputPath = args[inputFlag + 1];
    const outputPath = args[outputFlag + 1];

    const workflow = JSON.parse(await readFile(inputPath, "utf8"));
    const sanitized = sanitizer.sanitize(workflow);
    const summary = sanitizer.generateChangeSummary(workflow, sanitized);

    await writeFile(outputPath, JSON.stringify(sanitized, null, 2));
    console.log(`✅ Sanitized workflow: ${basename(inputPath)} (${summary})`);
  } else {
    console.log(`
Usage:
  Single file: node scripts/sanitize-for-repo.mjs --input workflow.json --output sanitized.json
  Directory:   node scripts/sanitize-for-repo.mjs --directory workflows/raw/ --output workflows/
    `);
  }
}

main().catch(console.error);
