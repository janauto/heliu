// heliu 可执行入口（TS 部分）：bin/heliu（POSIX sh 包装，自寻 bun）exec 到这里；`bun run bin/heliu` 也会 import 这里。
// 所有逻辑在 ./index.ts（输出在 main 内写完）。
// 显式 process.exit：即使有卡在 iCloud 上被 SIGKILL 的 git 子进程，也不让 CLI 挂起。
import { main } from "./index.ts";

const code = await main(process.argv);
process.exit(code);
