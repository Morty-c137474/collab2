# 新对话机（二代）

让 Claude Code 与 Codex CLI 协作完成真实编码任务，并持续改进协作方式本身。

二代的地基（详见 [docs/blueprint.md](docs/blueprint.md)）：

- **GitHub = 账本与闸门**：Issue 当任务契约、draft PR 当进行中、Actions 当机器审计公证、branch protection + 禁自批当人类合并闸
- **Claude Code 长驻会话 = 协调大脑**（不用 `claude -p`）
- **`codex exec --json` = Codex 侧执行器**（worktree 隔离 + 沙箱）
- 自写部分只有数百行胶水：裁判 `coordination/audit.mjs` + 飞行记录仪 `coordination/turn-log.mjs` + 待建的 codex-turn 封装

```bash
node --test coordination/*.test.mjs   # 49 项测试
```

一代仓库：`../对话机`（消息池协议与本系统并存，承担本地低延迟 chatter）。
