import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { appendTurnRecord } from "./turn-log.mjs";

function mkTempDir(prefix = "codex-turn-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseJsonlLines(text) {
  const events = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (!line.startsWith("{") && !line.startsWith("["))) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON chatter; Codex JSONL should still be parsed from well-formed lines.
    }
  }
  return events;
}

function pickNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

function normalizeUsage(usage) {
  const source = usage && typeof usage === "object" ? usage : {};
  const inputTokens = pickNumber(
    source.inputTokens,
    source.input_tokens,
    source.promptTokens,
    source.prompt_tokens
  );
  const outputTokens = pickNumber(
    source.outputTokens,
    source.output_tokens,
    source.completionTokens,
    source.completion_tokens
  );
  const cachedInputTokens = pickNumber(
    source.cachedInputTokens,
    source.cached_input_tokens,
    source.cacheReadInputTokens,
    source.cache_read_input_tokens,
    source.inputCachedTokens
  );
  const totalTokens = pickNumber(
    source.totalTokens,
    source.total_tokens,
    inputTokens + outputTokens + cachedInputTokens
  );

  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

function findLastMessage(events, fallback = "") {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") continue;
    const candidates = [
      event.lastMessage,
      event.last_message,
      event.message,
      event.output,
      event.text
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    if (typeof event.content === "string" && event.content.trim()) return event.content;
    if (Array.isArray(event.content)) {
      const text = event.content
        .map(item => (typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("");
      if (text.trim()) return text;
    }
  }
  return fallback;
}

function findUsage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") continue;
    if (event.usage && typeof event.usage === "object") return normalizeUsage(event.usage);
    if (event.turn && typeof event.turn === "object" && event.turn.completed && typeof event.turn.completed === "object") {
      const completed = event.turn.completed;
      if (completed.usage && typeof completed.usage === "object") return normalizeUsage(completed.usage);
    }
    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      return normalizeUsage(event.usage);
    }
  }
  return normalizeUsage({});
}

async function collectProcessOutput(child) {
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout?.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

  const exitInfo = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode: exitInfo.code,
    signal: exitInfo.signal
  };
}

export async function runCodexTurn({ worktree, prompt, taskId, turn, codexBin = "codex" }) {
  if (typeof worktree !== "string" || !worktree.trim()) throw new Error("worktree is required");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("taskId is required");
  if (!Number.isInteger(turn) || turn < 0) throw new Error("turn must be a non-negative integer");

  const tempDir = mkTempDir();
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

  let outcome;
  let error;
  try {
    const child = spawn(codexBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    const processResult = await collectProcessOutput(child);
    const events = [
      ...parseJsonlLines(processResult.stdout),
      ...parseJsonlLines(processResult.stderr)
    ];
    const fileMessage = readFileIfExists(lastMessagePath).trim();
    const lastMessage = fileMessage || findLastMessage(events, "");
    const usage = findUsage(events);

    outcome = {
      ok: processResult.exitCode === 0,
      lastMessage,
      usage,
      exitCode: processResult.exitCode
    };
  } catch (err) {
    error = err;
    outcome = {
      ok: false,
      lastMessage: "",
      usage: normalizeUsage({}),
      exitCode: null
    };
  }

  try {
    appendTurnRecord({
      taskId,
      turn,
      kind: "codex-exec",
      agent: "codex",
      prompt,
      output: outcome.lastMessage,
      meta: {
        worktree,
        codexBin,
        exitCode: outcome.exitCode,
        error: error ? error.message : undefined,
        usage: outcome.usage
      }
    });
    if (error) {
      throw error;
    }
    return outcome;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
