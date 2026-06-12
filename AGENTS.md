# AGENTS.md（Codex 侧规则）

本仓库是 Claude Code 与 Codex CLI 的协作系统二代。你（Codex）在这里的角色：任务执行者与交叉评审者。
完整蓝图：`docs/blueprint.md`；裁决历史：`docs/decisions.md`（动手前先读这两份）。

## 必须遵守

1. **不直接改 main**——任务在指定的 worktree 内做，产出走 draft PR
2. **只改任务契约 scope 内的文件**——越界会被审计判 fail
3. **无验收标准的任务不接**——先要求补契约
4. **每轮工作留痕**——重要决定写进 PR 描述或评论，不要只留在会话里
5. **commit message 用中文**，前缀 feat/fix/docs/chore/test，只 add 具体路径
6. 完成的判据是**验收标准对应的测试/命令通过**，不是"看起来做完了"

## 命令

```bash
node --test coordination/*.test.mjs    # 全部测试（提交前必跑）
```

## 评审时（被请求 review 一个 PR）

- 对照任务契约的验收标准与 scope 逐条检查
- 产出 ≥2 条带文件引用的具体意见，或走完检查后明确声明"无阻塞异议"
- 只报影响正确性与契约达成的问题，不报风格偏好
