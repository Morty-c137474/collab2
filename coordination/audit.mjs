// audit.mjs —— coordinator-v2 的“裁判层”纯函数模块。
//
// 这里集中了 verdict / audit 逻辑：evaluateVerdict 核心裁决，以及它依赖的
// 一组纯判定 / 校验函数（契约、计划、评审、补丁清单、最终报告的 schema 校验，
// scope 匹配、风险聚合、agent 状态提示提取）。
//
// 设计约束（见 docs/autonomy.md “裁判层”与“核心裁决”第 1 条）：
//   - 纯函数：不依赖 coordinator-v2.mjs，不做任何 fs / process / spawn 副作用。
//   - 可脱离 coordinator-v2 的流水线被任何调用方使用（未来的 turn-wrapper 会调它）。
//   - 读盘的 loadRunAudit / loadRunStatus 之类留在 coordinator-v2.mjs。

// 合法 agent 名集合：协议只承认 claude 与 codex 两方。
export const AGENTS = new Set(["claude", "codex"]);
// 风险等级由低到高，maxRisk 用它做下标比较。
export const RISKS = ["L0", "L1", "L2", "L3"];
// agent 最终状态行的格式：COLLAB_STATUS: continue|done|blocked。
export const FINAL_STATUS_RE = /^COLLAB_STATUS:\s*(continue|done|blocked)\s*$/i;

export function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

export function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

export function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
}

// file 是否落在某个允许 scope 内：scope 以 "/" 结尾按前缀匹配目录，
// 否则要求完全相等或作为该路径下的子项（避免 "coordination" 误匹配 "coordination-x"）。
export function pathMatchesScope(file, scopes) {
  return scopes.some(scope => {
    if (scope.endsWith("/")) return file.startsWith(scope);
    return file === scope || file.startsWith(`${scope}/`);
  });
}

// 聚合一组风险等级，取最高的那一级；空集合或全部非法时回落到 L0。
export function maxRisk(risks) {
  const idx = Math.max(...risks.map(r => RISKS.indexOf(r)).filter(i => i >= 0), 0);
  return RISKS[idx];
}

// 从 agent 输出里抽取最终状态提示：只看最后一行是否匹配 COLLAB_STATUS。
// trusted 恒为 false —— 这是 agent 自报，裁判不能据此直接信任。
export function extractAgentStatusHint(output) {
  const lines = String(output || "").replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1) || "";
  const match = last.match(FINAL_STATUS_RE);
  return { hint: match ? match[1].toLowerCase() : "continue", source: match ? "final_line" : "missing", trusted: false };
}

export function validateTaskContract(contract) {
  assertObject(contract, "contract");
  if (contract.v !== 1) throw new Error("contract.v must be 1");
  if (contract.kind !== "task_contract") throw new Error("contract.kind must be task_contract");
  assertString(contract.taskId, "contract.taskId");
  assertString(contract.goal, "contract.goal");
  assertArray(contract.nonGoals, "contract.nonGoals");
  assertArray(contract.acceptance, "contract.acceptance");
  assertArray(contract.allowedPaths, "contract.allowedPaths");
  assertArray(contract.forbiddenActions, "contract.forbiddenActions");
  if (contract.allowedPaths.length === 0) throw new Error("contract.allowedPaths must not be empty");
  return contract;
}

export function validateContextPacket(packet) {
  assertObject(packet, "context packet");
  if (packet.v !== 1) throw new Error("context.v must be 1");
  if (packet.kind !== "context_packet") throw new Error("context.kind must be context_packet");
  if (!AGENTS.has(packet.agent)) throw new Error("context.agent must be claude or codex");
  assertString(packet.role, "context.role");
  assertArray(packet.allowedPaths, "context.allowedPaths");
  assertArray(packet.forbiddenActions, "context.forbiddenActions");
  assertObject(packet.gitState, "context.gitState");
  assertArray(packet.coordinatorFacts, "context.coordinatorFacts");
  assertArray(packet.untrustedAgentInputs, "context.untrustedAgentInputs");
  assertArray(packet.artifactSummaries, "context.artifactSummaries");
  if (packet.untrustedAgentInputs.some(x => String(x.content || x).includes("messages.jsonl full dump"))) {
    throw new Error("context packet must not contain full message pool dumps");
  }
  return packet;
}

export function validatePlanArtifact(plan, contract = null) {
  assertObject(plan, "plan");
  if (plan.v !== 1) throw new Error("plan.v must be 1");
  if (plan.kind !== "agent_plan") throw new Error("plan.kind must be agent_plan");
  if (!AGENTS.has(plan.agent)) throw new Error("plan.agent must be claude or codex");
  if (plan.readOnly !== true) throw new Error("plan.readOnly must be true");
  assertString(plan.taskId, "plan.taskId");
  assertString(plan.summary, "plan.summary");
  assertArray(plan.steps, "plan.steps");
  assertArray(plan.risks, "plan.risks");
  assertArray(plan.tests, "plan.tests");
  if (plan.steps.length === 0) throw new Error("plan.steps must not be empty");

  for (const [i, step] of plan.steps.entries()) {
    assertObject(step, `plan.steps[${i}]`);
    assertString(step.title, `plan.steps[${i}].title`);
    assertArray(step.paths, `plan.steps[${i}].paths`);
    if (!RISKS.includes(step.risk)) throw new Error(`plan.steps[${i}].risk must be L0-L3`);
    if (step.paths.length === 0) throw new Error(`plan.steps[${i}].paths must not be empty`);
    if (contract) {
      for (const file of step.paths) {
        if (!pathMatchesScope(file, contract.allowedPaths)) throw new Error(`plan step path outside contract scope: ${file}`);
      }
    }
  }
  return plan;
}

export function validateReviewArtifact(review) {
  assertObject(review, "review");
  if (review.v !== 1) throw new Error("review.v must be 1");
  if (review.kind !== "review_report") throw new Error("review.kind must be review_report");
  if (!AGENTS.has(review.agent)) throw new Error("review.agent must be claude or codex");
  if (!["approve", "changes_requested", "reject"].includes(review.verdict)) throw new Error("review.verdict invalid");
  assertString(review.taskId, "review.taskId");
  assertString(review.target, "review.target");
  assertArray(review.blockingFindings, "review.blockingFindings");
  assertArray(review.nonBlockingFindings, "review.nonBlockingFindings");
  return review;
}

export function validatePatchManifest(manifest) {
  assertObject(manifest, "patch manifest");
  if (manifest.v !== 1) throw new Error("patch.v must be 1");
  if (manifest.kind !== "patch_manifest") throw new Error("patch.kind must be patch_manifest");
  assertString(manifest.taskId, "patch.taskId");
  assertString(manifest.branch, "patch.branch");
  assertString(manifest.baseHead, "patch.baseHead");
  assertString(manifest.head, "patch.head");
  assertArray(manifest.changedFiles, "patch.changedFiles");
  assertArray(manifest.testsRun, "patch.testsRun");
  return manifest;
}

// 核心裁决：综合 agent 自报状态、进程结果、git 状态、产物完整性、
// 真实 agent 来源、scope/风险预算、测试结果，做出 verdict。
// 这是全仓库防“假完成”的硬审计层 —— 不信任 agent 自报，靠硬证据下结论。
export function evaluateVerdict({
  agentOutput = "",
  processResult = {},
  git = {},
  tests = [],
  artifacts = {},
  changedFiles = [],
  contract
}) {
  validateTaskContract(contract);
  const agentStatus = extractAgentStatusHint(agentOutput);
  const failures = [];

  if (processResult.timedOut) failures.push("process timed out");
  if (processResult.exitCode !== 0) failures.push(`process exit ${processResult.exitCode ?? "unknown"}`);
  if (!git.clean) failures.push("git workspace is dirty");
  if (git.branch === "main") failures.push("main branch is not allowed");
  if (git.remotesChanged) failures.push("git remotes changed");
  for (const required of ["executionPlan", "contextPacket", "patchManifest", "finalReport", "influenceRecord"]) {
    if (!artifacts[required]) failures.push(`${required} artifact missing`);
  }
  if (!artifacts.executorAttempts) failures.push("executorAttempts artifact missing");
  else {
    const attempts = Array.isArray(artifacts.executorAttempts.attempts) ? artifacts.executorAttempts.attempts : [];
    for (const agent of AGENTS) {
      const attempt = attempts.find(item => item.agent === agent);
      if (!attempt) failures.push(`executor attempt missing: ${agent}`);
      else if (!attempt.source || !attempt.errorCategory) failures.push(`executor attempt incomplete: ${agent}`);
      else if (attempt.ok === false && attempt.errorCategory === "none") failures.push(`executor failure lacks error category: ${agent}`);
    }
  }
  if (artifacts.workspaceIsolation && artifacts.workspaceIsolation.safe !== true) failures.push("workspace isolation is not safe");
  if (artifacts.isolatedImplementation && artifacts.isolatedImplementation.safe !== true) failures.push("isolated implementation is not safe");
  if (artifacts.candidatePatchReview && artifacts.candidatePatchReview.verdict !== "approve") failures.push("candidate patch review is not approved");
  if (artifacts.candidatePatchReview && artifacts.candidatePatchReview.diffInspected !== true) failures.push("candidate patch diff was not inspected");
  if (artifacts.repairReport && !["approved_after_repair", "approved_without_repair", "not_needed"].includes(artifacts.repairReport.status)) failures.push(`repair status is not approved: ${artifacts.repairReport.status}`);
  if (artifacts.agentSources) {
    if (artifacts.agentSources.requireClaude && artifacts.agentSources.claude !== "claude-cli") failures.push(`real Claude source missing: ${artifacts.agentSources.claude || "unknown"}`);
    if (artifacts.agentSources.requireCodex && artifacts.agentSources.codex !== "codex-exec") failures.push(`real Codex source missing: ${artifacts.agentSources.codex || "unknown"}`);
  }
  for (const file of changedFiles) {
    if (!pathMatchesScope(file, contract.allowedPaths)) failures.push(`changed file outside contract scope: ${file}`);
  }
  if (changedFiles.length > contract.riskBudget.maxFilesChanged) failures.push(`changed files exceed risk budget: ${changedFiles.length}`);
  for (const test of tests.filter(t => t.result !== "passed")) failures.push(`test not passed: ${test.command || "unknown"}`);

  let result = "continue";
  if (processResult.timedOut || processResult.exitCode !== 0) result = "blocked";
  else if (failures.length > 0) result = "needs_repair";
  else if (agentStatus.hint === "blocked") result = "blocked";
  else if (agentStatus.hint === "done") result = "verified_done";

  return { v: 1, kind: "verdict", result, agentStatus, failures, verified: result === "verified_done" };
}

export function validateFinalReport(report) {
  assertObject(report, "final report");
  if (report.v !== 1) throw new Error("finalReport.v must be 1");
  if (report.kind !== "final_report") throw new Error("finalReport.kind must be final_report");
  assertString(report.taskId, "finalReport.taskId");
  assertObject(report.effectiveCollaboration, "finalReport.effectiveCollaboration");
  if (!report.effectiveCollaboration.occurred) throw new Error("effective collaboration must be recorded");
  assertObject(report.artifacts, "finalReport.artifacts");
  return report;
}
