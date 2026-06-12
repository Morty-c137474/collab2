import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCodexTurn } from "./codex-turn.mjs";
import { readTurnRecords } from "./turn-log.mjs";

let tmpRoot;
let fakeCodexBin;
let oldHome;

function withEnv(updates, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(updates)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-test-"));
  oldHome = process.env.HOME;
  process.env.HOME = path.join(tmpRoot, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });

  fakeCodexBin = path.join(tmpRoot, "fake-codex.js");
  fs.writeFileSync(
    fakeCodexBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_LOG) {
  fs.writeFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args), "utf8");
}
const outIdx = args.indexOf("--output-last-message");
if (outIdx >= 0 && args[outIdx + 1]) {
  fs.writeFileSync(args[outIdx + 1], process.env.FAKE_LAST_MESSAGE || "", "utf8");
}
for (const line of (process.env.FAKE_JSONL || "").split("\\n")) {
  if (line.trim()) process.stdout.write(line + "\\n");
}
process.exit(Number(process.env.FAKE_EXIT_CODE || 0));
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexBin, 0o755);
});

after(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("runCodexTurn: 按约定命令形态执行并返回 usage 与 lastMessage", () => {
  const argsLog = path.join(tmpRoot, "args-success.json");
  const jsonl = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2
      }
    })
  ].join("\n");

  const result = withEnv(
    {
      FAKE_ARGS_LOG: argsLog,
      FAKE_JSONL: jsonl,
      FAKE_LAST_MESSAGE: "codex done",
      FAKE_EXIT_CODE: "0"
    },
    () => runCodexTurn({
      worktree: tmpRoot,
      prompt: "请完成任务",
      taskId: "task-codex-success",
      turn: 1,
      codexBin: fakeCodexBin
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.lastMessage, "codex done");
  assert.deepEqual(result.usage, {
    input_tokens: 11,
    output_tokens: 7,
    cached_input_tokens: 3,
    reasoning_output_tokens: 2
  });

  const args = JSON.parse(fs.readFileSync(argsLog, "utf8"));
  assert.equal(args[0], "exec");
  assert.equal(args[1], "--json");
  assert.equal(args[2], "-C");
  assert.equal(args[3], tmpRoot);
  assert.equal(args[4], "--sandbox");
  assert.equal(args[5], "workspace-write");
  assert.equal(args[6], "--output-last-message");
  assert.equal(args.at(-1), "请完成任务");
  assert.equal(args.includes("--ask-for-approval"), false);

  const { records, warnings } = readTurnRecords("task-codex-success");
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "codex-exec");
  assert.deepEqual(records[0].meta.usage, result.usage);
});

test("runCodexTurn: 失败退出码也会留痕并回落 usage 四字段", () => {
  const result = withEnv(
    {
      FAKE_ARGS_LOG: path.join(tmpRoot, "args-failure.json"),
      FAKE_JSONL: JSON.stringify({ type: "turn.started" }),
      FAKE_LAST_MESSAGE: "failed output",
      FAKE_EXIT_CODE: "7"
    },
    () => runCodexTurn({
      worktree: tmpRoot,
      prompt: "这轮会失败",
      taskId: "task-codex-failure",
      turn: 2,
      codexBin: fakeCodexBin
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.lastMessage, "failed output");
  assert.deepEqual(result.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0
  });

  const { records, warnings } = readTurnRecords("task-codex-failure");
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "codex-exec");
  assert.equal(records[0].meta.exitCode, 7);
  assert.deepEqual(records[0].meta.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0
  });
});
