# 合流（heliu）项目规则

本仓库是「合流」——并行 AI 开发的个人项目管理工具（对账单 + 承诺台账 + 按里程碑合并）。全中文。

## 先读什么
- 做什么、为什么：`docs/02-产品定义/产品定义_v0.1.md`
- 怎么做、不做什么：`docs/03-架构/架构决策_v0.1.md`（ADR-1~7）
- 当前里程碑任务卡与实现说明：`docs/03-架构/M<N>-任务卡.md`、`M<N>-实现说明.md`
- 验收流程与记录：`docs/04-验收记录/`

## 硬规则
1. **被管理的仓库绝对只读**（磁吸背夹三仓库等），一切 git 访问走 `src/core/git.ts` 的白名单；只有 M4 的 `release run` 在用户确认后才写引用，且只写集成分支/tag/主线。
2. **绝不自动 push、fetch、删分支、删 worktree。** 本仓库的推送也要先问用户。
3. 台账（`.heliu/`）只存 git 里没有的东西；派生数据（领先/落后/冲突/最后活动）实时计算不落盘；缓存放 `~/Library/Application Support/heliu/`，**绝不在 iCloud 目录放数据库**。
4. iCloud 仓库：`status` 类命令必须带超时并标「未知」，不得卡死；`merge-tree` 必须在对象隔离区 + 沙箱内。
5. hooks 必须 <300ms、失败静默。
6. 文案事实与建议分开，不写过度断言（Codex 验收已两次指出）。

## 分工（用户规定）
- Fable 5.1：规划、产品定义、每个里程碑终验。
- Opus 5.5：编码与检索子代理。
- 每个里程碑 Codex 二次验收：`scripts/codex-accept.sh M<N> <轮次> --ref <提交>`（在冻结快照上跑），≤3 轮，记录到 `docs/04-验收记录/M<N>.md`。

## 开发
- Bun 1.3 + TypeScript strict；`bun test`；`bun run bin/heliu <命令>`。
- `node_modules` → `node_modules.nosync` 软链（iCloud 不同步）。
- 提交信息：说清改了什么、为什么；末尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
