/**
 * turn-log.test.mjs — 飞行记录仪单元测试
 *
 * 全程使用临时目录，不写真实的 ~/.claude 目录。
 * node:test 风格，参考现有测试结构。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendTurnRecord,
  readTurnRecords,
  getTurnLogDir
} from "./turn-log.mjs";

// ---------- 测试用临时目录 ----------

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-log-test-"));
});

after(() => {
  // 清理临时目录
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 帮助函数：生成一个带 rootDir 的选项对象
function opts() {
  return { rootDir: tmpRoot };
}

// ---------- getTurnLogDir ----------

test("getTurnLogDir 返回正确路径", () => {
  const dir = getTurnLogDir("my-task-001", opts());
  const expected = path.join(tmpRoot, "my-task-001");
  assert.equal(dir, expected);
});

test("getTurnLogDir 对 taskId 做 slug 清洗", () => {
  const dir = getTurnLogDir("My Task!! 2024", opts());
  // 空格和感叹号应被替换为 -
  assert.ok(dir.includes("my-task"), `期望 slug 包含 my-task，实际：${path.basename(dir)}`);
  // 不应含原始特殊字符
  assert.ok(!path.basename(dir).includes(" "), "不应含空格");
  assert.ok(!path.basename(dir).includes("!"), "不应含感叹号");
});

// ---------- appendTurnRecord 必填校验 ----------

test("appendTurnRecord: 缺 taskId 时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ turn: 0, kind: "plan", agent: "claude", ...opts() }),
    /taskId/
  );
});

test("appendTurnRecord: taskId 为空字符串时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "  ", turn: 0, kind: "plan", agent: "claude", ...opts() }),
    /taskId/
  );
});

test("appendTurnRecord: 缺 turn 时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "t1", kind: "plan", agent: "claude", ...opts() }),
    /turn/
  );
});

test("appendTurnRecord: turn 为非整数时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "t1", turn: 1.5, kind: "plan", agent: "claude", ...opts() }),
    /turn/
  );
});

test("appendTurnRecord: turn 为负数时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "t1", turn: -1, kind: "plan", agent: "claude", ...opts() }),
    /turn/
  );
});

test("appendTurnRecord: 缺 kind 时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "t1", turn: 0, agent: "claude", ...opts() }),
    /kind/
  );
});

test("appendTurnRecord: 缺 agent 时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "t1", turn: 0, kind: "plan", ...opts() }),
    /agent/
  );
});

// ---------- taskId 路径穿越检测 ----------

test("appendTurnRecord: taskId 含 .. 时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "../evil", turn: 0, kind: "plan", agent: "claude", ...opts() }),
    /穿越|taskId/i
  );
});

test("appendTurnRecord: taskId 含正斜杠时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "a/b", turn: 0, kind: "plan", agent: "claude", ...opts() }),
    /穿越|taskId/i
  );
});

test("appendTurnRecord: taskId 含反斜杠时抛错", () => {
  assert.throws(
    () => appendTurnRecord({ taskId: "a\\b", turn: 0, kind: "plan", agent: "claude", ...opts() }),
    /穿越|taskId/i
  );
});

test("getTurnLogDir: taskId 含 .. 时抛错", () => {
  assert.throws(
    () => getTurnLogDir("../../etc/passwd", opts()),
    /穿越|taskId/i
  );
});

// ---------- 正常写入与读回 ----------

test("appendTurnRecord: 写入并读回完整记录", () => {
  const taskId = "write-read-test";
  const { record, filePath } = appendTurnRecord({
    taskId,
    turn: 0,
    kind: "plan",
    agent: "claude",
    prompt: "请规划一下",
    output: "步骤 1, 步骤 2",
    transition: { from: "idle", to: "planning" },
    costUsd: 0.001,
    meta: { model: "sonnet" },
    ...opts()
  });

  assert.ok(fs.existsSync(filePath), "文件应存在");
  assert.equal(record.taskId, taskId);
  assert.equal(record.turn, 0);
  assert.equal(record.kind, "plan");
  assert.equal(record.agent, "claude");
  assert.equal(record.prompt, "请规划一下");
  assert.equal(record.output, "步骤 1, 步骤 2");
  assert.deepEqual(record.transition, { from: "idle", to: "planning" });
  assert.equal(record.costUsd, 0.001);
  assert.deepEqual(record.meta, { model: "sonnet" });
  // 自动补 ts
  assert.ok(typeof record.ts === "string" && record.ts.length > 0, "应有 ts 字段");
  assert.ok(!isNaN(new Date(record.ts).getTime()), "ts 应为有效 ISO 时间");
});

test("appendTurnRecord: 仅必填字段也能写入", () => {
  const taskId = "minimal-record";
  const { record, filePath } = appendTurnRecord({
    taskId,
    turn: 1,
    kind: "exec",
    agent: "codex",
    ...opts()
  });

  assert.ok(fs.existsSync(filePath));
  assert.equal(record.taskId, taskId);
  assert.equal(record.agent, "codex");
  // 可选字段不应出现
  assert.equal("prompt" in record, false);
  assert.equal("output" in record, false);
});

// ---------- 文件命名格式 ----------

test("appendTurnRecord: 文件名含三位序号前缀", () => {
  const taskId = "naming-test";
  const { filePath } = appendTurnRecord({
    taskId,
    turn: 3,
    kind: "review",
    agent: "claude",
    ...opts()
  });
  const base = path.basename(filePath);
  assert.ok(base.startsWith("003-"), `文件名应以 003- 开头，实际：${base}`);
});

test("appendTurnRecord: turn=0 的文件名为 000-<kind>.json", () => {
  const taskId = "zero-turn-test";
  const { filePath } = appendTurnRecord({
    taskId,
    turn: 0,
    kind: "init",
    agent: "claude",
    ...opts()
  });
  const base = path.basename(filePath);
  assert.equal(base, "000-init.json");
});

// ---------- 同名不覆盖（追加后缀） ----------

test("appendTurnRecord: 同 taskId+turn+kind 写两次，第二次追加 -2 后缀", () => {
  const taskId = "no-overwrite-test";
  const common = { taskId, turn: 5, kind: "plan", agent: "claude", ...opts() };

  const { filePath: fp1 } = appendTurnRecord({ ...common });
  const { filePath: fp2 } = appendTurnRecord({ ...common });

  assert.notEqual(fp1, fp2, "两次写入路径不得相同");
  assert.ok(fs.existsSync(fp1), "第一次写入的文件应存在");
  assert.ok(fs.existsSync(fp2), "第二次写入的文件应存在");

  const base2 = path.basename(fp2);
  assert.ok(base2.includes("-2"), `第二次文件名应含 -2，实际：${base2}`);
});

test("appendTurnRecord: 写三次，后缀依次为无、-2、-3", () => {
  const taskId = "triple-write-test";
  const common = { taskId, turn: 7, kind: "output", agent: "codex", ...opts() };

  const { filePath: fp1 } = appendTurnRecord({ ...common });
  const { filePath: fp2 } = appendTurnRecord({ ...common });
  const { filePath: fp3 } = appendTurnRecord({ ...common });

  assert.ok(!path.basename(fp1).includes("-2") && !path.basename(fp1).includes("-3"), "第一次无后缀");
  assert.ok(path.basename(fp2).includes("-2"), "第二次含 -2");
  assert.ok(path.basename(fp3).includes("-3"), "第三次含 -3");
});

// ---------- readTurnRecords 排序 ----------

test("readTurnRecords: 按序号升序返回记录", () => {
  const taskId = "sort-test";
  const base = { taskId, agent: "claude", ...opts() };

  // 故意乱序写入
  appendTurnRecord({ ...base, turn: 2, kind: "exec" });
  appendTurnRecord({ ...base, turn: 0, kind: "init" });
  appendTurnRecord({ ...base, turn: 1, kind: "plan" });

  const { records, warnings } = readTurnRecords(taskId, opts());
  assert.equal(warnings.length, 0, "不应有警告");
  assert.equal(records.length, 3);
  assert.equal(records[0].turn, 0);
  assert.equal(records[1].turn, 1);
  assert.equal(records[2].turn, 2);
});

test("readTurnRecords: 任务目录不存在时返回空数组", () => {
  const { records, warnings } = readTurnRecords("nonexistent-task-xyz", opts());
  assert.equal(records.length, 0);
  assert.equal(warnings.length, 0);
});

// ---------- 坏 JSON 容忍 ----------

test("readTurnRecords: 坏 JSON 文件被跳过并报告在 warnings 里", () => {
  const taskId = "bad-json-test";
  const base = { taskId, agent: "claude", ...opts() };

  // 写两条正常记录
  appendTurnRecord({ ...base, turn: 0, kind: "init" });
  appendTurnRecord({ ...base, turn: 2, kind: "exec" });

  // 手动写入一个坏 JSON 文件
  const dir = getTurnLogDir(taskId, opts());
  const badFile = path.join(dir, "001-bad.json");
  fs.writeFileSync(badFile, "{ this is not valid json }", "utf8");

  const { records, warnings } = readTurnRecords(taskId, opts());

  assert.equal(records.length, 2, "应读回 2 条有效记录");
  assert.equal(warnings.length, 1, "应有 1 条警告");
  assert.ok(warnings[0].includes("001-bad.json"), `警告应提及坏文件名，实际：${warnings[0]}`);
});

// ---------- 多任务隔离 ----------

test("readTurnRecords: 不同 taskId 的记录互不干扰", () => {
  const base = { agent: "claude", kind: "plan", ...opts() };

  appendTurnRecord({ ...base, taskId: "task-alpha", turn: 0 });
  appendTurnRecord({ ...base, taskId: "task-alpha", turn: 1 });
  appendTurnRecord({ ...base, taskId: "task-beta", turn: 0 });

  const alpha = readTurnRecords("task-alpha", opts());
  const beta = readTurnRecords("task-beta", opts());

  assert.equal(alpha.records.length, 2, "alpha 应有 2 条");
  assert.equal(beta.records.length, 1, "beta 应有 1 条");
});
