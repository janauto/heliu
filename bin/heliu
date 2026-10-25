#!/usr/bin/env bun
// heliu 可执行入口：所有逻辑在 src/cli/index.ts（输出在 main 内用 Bun.write 写完）。
// 显式 process.exit：即使有卡在 iCloud 上被 SIGKILL 的 git 子进程，也不让 CLI 挂起。
import { main } from "../src/cli/index.ts";

const code = await main(process.argv);
process.exit(code);
