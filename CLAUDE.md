# 新对话机（二代 · Project Memory）

Claude Code 与 Codex CLI 协作系统二代：**GitHub 当账本与闸门，Claude 长驻会话当协调大脑，codex exec 当 Codex 侧执行器**。
蓝图（单一真源）：`docs/blueprint.md`；裁决历史：`docs/decisions.md`。

## 不变量（破了就乱）

1. **人类是唯一合并者**——main 受 branch protection 保护，GitHub 禁自批兜底
2. **无验收标准不开工**——任务契约（issue 表单）必须含可证伪的验收标准
3. **隔离干活**——任务在独立 worktree + draft PR 上做，不直接改 main
4. **LLM 不直接写系统状态**——轮次留痕走 coordination/turn-log.mjs
5. **禁用 claude -p 及同机制的 Agent SDK headless**（架构裁决，见 decisions.md 2026-06-12）
6. **极简**——无框架、无构建步骤，胶水代码总量控制在数百行

## 命令

```bash
node --test coordination/*.test.mjs        # 全部测试
# Codex 干活轮（标准形态）：
codex exec --json -C <worktree> --sandbox workspace-write --ask-for-approval never --output-last-message <file> "<prompt>"
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

bootstrap：脚手架已就位。下一步见 `docs/blueprint.md` §九 启动顺序
（修代理 → 建 GitHub 公开仓 + branch protection → 接双云端评审 → 写 codex-turn.mjs 胶水 → 手摇穿透第一个任务）。
