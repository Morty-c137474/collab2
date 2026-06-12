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

const DEFAULT_TIMEOUT_MS = 600000;
const STDERR_TAIL_MAX_BYTES = 16384;
const CMD_METACHAR_PATTERN = /["&^%|<>()]/;

function validateTurnInputs(taskId, turn) {
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("taskId 不得为空");
  }
  if (!Number.isInteger(turn) || turn < 0) {
    throw new Error("turn 必须是非负整数");
  }
}

function normalizeTimeoutMs(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs 必须是正整数");
  }
  return timeoutMs;
}

function normalizeCodexBin(codexBin, platform = process.platform) {
  if (Array.isArray(codexBin)) {
    if (codexBin.length === 0) {
      throw new Error("codexBin 数组不得为空");
    }
    return {
      binParts: codexBin,
      viaCmdWrapper: false
    };
  }

  if (typeof codexBin === "string" && codexBin.trim()) {
    if (platform === "win32") {
      return {
        binParts: ["cmd", "/c", codexBin],
        viaCmdWrapper: true
      };
    }
    return {
      binParts: [codexBin],
      viaCmdWrapper: false
    };
  }

  throw new Error("codexBin 必须是非空字符串或数组");
}

function assertNoCmdMetacharArgs(args) {
  const badArg = args.find(arg => CMD_METACHAR_PATTERN.test(String(arg)));
  if (badArg !== undefined) {
    throw new Error(`win32 cmd 转发参数含危险元字符，已拒绝执行：${badArg}`);
  }
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

function appendTailBuffer(current, chunk, maxBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > maxBytes ? next.subarray(next.length - maxBytes) : next;
}

function runChild(command, args, { timeoutMs, stdinInput = "", spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let child;

    try {
      child = spawnImpl(command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderrTail: "",
        exitCode: 1,
        timedOut: false,
        error
      });
      return;
    }

    let stdout = "";
    let stderrTail = Buffer.alloc(0);
    let exitCode = 1;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = payload => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        stdout,
        stderrTail: stderrTail.toString("utf8"),
        exitCode,
        timedOut,
        ...payload
      });
    };

    child.stdout.on("data", chunk => {
      stdout += chunk;
    });

    child.stderr.on("data", chunk => {
      stderrTail = appendTailBuffer(stderrTail, chunk, STDERR_TAIL_MAX_BYTES);
    });

    child.on("error", error => {
      exitCode = 1;
      finish({ error });
    });

    child.on("close", (code, signal) => {
      if (typeof code === "number") {
        exitCode = code;
      }
      if (signal === "SIGTERM") {
        timedOut = true;
      }
      finish({});
    });

    if (child.stdin && typeof child.stdin.write === "function") {
      child.stdin.write(stdinInput);
      if (typeof child.stdin.end === "function") {
        child.stdin.end();
      }
    }

    timer = setTimeout(() => {
      timedOut = true;
      exitCode = 1;
      child.kill();
    }, timeoutMs);
  });
}

export async function runCodexTurn({
  worktree,
  prompt,
  taskId,
  turn,
  codexBin = "codex",
  rootDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  spawnImpl = spawn,
  appendTurnRecordImpl = appendTurnRecord
}) {
  validateTurnInputs(taskId, turn);

  let exitCode = 1;
  let timedOut = false;
  let lastMessage = "";
  let usage = {};
  let stderrTail = "";
  let errorMessage = "";
  let tempDir = "";
  let lastMessagePath = "";

  try {
    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
    const { binParts, viaCmdWrapper } = normalizeCodexBin(codexBin, platform);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-"));
    lastMessagePath = path.join(tempDir, "last-message.txt");

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
      "-"
    ];

    if (viaCmdWrapper) {
      assertNoCmdMetacharArgs(args.slice(1));
    }

    const result = await runChild(command, args, {
      timeoutMs: effectiveTimeoutMs,
      stdinInput: String(prompt ?? ""),
      spawnImpl
    });
    exitCode = result.exitCode;
    timedOut = result.timedOut;
    stderrTail = result.stderrTail;
    usage = extractUsage(result.stdout);
    errorMessage = result.error?.message || "";

    try {
      lastMessage = await fs.readFile(lastMessagePath, "utf8");
    } catch {
      lastMessage = "";
    }
  } catch (error) {
    exitCode = 1;
    errorMessage = error?.message || String(error);
  } finally {
    await fs.rm(lastMessagePath, { force: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    appendTurnRecordImpl({
      taskId,
      turn,
      kind: "codex-exec",
      agent: "codex",
      prompt,
      output: lastMessage,
      meta: {
        usage,
        exitCode,
        timedOut,
        stderrTail,
        ...(errorMessage ? { error: errorMessage } : {})
      },
      rootDir
    });
  }

  return {
    ok: exitCode === 0 && !timedOut,
    lastMessage,
    usage,
    exitCode,
    timedOut
  };
}
