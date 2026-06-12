# 对话机 2 · 从零重建蓝图（2026-06-12）

> 约束：禁用 `claude -p`；最大化复用成熟设计。
> 依据：四路实证研究（Claude 运行时 / Codex 运行时 / 现成编排器 / GitHub 流水线），
> 全部结论基于 2026-06 官方文档与仓库现状查证，非记忆。

## 核心结论

**一代的错误不是愿景，是把"账本、闸门、调度"全部自建。二代把它们换成三个成熟层，自写代码缩到 300-500 行胶水。**

```
┌─ GitHub ──────────── 账本与闸门（Issues 契约 / draft PR 生命周期 / Actions 审计公证 / branch protection 人闸）
├─ Claude Code 长驻会话 ─ 协调大脑 + Claude 侧执行器（/goal、Stop hook、Monitor、subagent）
├─ codex exec --json ──── Codex 侧执行器（worktree + 沙箱 + 无人值守）
└─ 本地池（保留）────── 低延迟 chatter（GitHub 只当异步收敛点）
```

## 一、claude -p 禁令怎么消解：架构反转

研究证实：**Agent SDK 和 claude -p 是同一机制**（SDK 就是 headless 引擎的库封装，官方原文 "Same capabilities, different interface"）。所以禁令若禁机制，SDK 一并出局。真正干净的路径：

**不再"外部驱动两个 CLI"，而是"Claude 长驻交互会话当常驻协调者，从内部驱动 codex"。**

这是非对称架构，但恰好顺势：Codex 有成熟无头模式（exec），Claude 没有（可用的）——那就让 Claude 当大脑、Codex 当可呼叫的手。今天这个会话就是实证：我（交互会话）派 subagent 干活、验收、提交，全程没碰 claude -p。

Claude 会话的官方自驱原语（全部查证可用）：
- **/goal**（v2.1.139+）：设完成条件，每轮后小模型评估，未达成自动续轮——"通过机器审计才算完成"的官方原语；
- **Stop hook** `decision:block`：自写续轮循环（/goal 的底层机制）；
- **/loop + CronCreate**：会话内定时心跳（7 天过期需续期）；
- **Monitor 工具**：watch 池文件尾部，事件驱动免轮询——拉模式升级为推模式；
- **Agent tool / Agent Teams**（实验性）：Claude 侧内部并行；Teams 的 TaskCompleted hook（exit 2 阻止任务完成）是天然机器审计门；
- ~~升级路径~~ **已移入不做清单**（2026-06-13 裁决，见 decisions.md）：Channels / Routines / Agent SDK 订阅额度——方案全订阅化，不依赖 Agent SDK credit（2026-06-15 起按月度代金券计量，与 claude -p 同池）。

## 二、Codex 侧：三种接法

| 接法 | 用途 | 形态 |
|---|---|---|
| `codex exec --json` | 干活轮（主力） | `codex exec --json -C <worktree> --sandbox workspace-write --output-last-message <file>`（exec 即非交互，0.121+ 无 --ask-for-approval 参数） |
| `codex exec review` | Codex 本地评审轮 | 对当前仓库跑代码评审，输出由胶水经 `gh pr review --comment` 落 PR |
| `@openai/codex-sdk` | Node 编排时平替 | 同一 CLI 的 spawn 封装，Thread/run API，免手写 JSONL 解析 |
| `codex mcp-server` | 辩论/紧耦合对话 | Claude Code 把 codex 注册为 MCP server，直接调 codex/codex-reply 工具 |

成本口径：订阅模式没有美元数，**统一记 token**（`turn.completed.usage` 四字段），双端口径天然对齐——一代"codex 成本恒 0"的问题就此消解。

## 三、GitHub = 账本与闸门（最大的复用）

研究证实这套用法已被 GitHub 官方主流化（Copilot coding agent / Agent HQ 同款模式）：

| 一代自建 | 二代复用 |
|---|---|
| roadmap.json + 任务状态 JSON | **Issue**（表单模板：背景/范围/验收标准）+ 30 行 contract-lint Action 补字段强制（API 创建可绕过表单校验，必须自查） |
| claim 消息 | `gh issue edit --add-assignee` + label |
| 状态机 phases | **draft PR → ready**（天然持久，走神免疫） |
| audit.mjs 本地裁判 | 本地预跑 + **Actions required check 公证复跑**（中立第三方，本地自跑自报是自我声明） |
| 交叉评审说话轮 | Claude 的 PR ← `@codex review`（云端，计 ChatGPT 订阅）或 `codex exec review`（本地）；Codex 的 PR ← Claude 长驻会话派**干净上下文 subagent** 评审（计 Max 交互额度）。~~claude-code-action~~ 已剔除（Agent SDK 机制，2026-06-13 裁决）——零 API key 不变 |
| 人类合并约定 | **branch protection + 双账号结构**（2026-06-13 修正）：AI 共用一个仅 Write 权限的机器账号，人类账号保留 owner。GitHub 规定 PR 作者不能自批 + AI 无 admin 角色无法绕过 → 唯一能 approve+merge 的就是你本人。⚠️ 原"共用人类账号 + 禁自批"方案有死结：单账号下无人有资格 approve，或 agent 持 admin token 可 `gh pr merge --admin` 绕过 |
| 保护路径（hooks/lib） | CODEOWNERS |
| viewer | GitHub UI（viewer 退役或保留极简版） |

前提：**公开仓库**（branch protection 免费 + Actions 分钟免费）或 $4/月 Pro 私有。

**网络抖动应对**（今日新情报：本机有 127.0.0.1:7897 代理，设 HTTPS_PROXY 后 gh 正常——根因疑似代理未一致应用到 git）：
1. git 配置代理或走 `ssh.github.com:443`；
2. 架构上仍坚持本地优先：测试/审计本地先跑，GitHub 只做公证复跑；所有 gh 调用幂等 + 指数退避；
3. **绝不**用 self-hosted runner（公开仓库≈自杀）或 cron 云触发本地；心跳全在本地。

## 四、现成编排器的裁决（为什么不整套采用）

- **vibe-kanban**：功能匹配度最高（看板+worktree+diff 评审+MCP/REST，双 CLI 一视同仁），**但母公司 Bloop 2026-04 关停、项目 sunsetting**，社区接管未兑现。只当可选 UI，锁 v0.1.44，不当地基。
- **Gas Town + beads**（Yegge）：最活跃的全流程项目（认领→隔离→合并队列），beads 是成熟的 agent 任务状态机（24.5k stars）。但 Claude Code 中心、Windows 二等、生态剧变中（Gas City）。**beads 可单独评估**替代任务状态层；Gas Town 先观察。
- claude-squad（要 WSL）、Conductor（Mac-only）、container-use（半休眠）、LangGraph/CrewAI（编排外部 CLI = 杀鸡用牛刀）——全部排除。
- **没有任何现成工具内置"机器审计门 + 交叉评审"流水线**——这层永远要自写，而我们已经写好了（audit.mjs）。

## 五、新仓库形态

```
collab2/
├── CLAUDE.md / AGENTS.md         # 双端人格与规则（一代经验：保持极简+渐进披露）
├── .github/
│   ├── ISSUE_TEMPLATE/task.yml   # 任务契约表单
│   └── workflows/
│       ├── audit.yml             # PR: 测试 + audit.mjs → required check
│       └── contract-lint.yml     # issue 结构校验 → ready label
├── coordination/
│   ├── audit.mjs + audit.test.mjs    # 一代直接移植（裁判资产）
│   ├── turn-log.mjs + 测试            # 一代直接移植（飞行记录仪）
│   ├── codex-turn.mjs                # codex exec 封装 + token 记账（~120 行，新写）
│   └── pool/（沿用一代池或精简）       # 本地 chatter；等 Channels 毕业后官方化
├── scripts/
│   └── morning-report.mjs            # 晨报：gh api 汇总待审 PR + turn-log（~80 行，新写）
└── docs/decisions.md                 # 一代决策日志平移，继续追加
```

自写总量 ≈ 300-500 行胶水 + 若干 prompt/goal 模板。**比一代已写的代码少一个数量级。**

## 六、生命周期走一遍（穿透示例）

1. 人（或 agent propose 后人批准）开 issue，表单强制验收标准 → contract-lint 打 ready；
2. Claude 会话认领（assignee+label），开 worktree + draft PR，实现 + 本地跑 audit；
3. 或者派 Codex：`codex exec -C <worktree>`，turn-log 记录 prompt/输出/usage；
4. `gh pr ready` → Actions 公证（测试 + audit.mjs）→ required check；
5. 交叉评审：Claude 的 PR 用 `@codex review`（或本地 `codex exec review`）；Codex 的 PR 由 Claude 会话派干净上下文 subagent 评，结论经 `gh pr review` 落 PR；分歧 → GLM API 仲裁（纯 HTTP 调用，无需 agent harness）；
6. 你点 merge（禁自批保证只有你能点）；
7. 晨报脚本每早汇总；每 10 个合并 PR 自动开一个回顾 issue（进化环照搬一代设计：变异/选择/记忆 + ≤20% 预算 + 指标变差回滚）。

## 七、照搬一代的决策（实现变了，裁决没变）

辩论协议（防互捧格式硬约束）/ GLM=不下场的裁判 / 玩具仓毕业制 / 不做清单（实时共改、自主合 main、模型自我优化幻想）/ 上下文工程规范（docs/context.md 整份平移）。

## 八、风险与开放问题

1. ~~订阅限流窗口共享~~ **已消解**（2026-06-13）：claude-code-action 剔除后，Claude 侧评审走会话内 subagent，全部计入交互额度，不再有 CI 挤占问题。
2. **Windows 原生 codex 沙箱**历史上弱于 macOS/Linux，落地先实测 `--sandbox workspace-write` 的实际约束力。
3. **实验性依赖**全部标记为升级路径而非地基（Channels/Teams/Routines/Agent SDK 额度）。
4. **代理问题先修**：git/gh 统一走 7897 代理或 ssh:443，这是 GitHub 层可靠性的前提。
5. Codex cloud review 会把仓库代码送 OpenAI 云端——公开仓库无所谓，敏感内容须评估。

## 九、启动顺序（一天可穿透）

1. 修代理（git+gh 统一配置，gh 须显式 HTTPS_PROXY）→ 建公开仓 + issue 模板 + branch protection + audit.yml；
2. 移植 audit.mjs / turn-log.mjs / decisions.md / context.md；
3. 注册机器账号（AI 共用，仅 Write 协作者）→ 开启 Require approvals(1)；可选接 Codex cloud review（chatgpt.com/codex 连仓库 + 开 Code review 开关）；
4. 写 codex-turn.mjs 胶水；
5. 手摇穿透第一个真任务（上面第六节流程），记摩擦清单；
6. 自动化：/goal 模板 + /loop 心跳 + Monitor watch 池。
