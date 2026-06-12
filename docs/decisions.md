# 决策日志（ADR-lite）

> 每条 ≤5 行：日期 / 裁决 / 理由 / 被拒的替代方案。合并任务时追加。
> 作用：防止新窗口"好心"推翻已论证过的取舍（见 docs/context.md 待修第 4 条）。

## 2026-06-10 三个编排器收敛归档，资产只留裁判与调用细节
裁决：driver / coordinator-v2 / collab-loop 都不当主干，audit 逻辑抽成独立 audit.mjs。
理由：编排循环便宜可抛，协议与裁判才是资产；严格 A/B 交替是对话形状不是工作形状。
被拒方案：driver 升格执行引擎（它是 talk-only，改造=重写）；cov2 当主干（1900 行流水线迭代太贵）。

## 2026-06-10 真执行器 = 现有 CLI 本身，不另造
裁决：干活轮直接用 headless claude -p / codex exec（全工具权限 + worktree 隔离 + audit 门）。
理由："执行器缺口"是自己造成的——此前 prompt 禁止 agent 干活，能力一直都在。
被拒方案：为 cov2 写专用执行后端。

## 2026-06-10 调度智能分层：哑脚本判"要不要动"，LLM 只干活
裁决：dispatch 免 LLM 读状态文件派轮次；接力链 + 低频救援心跳，不要常驻 daemon。
理由：自主系统 99% 时间无事发生，无事也烧 token 经济上不成立；daemon 在桌面机是新单点。
被拒方案：常驻编排进程；让 LLM 轮次自己轮询池。

## 2026-06-10 GLM（第三模型）定位 = 不下场的裁判，暂不入池当公民
裁决：辩论仲裁 / 双实现盲裁判 / 协议红队，三个无状态角色，wrapper 内 profile 切换接入。
理由：缺的不是第三个玩家是中立裁判（消解 LLM 自我偏好）；入池要同步 lib+cli+hook+viewer，成本高。
被拒方案：三方辩论池公民（协调成本超线性，多样性收益递减）。

## 2026-06-10 玩具仓毕业制：第一批自主任务不许改对话机自己
裁决：自主执行先在玩具仓跑夜批，毕业后才回本体（先文档级后代码级）。
理由：避免同时调试两个未知数（机器的 bug × 机器改自己引发的 bug）。
被拒方案：直接拿对话机本体当首个自主工作负载（自举诱惑，风险不可分离）。

## 2026-06-10 广播只报写，宁可漏报不可淹池
裁决：PostToolUse 只广播 Edit/Write 与 git commit/push 等写操作，普通 Bash 一律沉默。
理由：只读 allowlist 永远列不全（PowerShell 动词淹池实证）；注意力预算第一原则。
被拒方案：继续扩充 READ_ONLY_PATTERNS（打地鼠，下一个新命令又漏）。

## 2026-06-12 二代地基：GitHub 账本 + Claude 长驻会话大脑 + codex exec 执行器
裁决：新仓库不自建调度/状态机/账本——Issue=契约、draft PR=进行中、Actions=审计公证、branch protection+禁自批=人闸；Claude 交互会话当协调者（禁 claude -p 与同机制 Agent SDK），codex exec --json 当 Codex 执行器；交叉评审外包云端（@codex review + claude-code-action OAuth）。
理由：四路实证研究确认此模式已被官方主流化；禁自批使人闸由协议强制；自写胶水缩到数百行。
被拒方案：vibe-kanban 当地基（母公司关停 sunsetting）；Gas Town（强约定、Windows 二等）；LangGraph/CrewAI（编排外部 CLI 错配过重）；Agent SDK（与 claude -p 同机制，且订阅额度按 API 价烧得快）。

## 2026-06-13 人闸改双账号结构：AI 共用仅 Write 权限的机器账号
裁决：注册一个免费机器账号给两个 AI 共用（仅 Write 协作者，不给 admin），人类账号保留 owner；approve 后立即 merge 封死抢跑缝隙。机器账号就位前不开 Require approvals。
理由：官方规则"PR 作者不能自批"使共用账号 + approvals 成死结；不开 approvals 则任何持 token 进程可直接合并；admin 绕过（gh pr merge --admin）对共用账号的 agent 同样畅通（docs.github.com 逐字核实）。
被拒方案：共用人类账号 + 禁自批（原蓝图方案，逻辑死结）；仅靠 fine-grained PAT 收权（绕过资格挂在账号角色而非 token 上）。

## 2026-06-13 Agent SDK / claude -p 全线不依赖，claude-code-action 剔除
裁决：claude-code-action 剔出方案（官方自述建在 Agent SDK 上，6/15 起计入付费 Agent SDK credit）；Channels / Routines / Agent SDK 额度从"升级路径"移入不做清单。Claude 侧评审改为长驻会话派干净上下文 subagent + gh pr review。
理由：方案全订阅化——交互会话、subagent、codex exec、@codex review 全部计入两家订阅常规额度，6/15 计费切换零影响。
被拒方案：claude-code-action OAuth（Agent SDK 机制 + 月度 credit 封顶）；为评审买 API key。

## 2026-06-13 GLM 仲裁接法 = 纯 HTTP API，作废一代 claude -p 接法
裁决：GLM 仲裁用纯 HTTP API 调用智谱端点；autonomy.md 所记"headless claude -p + ANTHROPIC_BASE_URL"一代接法作废。
理由：claude -p 全线禁用；仲裁是无状态单轮调用，不需要 agent harness。
被拒方案：claude -p 指智谱端点（违反禁令）；OpenRouter 喂 codex（多一层依赖）。
