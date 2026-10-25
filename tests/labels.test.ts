import { describe, expect, test } from "bun:test";
import { humanizeBranch, isRandomName, pickLabel, tidySubject } from "../src/core/labels.ts";
import { parseProjectYaml } from "../src/core/project.ts";
import { truncate, truncateMiddle, width } from "../src/cli/table.ts";

describe("随机名识别", () => {
  test("形容词-科学家-hash", () => {
    for (const n of ["claude/bold-shaw-093e51", "claude/funny-goldwasser-b9ae93", "claude/upbeat-mendeleev-83c61c", "objective-morse"]) {
      expect(isRandomName(n)).toBe(true);
    }
    for (const n of ["claude/voice-e2e-loop-testing-dee94b", "claude/scenario-discovery-d9fcb4", "main", "feat/aios-core"]) {
      expect(isRandomName(n)).toBe(false);
    }
  });
});

describe("标签优先级", () => {
  const base = { branch: "claude/bold-shaw-093e51", sessionTitle: null, firstCommitSubject: null, topDir: null, tipSubject: null };
  test("会话标题优先", () => {
    expect(pickLabel({ ...base, sessionTitle: "实现 EPP 网关", firstCommitSubject: "x" })).toEqual({ label: "实现 EPP 网关", source: "session" });
  });
  test("其次首条提交、一级目录、末次提交、分支名", () => {
    expect(pickLabel({ ...base, firstCommitSubject: "feat: a", topDir: "嵌入式/" }).source).toBe("first_commit");
    expect(pickLabel({ ...base, topDir: "嵌入式/（3 个文件）" }).label).toBe("改动集中在 嵌入式/（3 个文件）");
    expect(pickLabel({ ...base, tipSubject: "docs: x" }).source).toBe("tip_commit");
    expect(pickLabel(base)).toEqual({ label: "bold-shaw", source: "branch_name" });
    expect(humanizeBranch("claude/magnetic-clip-prd-197f58")).toBe("magnetic-clip-prd");
  });
  test("提交主题去掉类型前缀、保留 scope", () => {
    expect(tidySubject("feat(timeline): 时间线 v2 数据层")).toBe("timeline: 时间线 v2 数据层");
    expect(tidySubject("docs: record app merge")).toBe("record app merge");
    expect(tidySubject("Initial commit")).toBe("Initial commit");
  });
});

describe("显示宽度", () => {
  test("全角按 2 计、截断不超宽", () => {
    expect(width("磁吸背夹")).toBe(8);
    expect(width(truncate("执行 AI 电话秘书 POC：阶段 0–1", 12))).toBeLessThanOrEqual(12);
    const m = truncateMiddle("claude/magnetic-clip-cli-monitoring-577a21", 20);
    expect(width(m)).toBeLessThanOrEqual(20);
    expect(m.endsWith("577a21")).toBe(true);
  });
});

describe("project.yaml 校验", () => {
  test("默认值与 iCloud 自动识别", () => {
    const p = parseProjectYaml(
      "name: 磁吸背夹\nrepos:\n  - id: docs\n    path: /Users/x/Library/Mobile Documents/com~apple~CloudDocs/磁吸背夹\n  - id: app\n    path: /tmp/app\n    main: release/backclip-1.0\n",
      "t.yaml",
    );
    expect(p.repos[0]).toMatchObject({ id: "docs", label: "docs", main: "main", integration: null, icloud: true });
    expect(p.repos[1]).toMatchObject({ main: "release/backclip-1.0", icloud: false });
  });
  test("缺字段与重复 id 报错", () => {
    expect(() => parseProjectYaml("name: x\nrepos: []\n", "t")).toThrow();
    expect(() => parseProjectYaml("name: x\nrepos:\n  - id: a\n    path: /a\n  - id: a\n    path: /b\n", "t")).toThrow("重复");
  });
});
