#!/usr/bin/env node
// In-container Claude coding entrypoint (ENG-05). Reads the task file the runner wrote, runs one
// Agent SDK query against /workspace/repo and writes one JSON line per SDK message to stdout.
// Credentials arrive only as env vars from the runner; nothing here logs them.
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Hard ceiling, independent of the task file: the task can narrow this set, never widen it (SEC-G01).
const TOOL_CEILING = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
// Explicitly removed even if a future SDK default would expose them: no network-ish or delegating tools.
const DENIED = ["WebFetch", "WebSearch", "Agent", "Task", "Skill", "NotebookEdit"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const fail = (message) => {
  out({ type: "nexus_error", message });
  process.exitCode = 1;
};

function readTask(path) {
  const t = JSON.parse(readFileSync(path, "utf8"));
  const posInt = (v) => Number.isInteger(v) && v > 0;
  if (typeof t.prompt !== "string" || t.prompt.length === 0) throw new Error("task.prompt must be a string");
  if (typeof t.model !== "string" || !/^[\w.:@/-]{1,128}$/.test(t.model))
    throw new Error("task.model is invalid");
  if (!posInt(t.maxTurns)) throw new Error("task.maxTurns must be a positive integer");
  if (typeof t.maxBudgetUsd !== "number" || !(t.maxBudgetUsd > 0))
    throw new Error("task.maxBudgetUsd must be > 0");
  if (!Array.isArray(t.allowedTools)) throw new Error("task.allowedTools must be an array");
  if (t.effort !== undefined && !EFFORTS.includes(t.effort)) throw new Error("task.effort is invalid");
  return { ...t, tools: TOOL_CEILING.filter((name) => t.allowedTools.includes(name)) };
}

let task;
try {
  task = readTask(process.argv[2] ?? "/workspace/task.json");
} catch (err) {
  fail(`invalid task file: ${err instanceof Error ? err.message : String(err)}`);
}

if (task) {
  try {
    const messages = query({
      prompt: task.prompt,
      options: {
        cwd: "/workspace/repo",
        model: task.model,
        maxTurns: task.maxTurns,
        maxBudgetUsd: task.maxBudgetUsd,
        ...(task.effort ? { effort: task.effort } : {}),
        tools: task.tools,
        allowedTools: task.tools,
        disallowedTools: DENIED,
        // Anything not pre-approved above is denied, never prompted for.
        permissionMode: "dontAsk",
        permissionPrompts: "none",
        // Repo settings, hooks, MCP configs and CLAUDE.md permissions can't change the policy.
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        // The prompt carries untrusted issue text: no @file expansion, no slash commands.
        verbatimPrompts: true,
        persistSession: false,
        stderr: (data) => process.stderr.write(data),
      },
    });
    for await (const message of messages) out(message);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
