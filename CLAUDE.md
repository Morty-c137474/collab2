# 新对话机（二代 · Project Memory）

Claude Code 与 Codex CLI 协作系统二代：**GitHub 当账本与闸门，Claude 长驻会话当协调大脑，codex exec 当 Codex 侧执行器**。
蓝图（单一真源）：`docs/blueprint.md`；裁决历史：`docs/decisions.md`。

## 不变量（破了就乱）

1. **人类是唯一合并者**——main 受 branch protection 保护；双账号结构（AI 共用仅 Write 权限的机器账号，人类账号保留 owner）+ GitHub 禁自批兜底
2. **无验收标准不开工**——任务契约（issue 表单）必须含可证伪的验收标准
3. **隔离干活**——任务在独立 worktree + draft PR 上做，不直接改 main
4. **LLM 不直接写系统状态**——轮次留痕走 coordination/turn-log.mjs
5. **禁用 claude -p 及同机制的 Agent SDK headless，含 claude-code-action**（裁决见 decisions.md 2026-06-12 / 2026-06-13）——方案全订阅化，不依赖 Agent SDK credit
6. **极简**——无框架、无构建步骤，胶水代码总量控制在数百行

## 命令

```bash
node --test coordination/*.test.mjs        # 全部测试
# Codex 干活轮（标准形态；exec 本身即非交互，无 --ask-for-approval 参数；--sandbox 必须显式传）：
codex exec --json -C <worktree> --sandbox workspace-write --output-last-message <file> "<prompt>"
# gh 不读 git 的代理配置，一切 gh 调用必须显式带：
HTTPS_PROXY=http://127.0.0.1:7897 gh <...>
# agent 的 GitHub 身份 = 机器账号 lzyc137morty-glitch（仅 Write，无 admin）。
# 凭证在仓库外私有文件，agent 操作 GitHub 前先加载：
#   bash:  export $(grep -v '^#' ~/.claude/coordination/collab2-bot.env | xargs)
# 主账号（人类）的管理操作一律走浏览器，本机 CLI 不留主账号凭证。
```

## 结构

```
coordination/   audit.mjs（裁判，纯函数）turn-log.mjs（飞行记录仪）
docs/           blueprint.md（二代蓝图）decisions.md（裁决日志）
                autonomy.md（一代协议：辩论/进化环/不做清单仍有效）context.md（上下文工程规范）
.github/        ISSUE_TEMPLATE/task.yml（任务契约）workflows/（审计公证 + 契约校验）
scripts/        工程脚本（晨报等，待建）
```

## Git 约定

- 中文 commit message，前缀 `feat:` / `fix:` / `docs:` / `chore:` / `test:`
- 只 `git add <具体路径>`，禁用 `git add .` / `-A`
- 接上 GitHub remote 与 branch protection 之前，脚手架可直接提交 main；之后一切走 draft PR
- 合并任务时往 `docs/decisions.md` 追加裁决（每条 ≤5 行）

## 当前阶段

bootstrap 完成：公开仓 [Morty-c137474/collab2] 已建，main 保护（必须走 PR + audit 绿 + 管理员同样受约束），
机器账号 lzyc137morty-glitch 已加为仅 Write 协作者，agent 凭证已切到机器账号，Require approvals(1) 由人类在浏览器开启。
下一步：手摇穿透第一个任务（issue #1：codex-turn.mjs 胶水，~120 行 + 测试）。
