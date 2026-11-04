/** F-0004 自更新的数据结构（只含类型：看板前端也引用，不能带 Bun / node 运行时） */

export type UpdateState =
  /** 本机主线就是 GitHub 主线 */
  | "latest"
  /** GitHub 主线比本机新，本机没有自己的提交：能快进 */
  | "behind"
  /** 本机主线比 GitHub 新（有还没推的提交）：不用更新 */
  | "ahead"
  /** 两边各有对方没有的提交：不能快进 */
  | "diverged"
  /** 问不到 GitHub、或者代码目录不是 git 仓库 */
  | "unknown";

export interface UpdateCheck {
  root: string;
  remote: string;
  main: string;
  /** 代码目录当前分支；null = 游离 HEAD 或查不到 */
  branch: string | null;
  /** 本机主线（refs/heads/main）指向的提交 */
  local: string | null;
  /** GitHub 主线指向的提交 */
  remoteSha: string | null;
  state: UpdateState;
  /** 本机落后几个提交；null = GitHub 上的新提交本机还没有，要 fetch 之后才数得出 */
  behind: number | null;
  /** 本机主线有几个提交不在 GitHub 上；null = 数不出 */
  ahead: number | null;
  /** 跟踪文件有没有改动；null = 查不清（iCloud 可能在下载、超时） */
  dirty: boolean | null;
  /** 一键更新能不能做 */
  canRun: boolean;
  /** 不能一键更新的原因（事实，中文） */
  blockers: string[];
  checkedAt: string;
  /** 问 GitHub / 读仓库出错时的原话 */
  error: string | null;
}

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateResult {
  root: string;
  from: string;
  to: string;
  count: number;
  /** 最多 30 条，新的在前 */
  commits: UpdateCommit[];
  files: number;
  /** 依赖清单变了没有 */
  depsChanged: boolean;
  /** bun install 结果：null = 没跑（依赖没变）；true = 成功；false = 失败（见 depsError） */
  depsInstalled: boolean | null;
  depsError: string | null;
  /** App 外壳（app/macos）也变了：要重新打包 App */
  shellChanged: boolean;
  finishedAt: string;
}
