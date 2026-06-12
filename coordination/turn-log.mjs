/**
 * turn-log.mjs — 飞行记录仪存储层（evolve-I）
 *
 * 自主轮次的完整留痕 API：
 *   appendTurnRecord  — 写入单条轮次记录到 JSON 文件
 *   readTurnRecords   — 读取某任务全部记录（按序号排序）
 *   getTurnLogDir     — 返回任务日志目录路径
 *
 * 零依赖其他业务文件，只用 node 内置模块。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------- 路径工具 ----------

/**
 * 获取 turn-logs 根目录（可通过 rootDir 参数覆盖，用于测试）。
 * 默认：~/.claude/coordination/turn-logs
 * @param {string} [rootDir]
 * @returns {string}
 */
function getTurnLogsRoot(rootDir) {
  return rootDir || path.join(os.homedir(), ".claude", "coordination", "turn-logs");
}

/**
 * 将 taskId 清洗为安全的目录名（slug）。
 * - 只保留字母、数字、中文、连字符、下划线
 * - 去掉首尾 - / _
 * - 截断到 80 字符
 * - 禁止空字符串、.. 和路径分隔符
 *
 * @param {string} taskId
 * @returns {string}  清洗后的 slug
 * @throws {Error}    如果清洗结果不安全
 */
function slugifyTaskId(taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("taskId 不得为空");
  }

  // 路径穿越检测：原始值里禁止出现 .. 或路径分隔符
  if (taskId.includes("..") || taskId.includes("/") || taskId.includes("\\")) {
    throw new Error(`taskId 含有路径穿越字符：${taskId}`);
  }

  const slug = String(taskId)
    .toLowerCase()
    .replace(/[^a-z0-9一-龥_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);

  if (!slug) {
    throw new Error(`taskId 清洗后为空：${taskId}`);
  }

  // 双重保险：清洗后仍不应含分隔符或 ..
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new Error(`taskId slug 仍含非法字符：${slug}`);
  }

  return slug;
}

// ---------- 公开 API ----------

/**
 * 返回任务的日志目录路径（供测试与调用方使用）。
 *
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.rootDir]  覆盖根目录（测试用）
 * @returns {string}
 */
export function getTurnLogDir(taskId, { rootDir } = {}) {
  const slug = slugifyTaskId(taskId);
  return path.join(getTurnLogsRoot(rootDir), slug);
}

/**
 * 写入一条轮次记录。
 *
 * 必填字段：taskId, turn, kind, agent
 * 可选字段：prompt, output, transition, costUsd, meta
 * 自动补：ts（ISO 时间戳）
 *
 * 文件命名：<三位序号>-<kind>.json
 * 如果文件已存在，则追加 -2、-3 … 后缀，永不覆盖。
 *
 * @param {object} record
 * @param {string} record.taskId
 * @param {number} record.turn
 * @param {string} record.kind
 * @param {string} record.agent
 * @param {string} [record.prompt]
 * @param {string} [record.output]
 * @param {object} [record.transition]
 * @param {number} [record.costUsd]
 * @param {object} [record.meta]
 * @param {string} [record.rootDir]   覆盖根目录（测试用）
 * @returns {{ filePath: string, record: object }}
 */
export function appendTurnRecord({
  taskId,
  turn,
  kind,
  agent,
  prompt,
  output,
  transition,
  costUsd,
  meta,
  rootDir
}) {
  // ---- 必填校验 ----
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("appendTurnRecord: taskId 为必填字段且不得为空");
  }
  if (turn === undefined || turn === null || typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) {
    throw new Error("appendTurnRecord: turn 为必填字段，须为非负整数");
  }
  if (typeof kind !== "string" || !kind.trim()) {
    throw new Error("appendTurnRecord: kind 为必填字段且不得为空");
  }
  if (typeof agent !== "string" || !agent.trim()) {
    throw new Error("appendTurnRecord: agent 为必填字段且不得为空");
  }

  // ---- 构建记录 ----
  const ts = new Date().toISOString();
  const fullRecord = { taskId, turn, kind, agent, ts };
  if (prompt !== undefined) fullRecord.prompt = prompt;
  if (output !== undefined) fullRecord.output = output;
  if (transition !== undefined) fullRecord.transition = transition;
  if (costUsd !== undefined) fullRecord.costUsd = costUsd;
  if (meta !== undefined) fullRecord.meta = meta;

  // ---- 确定文件路径 ----
  const dir = getTurnLogDir(taskId, { rootDir });
  fs.mkdirSync(dir, { recursive: true });

  const turnStr = String(turn).padStart(3, "0");
  // kind 中的特殊字符清洗（防止文件名问题）
  const safeKind = kind.replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "") || "record";
  const baseName = `${turnStr}-${safeKind}`;

  let filePath = path.join(dir, `${baseName}.json`);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${baseName}-${suffix}.json`);
    suffix++;
  }

  // ---- 写入 ----
  fs.writeFileSync(filePath, JSON.stringify(fullRecord, null, 2), "utf8");

  return { filePath, record: fullRecord };
}

/**
 * 读取某任务的全部轮次记录，按序号（文件名）排序。
 *
 * 容忍坏 JSON：跳过解析失败的文件，并在 warnings 数组里报告。
 *
 * @param {string} taskId
 * @param {object} [opts]
 * @param {string} [opts.rootDir]  覆盖根目录（测试用）
 * @returns {{ records: object[], warnings: string[] }}
 */
export function readTurnRecords(taskId, { rootDir } = {}) {
  const dir = getTurnLogDir(taskId, { rootDir });
  const records = [];
  const warnings = [];

  if (!fs.existsSync(dir)) {
    return { records, warnings };
  }

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch (err) {
    warnings.push(`无法读取目录 ${dir}: ${err.message}`);
    return { records, warnings };
  }

  // 按文件名字典序排序（文件名以三位序号开头，确保顺序正确）
  files.sort();

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      records.push(JSON.parse(raw));
    } catch (err) {
      warnings.push(`跳过坏文件 ${file}: ${err.message}`);
    }
  }

  return { records, warnings };
}
