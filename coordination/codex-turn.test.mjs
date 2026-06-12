import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { runCodexTurn } from "./codex-turn.mjs";
import { getTurnLogDir, readTurnRecords } from "./turn-log.mjs";

function makeTempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-test-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeFakeCodex(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const scriptPath = path.join(dir, "fake.mjs");
  const payload = JSON.stringify(config);

  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const config = ${payload};
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : "";
if (config.writeOutput !== false && outputFile) {
  fs.writeFileSync(outputFile, config.lastMessage || "", "utf8");
}
for (const line of config.stdoutLines || []) {
  process.stdout.write(typeof line === "string" ? line + "\\n" : JSON.stringify(line) + "\\n");
}
process.exit(config.exitCode ?? 0);
`,
    "utf8"
  );

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return [process.execPath, scriptPath];
}

test("runCodexTurn 成功解析 usage 并写入留痕", async t => {
  const rootDir = makeTempRoot(t);
  const codexBin = makeFakeCodex(t, {
    lastMessage: "本轮执行完成",
    stdoutLines: [
      "not-json",
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 3,
          output_tokens: 7,
          reasoning_output_tokens: 2
        }
      }
    ],
    exitCode: 0
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请执行任务",
    taskId: "issue-1",
    turn: 4,
    codexBin,
    rootDir
  });

  assert.deepEqual(result, {
    ok: true,
    lastMessage: "本轮执行完成",
    usage: {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
      reasoning_output_tokens: 2
    },
    exitCode: 0
  });

  const logDir = getTurnLogDir("issue-1", { rootDir });
  assert.ok(fs.existsSync(logDir), "应写入任务日志目录");

  const { records, warnings } = readTurnRecords("issue-1", { rootDir });
  assert.equal(warnings.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "codex-exec");
  assert.equal(records[0].agent, "codex");
  assert.equal(records[0].prompt, "请执行任务");
  assert.equal(records[0].output, "本轮执行完成");
  assert.deepEqual(records[0].meta, {
    usage: {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
      reasoning_output_tokens: 2
    },
    exitCode: 0
  });
});

test("runCodexTurn 非零退出码返回 ok=false，usage 缺失时保持空对象", async t => {
  const rootDir = makeTempRoot(t);
  const codexBin = makeFakeCodex(t, {
    lastMessage: "执行失败",
    stdoutLines: [{ type: "turn.completed", usage: { output_tokens: "bad" } }],
    exitCode: 7
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请执行失败场景",
    taskId: "issue-1-fail",
    turn: 5,
    codexBin,
    rootDir
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.lastMessage, "执行失败");
  assert.deepEqual(result.usage, {});

  const { records } = readTurnRecords("issue-1-fail", { rootDir });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].meta, { usage: {}, exitCode: 7 });
});

test("runCodexTurn output 文件缺失时返回空字符串，部分 usage 可宽容解析", async t => {
  const rootDir = makeTempRoot(t);
  const codexBin = makeFakeCodex(t, {
    writeOutput: false,
    stdoutLines: [
      "{bad json",
      {
        type: "turn.completed",
        usage: {
          input_tokens: 21,
          output_tokens: 8
        }
      }
    ],
    exitCode: 0
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请测试缺失输出文件",
    taskId: "issue-1-missing-output",
    turn: 6,
    codexBin,
    rootDir
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastMessage, "");
  assert.deepEqual(result.usage, {
    input_tokens: 21,
    output_tokens: 8
  });

  const { records } = readTurnRecords("issue-1-missing-output", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].output, "");
  assert.deepEqual(records[0].meta, {
    usage: {
      input_tokens: 21,
      output_tokens: 8
    },
    exitCode: 0
  });
});
