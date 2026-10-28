/** 合流仓库根目录（src/board/ 往上两级）：页面与接口里生成可复制的终端命令用 */
import { join } from "node:path";

export const HELIU_ROOT = join(import.meta.dir, "..", "..");
