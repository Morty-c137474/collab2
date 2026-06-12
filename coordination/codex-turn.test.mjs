import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCodexTurn } from "./codex-turn.mjs";
import { readTurnRecords } from "./turn-log.mjs";

let tmpRoot;
let originalHome;
let fakeBin;
let argsFile;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(tmpRoot, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });

  argsFile = path.join(tmpRoot, "args.json");
  fakeBin = path.join(tmpRoot, "fake-codex.js");
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args), "utf8");
const outIndex = args.indexOf("--output-last-message");
const lastMessagePath = outIndex >= 0 ? args[outIndex + 1] : "";
if (lastMessagePath) {
  fs.mkdirSync(require("node:path").dirname(lastMessagePath), { recursive: true });
  fs.writeFileSync(lastMessagePath, "final answer from codex\\n", "utf8");
}
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cached_input_tokens: 2,
    total_tokens: 20
  },
  message: "fallback from jsonl"
}) + "\\n");
process.exit(0);
`,
    "utf8"
  );
  fs.chmodSync(fakeBin, 0o755);
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("runCodexTurn 解析 JSONL usage 并写入 turn-log", async () => {
  process.env.FAKE_ARGS_FILE = argsFile;

  const result = await runCodexTurn({
    worktree: tmpRoot,
    prompt: "请总结这次任务",
    taskId: "codex-turn-test",
    turn: 4,
    codexBin: fakeBin
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.lastMessage, "final answer from codex");
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cachedInputTokens: 2,
    totalTokens: 20
  });

  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(args[0], "exec");
  assert.equal(args[1], "--json");
  assert.equal(args[2], "-C");
  assert.equal(args[3], tmpRoot);
  assert.equal(args[4], "--sandbox");
  assert.equal(args[5], "workspace-write");
  assert.equal(args[6], "--output-last-message");
  assert.ok(path.isAbsolute(args[7]), "last-message 路径应为绝对路径");
  assert.equal(path.basename(args[7]), "last-message.txt");
  assert.equal(args[8], "请总结这次任务");

  const { records, warnings } = readTurnRecords("codex-turn-test");
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "codex-exec");
  assert.deepEqual(records[0].meta.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cachedInputTokens: 2,
    totalTokens: 20
  });
});

test("runCodexTurn 没有 last-message 文件时回退 JSONL message", async () => {
  const fallbackBin = path.join(tmpRoot, "fake-codex-fallback.js");
  fs.writeFileSync(
    fallbackBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output-last-message");
const lastMessagePath = outIndex >= 0 ? args[outIndex + 1] : "";
if (lastMessagePath) {
  fs.rmSync(lastMessagePath, { force: true });
}
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, totalTokens: 6 },
  output: "jsonl fallback message"
}) + "\\n");
process.exit(0);
`,
    "utf8"
  );
  fs.chmodSync(fallbackBin, 0o755);

  const result = await runCodexTurn({
    worktree: tmpRoot,
    prompt: "再来一次",
    taskId: "codex-turn-fallback",
    turn: 1,
    codexBin: fallbackBin
  });

  assert.equal(result.lastMessage, "jsonl fallback message");
  assert.deepEqual(result.usage, {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 3,
    totalTokens: 6
  });

  const { records, warnings } = readTurnRecords("codex-turn-fallback");
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "codex-exec");
  assert.deepEqual(records[0].meta.usage, {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 3,
    totalTokens: 6
  });
});
