import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendTurnRecord } from "./turn-log.mjs";

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens"
];

function normalizeCodexBin(codexBin) {
  if (Array.isArray(codexBin)) {
    if (codexBin.length === 0) {
      throw new Error("codexBin 数组不得为空");
    }
    return codexBin;
  }

  if (typeof codexBin === "string" && codexBin.trim()) {
    return [codexBin];
  }

  throw new Error("codexBin 必须是非空字符串或数组");
}

function extractUsage(stdout) {
  const usage = {};
  const lines = String(stdout || "").split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      const eventType = event?.type || event?.event || event?.name;

      if (eventType !== "turn.completed") continue;

      const candidate = event?.usage || event?.data?.usage || {};
      for (const field of USAGE_FIELDS) {
        if (typeof candidate?.[field] === "number" && Number.isFinite(candidate[field])) {
          usage[field] = candidate[field];
        }
      }
    } catch {
      // 宽容坏行：继续找后续 turn.completed
    }
  }

  return usage;
}

function runChild(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let exitCode = 1;
    let timedOut = false;

    child.stdout.on("data", chunk => {
      stdout += chunk;
    });

    child.on("error", () => {
      exitCode = 1;
    });

    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        exitCode = code;
      }
      if (signal === "SIGTERM") {
        timedOut = true;
      }
      resolve({ stdout, exitCode, timedOut });
    });
  });
}

export async function runCodexTurn({
  worktree,
  prompt,
  taskId,
  turn,
  codexBin = "codex",
  rootDir
}) {
  const binParts = normalizeCodexBin(codexBin);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");

  let exitCode = 1;
  let timedOut = false;
  let lastMessage = "";
  let usage = {};

  try {
    const command = binParts[0];
    const args = [
      ...binParts.slice(1),
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

    const result = await runChild(command, args);
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    usage = extractUsage(result.stdout);

    try {
      lastMessage = await fs.readFile(lastMessagePath, "utf8");
    } catch {
      lastMessage = "";
    }
  } finally {
    await fs.rm(lastMessagePath, { force: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  appendTurnRecord({
    taskId,
    turn,
    kind: "codex-exec",
    agent: "codex",
    prompt,
    output: lastMessage,
    meta: { usage, exitCode },
    rootDir
  });

  return {
    ok: exitCode === 0 && !timedOut,
    lastMessage,
    usage,
    exitCode
  };
}
