import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EventEmitter } from "node:events";
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

function makeSpawnStub(config, calls = []) {
  return (command, args) => {
    if (config.throwOnSpawn) {
      throw config.throwOnSpawn;
    }

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdinChunks = [];
    child.stdin = {
      write(chunk) {
        stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) {
          this.write(chunk);
        }
      }
    };

    calls.push({ command, args, stdinChunks });

    let closed = false;
    let timer = null;

    const closeChild = (code, signal) => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.emit("close", code, signal);
    };

    child.kill = () => {
      closeChild(config.killCode ?? null, config.killSignal ?? "SIGTERM");
      return true;
    };

    process.nextTick(() => {
      const outputIndex = args.indexOf("--output-last-message");
      const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : "";

      if (config.argvFile) {
        fs.writeFileSync(config.argvFile, JSON.stringify(args, null, 2), "utf8");
      }
      if (config.writeOutput !== false && outputFile) {
        fs.writeFileSync(outputFile, config.lastMessage || "", "utf8");
      }
      for (const line of config.stdoutLines || []) {
        child.stdout.emit("data", typeof line === "string" ? `${line}\n` : `${JSON.stringify(line)}\n`);
      }
      for (const chunk of config.stderrChunks || []) {
        child.stderr.emit("data", chunk);
      }

      if (config.close === false) {
        return;
      }

      if (config.delayMs) {
        timer = setTimeout(() => {
          closeChild(config.exitCode ?? 0, null);
        }, config.delayMs);
        return;
      }

      closeChild(config.exitCode ?? 0, null);
    });

    return child;
  };
}

test("runCodexTurn 成功解析 usage 并写入留痕", async t => {
  const rootDir = makeTempRoot(t);
  const spawnImpl = makeSpawnStub({
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
    codexBin: ["mock-codex"],
    rootDir,
    spawnImpl
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
    exitCode: 0,
    timedOut: false
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
    exitCode: 0,
    timedOut: false,
    stderrTail: ""
  });
});

test("runCodexTurn 非零退出码返回 ok=false，usage 缺失时保持空对象", async t => {
  const rootDir = makeTempRoot(t);
  const spawnImpl = makeSpawnStub({
    lastMessage: "执行失败",
    stdoutLines: [{ type: "turn.completed", usage: { output_tokens: "bad" } }],
    exitCode: 7
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请执行失败场景",
    taskId: "issue-1-fail",
    turn: 5,
    codexBin: ["mock-codex"],
    rootDir,
    spawnImpl
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.lastMessage, "执行失败");
  assert.deepEqual(result.usage, {});
  assert.equal(result.timedOut, false);

  const { records } = readTurnRecords("issue-1-fail", { rootDir });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].meta, {
    usage: {},
    exitCode: 7,
    timedOut: false,
    stderrTail: ""
  });
});

test("runCodexTurn output 文件缺失时返回空字符串，部分 usage 可宽容解析", async t => {
  const rootDir = makeTempRoot(t);
  const spawnImpl = makeSpawnStub({
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
    codexBin: ["mock-codex"],
    rootDir,
    spawnImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastMessage, "");
  assert.deepEqual(result.usage, {
    input_tokens: 21,
    output_tokens: 8
  });
  assert.equal(result.timedOut, false);

  const { records } = readTurnRecords("issue-1-missing-output", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].output, "");
  assert.deepEqual(records[0].meta, {
    usage: {
      input_tokens: 21,
      output_tokens: 8
    },
    exitCode: 0,
    timedOut: false,
    stderrTail: ""
  });
});

test("runCodexTurn 会持续消费 stderr，超大错误输出也不会挂起", async t => {
  const rootDir = makeTempRoot(t);
  const spawnImpl = makeSpawnStub({
    lastMessage: "stderr 已排空",
    stdoutLines: [{ type: "turn.completed", usage: { output_tokens: 5 } }],
    stderrChunks: ["ERRBLOCK-".repeat(150000)],
    exitCode: 0
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请处理大体积 stderr",
    taskId: "issue-1-big-stderr",
    turn: 7,
    codexBin: ["mock-codex"],
    rootDir,
    timeoutMs: 5000,
    spawnImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.lastMessage, "stderr 已排空");

  const { records } = readTurnRecords("issue-1-big-stderr", { rootDir });
  assert.equal(records.length, 1);
  assert.match(records[0].meta.stderrTail, /ERRBLOCK/);
  assert.ok(Buffer.byteLength(records[0].meta.stderrTail, "utf8") <= 16384);
});

test("runCodexTurn 超时后会终止子进程并留下超时留痕", async t => {
  const rootDir = makeTempRoot(t);
  const spawnImpl = makeSpawnStub({
    stdoutLines: [{ type: "turn.completed", usage: { input_tokens: 1 } }],
    delayMs: 1000,
    exitCode: 0
  });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请触发超时",
    taskId: "issue-1-timeout",
    turn: 8,
    codexBin: ["mock-codex"],
    rootDir,
    timeoutMs: 50,
    spawnImpl
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 1);

  const { records } = readTurnRecords("issue-1-timeout", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.timedOut, true);
});

test("runCodexTurn 在子进程同步抛错时也会留下失败记录", async t => {
  const rootDir = makeTempRoot(t);
  const error = new Error("spawn invalid");
  error.code = "EINVAL";
  const spawnImpl = makeSpawnStub({ throwOnSpawn: error });

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请模拟同步抛错",
    taskId: "issue-1-spawn-throw",
    turn: 9,
    codexBin: "codex",
    rootDir,
    spawnImpl
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);

  const { records } = readTurnRecords("issue-1-spawn-throw", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.error, "spawn invalid");
});

test("runCodexTurn 在命令配置非法时也会留下失败记录", async t => {
  const rootDir = makeTempRoot(t);

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请模拟非法命令配置",
    taskId: "issue-1-invalid-bin",
    turn: 12,
    codexBin: [],
    rootDir
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);

  const { records } = readTurnRecords("issue-1-invalid-bin", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.error, "codexBin 数组不得为空");
});

test("runCodexTurn 在 win32 下会把字符串 codexBin 包装成 cmd /c", async t => {
  const rootDir = makeTempRoot(t);
  const calls = [];
  const spawnImpl = makeSpawnStub({}, calls);

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请测试 Windows 包装",
    taskId: "issue-1-win32-wrapper",
    turn: 10,
    codexBin: "codex",
    rootDir,
    platform: "win32",
    spawnImpl
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cmd");
  assert.equal(calls[0].args[0], "/c");
  assert.equal(calls[0].args[1], "codex");
});

test("runCodexTurn 传给 codex 的命令参数形态符合约束", async t => {
  const rootDir = makeTempRoot(t);
  const argvFile = path.join(makeTempRoot(t), "argv.json");
  const spawnImpl = makeSpawnStub({
    argvFile,
    stdoutLines: [{ type: "turn.completed", usage: {} }],
    exitCode: 0
  });

  await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt: "请记录命令参数",
    taskId: "issue-1-argv-shape",
    turn: 11,
    codexBin: ["mock-codex"],
    rootDir,
    spawnImpl
  });

  const args = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("-C"));
  assert.ok(args.includes("C:/fake/worktree"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("--output-last-message"));
  assert.ok(args.includes("-"));
  assert.equal(args.includes("--ask-for-approval"), false);
  assert.equal(args.includes("请记录命令参数"), false);
});

test("runCodexTurn 会通过 stdin 原样传递 prompt，且命令行不携带注入载荷", async t => {
  const rootDir = makeTempRoot(t);
  const calls = [];
  const prompt = "hello\" & echo INJECTED & echo \"\n第二行含%变量%和^尖号";
  const spawnImpl = makeSpawnStub(
    {
      stdoutLines: [{ type: "turn.completed", usage: { output_tokens: 1 } }],
      exitCode: 0
    },
    calls
  );

  const result = await runCodexTurn({
    worktree: "C:/fake/worktree",
    prompt,
    taskId: "issue-1-stdin-prompt",
    turn: 13,
    codexBin: ["mock-codex"],
    rootDir,
    spawnImpl
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdinChunks.join(""), prompt);
  assert.equal(calls[0].args.includes(prompt), false);
  assert.equal(calls[0].args.some(arg => String(arg).includes("INJECTED")), false);
  assert.equal(calls[0].args.some(arg => String(arg).includes("%变量%")), false);

  const { records } = readTurnRecords("issue-1-stdin-prompt", { rootDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].prompt, prompt);
});

test("runCodexTurn 在 win32 + 字符串 codexBin 时，路径参数含元字符会拒绝执行并留痕", async t => {
  const rootDir = makeTempRoot(t);
  const calls = [];
  const spawnImpl = makeSpawnStub({}, calls);

  const result = await runCodexTurn({
    worktree: "C:/bad&(worktree)",
    prompt: "不会真正执行",
    taskId: "issue-1-win32-danger-path",
    turn: 14,
    codexBin: "codex",
    rootDir,
    platform: "win32",
    spawnImpl
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 0);

  const { records } = readTurnRecords("issue-1-win32-danger-path", { rootDir });
  assert.equal(records.length, 1);
  assert.match(records[0].meta.error, /危险元字符/);
});
