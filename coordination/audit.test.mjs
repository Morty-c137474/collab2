import assert from "node:assert/strict";
import test from "node:test";

// 本测试只 import 纯裁判模块 audit.mjs，不触碰 coordinator-v2 的流水线。
// 目的：证明裁判逻辑可脱离 coordinator-v2 被任意调用方直接使用。
import {
  AGENTS,
  RISKS,
  assertObject,
  assertString,
  assertArray,
  pathMatchesScope,
  maxRisk,
  extractAgentStatusHint,
  validateTaskContract,
  validateContextPacket,
  validatePlanArtifact,
  validateReviewArtifact,
  validatePatchManifest,
  validateFinalReport,
  evaluateVerdict
} from "./audit.mjs";

// ---- 测试夹具：手工构造合法 JSON 对象（不依赖 coordinator-v2 的工厂函数）----

// 合法 task_contract 字面量。riskBudget.maxFilesChanged 是 evaluateVerdict 要读的字段，
// 必须带上；validateTaskContract 本身不校验 riskBudget。
function contract(overrides = {}) {
  return {
    v: 1,
    kind: "task_contract",
    taskId: "task-test",
    goal: "Build a coordinator-v2 context packet slice.",
    nonGoals: [],
    acceptance: ["context packet exists", "execution plan exists", "verdict is programmatic"],
    allowedPaths: ["coordination/", "docs/", "scripts/", ".gitignore"],
    forbiddenActions: ["force push", "modify remote"],
    riskBudget: { maxFilesChanged: 12, allowDelete: false, allowRemoteChange: false, allowDaemon: false },
    ...overrides
  };
}

// 合法 executor_attempts：claude 与 codex 各有一条带 source/errorCategory 的成功记录。
function executorAttempts() {
  return {
    v: 1,
    kind: "executor_attempts",
    taskId: "task-test",
    attempts: [
      { agent: "claude", source: "claude-cli", ok: true, model: "sonnet", errorCategory: "none" },
      { agent: "codex", source: "codex-exec", ok: true, model: "gpt-5.4", errorCategory: "none" }
    ]
  };
}

// 一份“全部硬证据齐全”的 artifacts —— verified_done 的基线。
function fullArtifacts(extra = {}) {
  return {
    executionPlan: { kind: "execution_plan" },
    contextPacket: { kind: "context_packet" },
    patchManifest: { kind: "patch_manifest" },
    finalReport: { kind: "final_report" },
    influenceRecord: { kind: "influence_record" },
    executorAttempts: executorAttempts(),
    ...extra
  };
}

// ---- evaluateVerdict 关键路径 ----

test("全部通过时判定 verified_done", () => {
  const verdict = evaluateVerdict({
    agentOutput: "Ready for verification\nCOLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test coordination/audit.test.mjs", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "verified_done");
  assert.equal(verdict.verified, true);
  assert.deepEqual(verdict.failures, []);
  // agent 自报状态被提取，但 trusted 恒为 false（裁判不信任自报）。
  assert.equal(verdict.agentStatus.hint, "done");
  assert.equal(verdict.agentStatus.trusted, false);
});

test("agent 降级 fallback（没真参与）判定失败，且不 verified", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts({
      agentSources: {
        requireClaude: true,
        requireCodex: true,
        claude: "claude-fallback", // 真实 claude 应为 claude-cli
        codex: "codex-exec"
      }
    }),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.equal(verdict.verified, false);
  assert.match(verdict.failures.join("\n"), /real Claude source missing/);
});

test("executor attempts 缺失时判定失败（agent 根本没参与的硬证据）", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: {
      executionPlan: { kind: "execution_plan" },
      contextPacket: { kind: "context_packet" },
      patchManifest: { kind: "patch_manifest" },
      finalReport: { kind: "final_report" },
      influenceRecord: { kind: "influence_record" }
      // 故意不带 executorAttempts
    },
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /executorAttempts artifact missing/);
});

test("某个 agent 的 executor 记录缺失时判定失败", () => {
  const onlyClaude = executorAttempts();
  onlyClaude.attempts = onlyClaude.attempts.filter(a => a.agent === "claude");
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts({ executorAttempts: onlyClaude }),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /executor attempt missing: codex/);
});

test("changed file 越界（scope 之外）判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs", ".git/config"], // .git/config 越界
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.equal(verdict.verified, false);
  assert.match(verdict.failures.join("\n"), /changed file outside contract scope: \.git\/config/);
});

test("超出风险预算 maxFilesChanged 判定失败", () => {
  const many = Array.from({ length: 13 }, (_, i) => `coordination/file-${i}.mjs`);
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: many, // 13 > maxFilesChanged(12)
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /changed files exceed risk budget: 13/);
});

test("测试未通过时判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test coordination/audit.test.mjs", result: "failed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /test not passed: node --test coordination\/audit\.test\.mjs/);
});

test("git workspace 脏时判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "All done\nCOLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: false },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /git workspace is dirty/);
});

test("在 main 分支判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "main", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /main branch is not allowed/);
});

test("进程超时判定 blocked", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: true },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "blocked");
  assert.match(verdict.failures.join("\n"), /process timed out/);
});

test("进程退出码非 0 判定 blocked", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 1, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "blocked");
  assert.match(verdict.failures.join("\n"), /process exit 1/);
});

test("isolated implementation 与 candidate review 不安全时判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "Looks done\nCOLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts({
      isolatedImplementation: { safe: false },
      candidatePatchReview: { verdict: "changes_requested", diffInspected: true }
    }),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /isolated implementation is not safe/);
  assert.match(verdict.failures.join("\n"), /candidate patch review is not approved/);
});

test("repair loop 未解决时判定失败", () => {
  const verdict = evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts({ repairReport: { status: "changes_requested" } }),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "needs_repair");
  assert.match(verdict.failures.join("\n"), /repair status is not approved/);
});

test("agent 自报 blocked 时即便检查全过也判定 blocked", () => {
  const verdict = evaluateVerdict({
    agentOutput: "I am stuck\nCOLLAB_STATUS: blocked",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [{ command: "node --test", result: "passed" }],
    artifacts: fullArtifacts(),
    changedFiles: ["coordination/coordinator-v2.mjs"],
    contract: contract()
  });

  assert.equal(verdict.result, "blocked");
  assert.equal(verdict.verified, false);
});

test("非法契约（缺 allowedPaths）直接抛错", () => {
  assert.throws(() => evaluateVerdict({
    agentOutput: "COLLAB_STATUS: done",
    processResult: { exitCode: 0, timedOut: false },
    git: { branch: "experiment/coordinator-v2", clean: true },
    tests: [],
    artifacts: fullArtifacts(),
    changedFiles: [],
    contract: contract({ allowedPaths: [] })
  }), /allowedPaths must not be empty/);
});

// ---- 迁入的纯判定 / 校验函数单元覆盖 ----

test("常量 AGENTS / RISKS 形状正确", () => {
  assert.ok(AGENTS.has("claude") && AGENTS.has("codex"));
  assert.equal(AGENTS.size, 2);
  assert.deepEqual(RISKS, ["L0", "L1", "L2", "L3"]);
});

test("pathMatchesScope 目录前缀与精确匹配", () => {
  const scopes = ["coordination/", "docs/", ".gitignore"];
  assert.equal(pathMatchesScope("coordination/audit.mjs", scopes), true);
  assert.equal(pathMatchesScope(".gitignore", scopes), true);
  assert.equal(pathMatchesScope(".git/config", scopes), false);
  // "coordination" 不应误匹配以 "coordination" 为前缀的同级路径
  assert.equal(pathMatchesScope("coordination-extra/x.mjs", scopes), false);
});

test("maxRisk 取最高等级，非法/空集合回落 L0", () => {
  assert.equal(maxRisk(["L0", "L2", "L1"]), "L2");
  assert.equal(maxRisk(["L3"]), "L3");
  assert.equal(maxRisk([]), "L0");
  assert.equal(maxRisk(["bogus"]), "L0");
});

test("extractAgentStatusHint 只看最后一行且永不信任", () => {
  const hint = extractAgentStatusHint("Example: COLLAB_STATUS: done\nActually continue\nCOLLAB_STATUS: continue");
  assert.equal(hint.hint, "continue");
  assert.equal(hint.source, "final_line");
  assert.equal(hint.trusted, false);

  const missing = extractAgentStatusHint("no status line here");
  assert.equal(missing.hint, "continue");
  assert.equal(missing.source, "missing");
});

test("assert 辅助函数对非法输入抛错", () => {
  assert.throws(() => assertObject(null, "x"), /must be an object/);
  assert.throws(() => assertObject([], "x"), /must be an object/);
  assert.throws(() => assertString("", "x"), /must be a non-empty string/);
  assert.throws(() => assertArray({}, "x"), /must be an array/);
  // 合法输入不抛错
  assert.doesNotThrow(() => assertObject({}, "x"));
  assert.doesNotThrow(() => assertString("ok", "x"));
  assert.doesNotThrow(() => assertArray([], "x"));
});

test("validateTaskContract 校验通过与失败路径", () => {
  assert.doesNotThrow(() => validateTaskContract(contract()));
  assert.throws(() => validateTaskContract(contract({ v: 2 })), /contract\.v must be 1/);
  assert.throws(() => validateTaskContract(contract({ kind: "x" })), /must be task_contract/);
});

test("validateContextPacket 拒绝完整消息池转储", () => {
  const base = {
    v: 1,
    kind: "context_packet",
    agent: "claude",
    role: "planner",
    allowedPaths: ["coordination/"],
    forbiddenActions: [],
    gitState: { branch: "experiment/coordinator-v2" },
    coordinatorFacts: [],
    untrustedAgentInputs: [],
    artifactSummaries: []
  };
  assert.doesNotThrow(() => validateContextPacket(base));
  assert.throws(() => validateContextPacket({
    ...base,
    untrustedAgentInputs: [{ content: "messages.jsonl full dump" }]
  }), /full message pool/);
});

test("validatePlanArtifact 在带契约时拒绝越界路径", () => {
  const plan = {
    v: 1,
    kind: "agent_plan",
    agent: "claude",
    taskId: "task-test",
    readOnly: true,
    summary: "plan",
    steps: [{ title: "bad", paths: [".git/config"], risk: "L1" }],
    risks: [],
    tests: []
  };
  assert.throws(() => validatePlanArtifact(plan, contract()), /plan step path outside contract scope/);
  // 不带契约时不校验 scope
  assert.doesNotThrow(() => validatePlanArtifact(plan));
});

test("validateReviewArtifact 校验 verdict 合法性", () => {
  const review = {
    v: 1,
    kind: "review_report",
    agent: "claude",
    taskId: "task-test",
    target: "x.json",
    verdict: "approve",
    blockingFindings: [],
    nonBlockingFindings: []
  };
  assert.doesNotThrow(() => validateReviewArtifact(review));
  assert.throws(() => validateReviewArtifact({ ...review, verdict: "bogus" }), /review\.verdict invalid/);
});

test("validatePatchManifest 校验必填字段", () => {
  const manifest = {
    v: 1,
    kind: "patch_manifest",
    taskId: "task-test",
    branch: "experiment/coordinator-v2",
    baseHead: "abc",
    head: "def",
    changedFiles: [],
    testsRun: []
  };
  assert.doesNotThrow(() => validatePatchManifest(manifest));
  assert.throws(() => validatePatchManifest({ ...manifest, branch: "" }), /patch\.branch/);
});

test("validateFinalReport 要求记录有效协作", () => {
  const report = {
    v: 1,
    kind: "final_report",
    taskId: "task-test",
    effectiveCollaboration: { occurred: true },
    artifacts: {}
  };
  assert.doesNotThrow(() => validateFinalReport(report));
  assert.throws(() => validateFinalReport({
    ...report,
    effectiveCollaboration: { occurred: false }
  }), /effective collaboration must be recorded/);
});
