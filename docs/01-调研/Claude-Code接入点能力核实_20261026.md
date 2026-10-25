# Claude Code 接入点能力核实（2026-10-26，依据官方文档 code.claude.com/docs）

> 用途：决定项目管理工具如何与 Claude Code / 桌面应用"无缝衔接"。三处与直觉不符的事实先列出：
> 1. CLI `claude --worktree` 的分支叫 `worktree-<name>`；桌面应用 Code tab 用 "Branch prefix" 设置（实测为 `claude/<name>-<hash>`）。
> 2. hook 输入里**没有分支名字段**，要在 hook 里自己 `git branch --show-current`。
> 3. CLAUDE.md 只是上下文，**不能强制** Agent 调用某个工具；要强制必须用 hook。

## 1. Hooks（https://code.claude.com/docs/en/hooks.md）
- 33 个事件，含 `WorktreeCreate`、`WorktreeRemove`、`SessionStart`(source: startup/resume/clear/compact/fork)、`SessionEnd`、`UserPromptSubmit`、`Stop`(含 last_assistant_message)、`PreToolUse`/`PostToolUse`、`SubagentStart/Stop`、`CwdChanged`、`FileChanged`、`PreCompact` 等。
- 公共输入：`session_id`、`transcript_path`（异步写入可能滞后）、`cwd`、`permission_mode`、`hook_event_name`。
- `WorktreeCreate` 额外给 `name`；`WorktreeRemove` 给 `worktree_path`。`cwd` 会随进入 worktree 变化；`${CLAUDE_PROJECT_DIR}` 始终是主检出根目录。
- 注入上下文：`SessionStart`、`UserPromptSubmit` 等 exit 0 的 stdout 进入上下文；精确注入用 `hookSpecificOutput.additionalContext`（≤10,000 字符）。
- 配置层级：`~/.claude/settings.json`、项目 `.claude/settings.json`（可提交）、`.claude/settings.local.json`、插件 `hooks/hooks.json`、skill/subagent frontmatter；各层合并。

**对本工具的意义**：`SessionStart` hook 可以在每个会话开始时把「你在哪个分支、对应哪个功能、预约了哪个版本、基线落后多少」注入上下文；`Stop`/`SessionEnd` hook 可以把进度回写台账。用户零额外动作。

## 2. Worktree（https://code.claude.com/docs/en/worktrees.md）
- 位置 `<repo>/.claude/worktrees/<name>/`；CLI 分支 `worktree-<name>`，桌面端可配前缀。`worktree.baseRef` 只接受 `fresh`/`head`。
- `EnterWorktree`/`ExitWorktree` 工具；`-p` 模式创建的 worktree 不自动清理。
- 没有 `worktree.hooks` 配置项；自定义创建/删除逻辑用 `WorktreeCreate`/`WorktreeRemove` hook 替代默认 git 逻辑。

## 3. MCP（https://code.claude.com/docs/en/mcp.md）
- 项目级 `.mcp.json`：`{"mcpServers": {"<name>": {...}}}`；stdio（command/args/env）或 http（type+url）。作用域 local / project / user。
- `claude mcp add --transport stdio <name> -- <command> [args]`。
- 结果 >10k token 警告，默认上限 25k（`MAX_MCP_OUTPUT_TOKENS`）。
- MCP 进程拿到的 `CLAUDE_PROJECT_DIR` 是主检出根目录，**不知道 worktree 路径** → 工具参数里显式传 cwd，或由 hook 注入。

## 4. Skills 与 CLAUDE.md（https://code.claude.com/docs/en/skills.md）
- 位置：`~/.claude/skills/<name>/SKILL.md`、项目 `.claude/skills/`、插件 `skills/`（调用 `/插件名:skill名`）。
- frontmatter：name、description、when_to_use、argument-hint、disable-model-invocation、user-invocable、allowed-tools、model、effort、context(fork)、agent、hooks、paths。
- `$ARGUMENTS`、`${CLAUDE_SESSION_ID}`、`${CLAUDE_SKILL_DIR}` 可用。
- CLAUDE.md 是 "context, not enforced configuration"。

## 5. 非交互自动化（https://code.claude.com/docs/en/headless.md）
- `claude -p "..." --output-format json`（含 result、session_id、total_cost_usd）；`--resume`、`--session-id`、`--fork-session`。
- `--allowedTools "Bash(git diff *)"`、`--permission-mode acceptEdits|auto|...`、`--permission-prompts none`、`--max-budget-usd`。
- 可组合 `claude -w <name> -p "解决冲突..." --permission-mode acceptEdits` 让 Claude 在指定 worktree 解冲突。
- 云端 routines 无法访问本机 worktree；本机可用 Desktop 定时任务、`/loop`。

## 6. 桌面应用 mods（https://code.claude.com/docs/en/plugins/mods/overview.md）
- mod = 含 JS/TS 事件处理函数的插件，在 Claude Code 进程内运行；可在对话旁画 **pane**、输入框上方画 band、新增 `/命令`、拦截工具调用。
- 运行于终端 CLI、桌面 Code tab、VS Code 面板；需 CLI ≥2.1.287、桌面 ≥2.1.286。
- 不沙箱化，以用户权限运行。

**对本工具的意义**：看板可以有两种形态——独立本地 Web 页（任何浏览器、Codex 也能看）+ 桌面应用内的 pane（mod）。先做 Web，再做 mod。

## 7. Plugins（https://code.claude.com/docs/en/plugins/components.md）
- 结构：`.claude-plugin/plugin.json`、`skills/`、`agents/`、`hooks/hooks.json`、根 `.mcp.json`、`bin/`（进 PATH）。一个插件可同时打包 MCP + Skill + hooks + subagent。
- 插件根 CLAUDE.md 不加载；插件 hook 随插件加载即生效。`${CLAUDE_PLUGIN_DATA}` 是持久目录。
- 本地 marketplace：`claude plugin validate` → `claude plugin marketplace add ./x` → `claude plugin install <p>@x`；开发时 `--plugin-dir` + `/reload-plugins`。
- 注意：插件里的 `WorktreeCreate` hook 在 `--worktree --tmux` 下不运行，应放 settings。

**对本工具的意义**：最终交付形态应是一个 **plugin**（MCP server + Skill + hooks + merge-resolver 子代理 + bin CLI），一条命令装到所有项目。

## 8. Agent SDK（https://code.claude.com/docs/en/agent-sdk/overview.md）
- `@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`；`query()` 的 `agents` 可定义 `model: "opus"` 的子代理（如 merge-resolver）。
- 第三方产品不能提供 claude.ai 登录，需 API key → 个人工具优先用 `claude -p` 复用本机登录。

## 未核实
MCP 进程 cwd、桌面端默认分支命名规则、`mcp_tool` 类型 hook 字段、SDK 绑定 worktree 的选项名。
