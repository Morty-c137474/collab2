# 上下文工程规范（2026-06-10 审计，自一代迁入）

> **二代状态**："现状审计"一节针对一代仓库（广播策略已在一代修复）；
> 第一原则、上下文组装预算表、工具/CLI 设计守则、验证优先级**直接适用于本仓库**。

> 依据 8 篇 Anthropic 工程文章对本项目做的上下文管理审计与规则沉淀：
> Effective context engineering for AI agents / How we built our multi-agent research system /
> Claude Code best practices / Building effective agents / Writing effective tools for agents /
> Context management（memory + context editing）/ Agent Skills / Building agents with the Claude Agent SDK。

## 第一原则

**注意力预算是稀缺资源。** 上下文越长，模型回忆越差（context rot）。
一切注入、广播、文档、工具输出的设计先问一句：
**"删掉这行会不会让 agent 犯错？不会就删。"**（最小高信号 token 集合）

## 现状审计

### 已对齐的（保持，别破坏）

| 本项目机制 | 对应官方模式 |
|---|---|
| CLAUDE.md 简短 + "改东西前查哪份文档"表 | 渐进式披露：常驻最小化，细则按需加载 |
| refs（`路径:行号`）+ content ≤500 | just-in-time 检索：传轻量标识符不传正文 |
| roadmap.json currentFocus + [CHECKPOINT] 留笺 | structured note-taking：上下文外持久笔记 |
| 注入 MAX_INJECT=5 上限 | 防注入膨胀 |
| collab-loop 末行 COLLAB_STATUS 锚定 | "agent 自然语言输出不当事实"（verdict gate） |

### 待修的（按收益排序，对应 evolve-N）

1. **广播 allowlist 漏 PowerShell（最大噪音源）**：`post-tool-use-shared.mjs` 的
   READ_ONLY_PATTERNS 没覆盖 Get-Process / Get-Service / Get-StartApps / Get-AppxPackage /
   Get-PSDrive / Start-Sleep / `py -c` 等，这些只读命令全被当作"值得广播"落池，
   池被工具回声淹没，注入的 5 条全是噪音。
   **修法（evolve-N1）：反转策略——只广播"写"**（Edit/Write/git commit/push 等），
   普通 Bash 一律不广播。宁可漏报，不可淹池。
2. **注入 footer 样板每次重复**：4 行"你可以这样回应"使用说明随每次注入出现，
   而该知识已在 CLAUDE.md 常驻。**修法（evolve-N2，吸收 evolve-B）**：footer 压成 1 行，
   叠加同 session / refs 相关性过滤。
3. **父目录 CLAUDE.md 污染**：外层 `Claude code/CLAUDE.md`（mcp-server、puppeteer、pdf 技能
   等约百行）与对话机无关，却被每个会话自动加载。**修法**：建议用户瘦身外层文件
   （需用户操作，本仓库管不到）。
4. **无决策日志**：架构裁决散落在对话历史里，新窗口会"好心"推翻已论证过的取舍。
   **修法（evolve-N3）**：`docs/decisions.md`，每条 ≤5 行（日期/裁决/理由/被拒的替代方案），
   合并任务时追加。
5. **checkpoint 缺文件清单**：Claude Code 自动 compaction 会保留"最近访问的文件"，
   本项目的 [CHECKPOINT] 也应包含"本班改过的文件 top5 + 验证命令"。
   **修法（evolve-N4）**：改 docs/evolve.md 的 checkpoint 模板。

## 干活轮上下文组装预算（M1 / evolve-J 的设计输入）

委派 prompt 必含四要素：**目标 / 输出格式 / 工具指引 / 任务边界**（缺一会导致重复劳动或漏做）。

| 区块 | 预算 | 来源 |
|---|---|---|
| 任务契约（目标+scope+acceptance） | ≤1k tokens | 任务状态 JSON |
| 相关历史决策 | ≤500 | docs/decisions.md 按 scope 过滤 |
| 上轮 audit findings（回炉时） | 全量 | audit 报告 |
| 池轨迹 | 同任务最近 ≤5 条 | lib.readNewMessagesFor |
| 代码正文 | **0**（只给 refs 路径，agent 自己 just-in-time 读） | — |

干活轮的返回也要压缩：结构化结果 + patch manifest ≤2k tokens，
详情留在 worktree 和轮次日志里（= 子 agent"重活隔离在自己上下文、只回传凝缩摘要"模式）。

## 工具 / CLI 设计守则（新增 cli 子命令时自查）

- 返回语义字段（文件名、任务 id），不返回裸 UUID / 内部偏移量；
- 错误信息给"具体可操作的下一步"，不给裸错误码；
- 大输出强制分页/截断（`cli cat` 应有 `--tail N`，默认不吐全池）;
- 工具数量宁少勿重叠：两个功能相近的子命令不如一个带参数的。

## 验证优先级（来自 Agent SDK 文章）

规则反馈（测试/审计脚本，给具体错误）> 视觉反馈 > LLM 评审（最弱，仅用于质量类判断）。
这正是裁判层"audit 机器闸在前、对端 LLM 评审在后"排序的依据。
