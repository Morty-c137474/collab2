import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { appendTurnRecord } from "./turn-log.mjs";

const DEFAULT_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0
};

function toTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: toTokenCount(usage.input_tokens),
    output_tokens: toTokenCount(usage.output_tokens),
    cached_input_tokens: toTokenCount(usage.cached_input_tokens),
    reasoning_output_tokens: toTokenCount(usage.reasoning_output_tokens)
  };
}

function parseUsageFromJsonl(stdout) {
  let usage = DEFAULT_USAGE;
  const lines = String(stdout || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = event?.type || event?.event?.type;
    if (type !== "turn.completed") continue;

    const rawUsage = event?.usage || event?.event?.usage || event?.data?.usage;
    if (rawUsage && typeof rawUsage === "object") {
      usage = normalizeUsage(rawUsage);
    }
  }

  return usage;
}

function readLastMessage(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function runCodexTurn({ worktree, prompt, taskId, turn, codexBin = "codex" }) {
  if (typeof worktree !== "string" || !worktree.trim()) {
    throw new Error("runCodexTurn: worktree 为必填字段且不得为空");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("runCodexTurn: prompt 为必填字段且不得为空");
  }
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("runCodexTurn: taskId 为必填字段且不得为空");
  }
  if (!Number.isInteger(turn) || turn < 0) {
    throw new Error("runCodexTurn: turn 为必填字段，须为非负整数");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");

  const args = [
    "exec",
    "--json",
    "-C",
    worktree,
    "--sandbox",
    "workspace-write",
    "--output-last-message",
    lastMessagePath,
    prompt
  ];

  let exitCode = 1;
  let usage = DEFAULT_USAGE;
  let lastMessage = "";

  try {
    const result = spawnSync(codexBin, args, { encoding: "utf8" });
    exitCode = typeof result.status === "number" ? result.status : 1;
    usage = parseUsageFromJsonl(result.stdout);
    lastMessage = readLastMessage(lastMessagePath);
  } finally {
    appendTurnRecord({
      taskId,
      turn,
      kind: "codex-exec",
      agent: "codex",
      prompt,
      output: lastMessage,
      meta: { usage, exitCode }
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    ok: exitCode === 0,
    lastMessage,
    usage,
    exitCode
  };
}
