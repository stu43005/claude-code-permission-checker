# Glob 路徑操作元支援 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓固定清單內的指令（`grep`/`egrep`/`fgrep`、`head`、`wc`、`cat`、`ls`）在能以純詞法確認「glob 展開結果必定落在讀取範圍內」時接受 glob 路徑操作元並回 `allow`，同時保住所有既有的 ask/deny 不變量。

**Architecture:** 新增 `src/engine/glob.ts` 做 glob word 的純詞法形態判定；`scope.ts` 新增 `resolveGlobPath`（前綴目錄涵蓋判定）與 `globMaySelectDangerousRoot`；`CommandSpec` 以 `globOperands`/`valueAcceptsGlob` opt-in，legacy 路徑以 `globOperandNames` opt-in；兩條路徑共用 `factory.ts` 的 `globRootGate`（危險根硬 deny，先於任何 ask）與 `injectionGuard`（旗標注入護欄）。`resolvePath` 完全不動。

**Tech Stack:** Deno 2 / TypeScript、`npm:unbash@4.0.1`（Bash AST）、`jsr:@std/assert`。

**Spec:** `docs/superpowers/specs/2026-09-23-glob-path-operands-design.md`

---

## 共通約定（每個 Task 都適用）

- 所有 shell 指令在 repo 根目錄 `/d/claude-code-permission-checker` 以 Bash 執行。
- 單一測試檔：`deno test --allow-env <file>`；全套：`deno task test`。
- **每個 Task 結束前**必須依序通過：`deno task check`、`deno task lint`、`deno task test`。任何一項失敗 → 修復後重跑，不得跳過。
- **commit 一律透過 `git-master` 技能**執行，只以具體路徑 `git add`（禁止 `git add -A` / `git add .`），commit message 結尾加：
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- 目前分支：`feat/glob-path-operands`（已存在，spec 已 commit 於此）。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/engine/word.ts` | Modify | 接收從 `scope.ts` 搬來的 `isDriveRelative`（避免 `glob.ts` ↔ `scope.ts` 循環 import） |
| `src/engine/scope.ts` | Modify | 改為 re-export `isDriveRelative`；新增 `resolveGlobPath`、`globMaySelectDangerousRoot` |
| `src/engine/glob.ts` | Create | `parseGlobPath`、`mayExpandToOption`、`hasGlobstarSegment`、`isGlobAttachedValue` |
| `src/engine/glob_test.ts` | Create | glob 形態判定測試 |
| `src/engine/scope_test.ts` | Modify | `resolveGlobPath` / `globMaySelectDangerousRoot` 測試 |
| `src/rules/command_spec.ts` | Modify | `FlagSpec.valueAcceptsGlob`、`CommandSpec.globOperands`、`ArgvParse.globOperands`，`parseArgv` 分類 glob |
| `src/rules/command_spec_test.ts` | Modify | parseArgv glob 分類測試 |
| `src/rules/types.ts` | Modify | `RuleContext` 新增兩個選填方法 |
| `src/rules/factory.ts` | Modify | `globRootGate`、`injectionGuard`；spec 與 legacy 兩條路徑接線；`globOperandNames` 選項 |
| `src/rules/commands/grep.ts` | Modify | grep spec 開 `globOperands`；`--include`/`--exclude` 設 `valueAcceptsGlob` |
| `src/rules/commands/coreutils.ts` | Modify | `HEAD_SPEC`/`WC_SPEC` 開 `globOperands`；`fileReaderRule` 設 `globOperandNames: ["cat","ls"]`；ls 群集遞迴偵測 |
| `src/rules/commands/grep_test.ts` | Modify | grep glob allow/ask/deny 測試 |
| `src/rules/commands/coreutils_test.ts` | Modify | head/wc/cat/ls glob 測試、ls `-lR` 測試 |
| `src/engine/classify.ts` | Modify | 綁定 `resolveGlobPath` / `globMaySelectDangerousRoot` 到 `RuleContext` |
| `src/engine/classify_test.ts` | Modify | 端到端（classify）glob 測試 |
| `scripts/verify-hook-binary.ts` | Modify | operational verification 案例 |
| `CLAUDE.md` | Modify | 文件同步 |

**RuleContext 新方法為選填**的理由：repo 內有 18 個測試檔各自手寫 `RuleContext` 字面量，改成必填會強迫修改所有檔案。選填時 fallback 一律 fail-closed：`resolveGlobPath` 缺席 → 視同 `"dynamic"`（ask）；`globMaySelectDangerousRoot` 缺席 → 視同 `true`（deny）。生產環境的 `classify.ts` 永遠兩者都提供（Task 6）。

---

### Task 1: `glob.ts` 詞法判定（並把 `isDriveRelative` 搬到 `word.ts`）

**Files:**
- Modify: `src/engine/word.ts`（檔尾新增 `isDriveRelative`）
- Modify: `src/engine/scope.ts`（移除 `isDriveRelative` 定義，改 import + re-export）
- Create: `src/engine/glob.ts`
- Test: `src/engine/glob_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/glob_test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { hasGlobstarSegment, isGlobAttachedValue, mayExpandToOption, parseGlobPath } from "./glob.ts";

/** 取出 `x <word>` 的那個 Word（x 只是佔位指令名）。 */
function w(src: string): Word {
  return (parse(`x ${src}`).commands[0].command as Command).suffix[0];
}

Deno.test("parseGlobPath: 接受的形態與其 prefix", () => {
  const cases: [string, string][] = [
    ["*.md", ""],
    ["runtime-behavior/*.md", "runtime-behavior"],
    ["src/**/*.ts", "src"],
    ["./*.md", "."],
    ["./*/x.md", "."],
    ["/d/proj/*.md", "/d/proj"],
    ["../x/*.md", "../x"],
    ["/*.md", "/"],
    ["C:/*.md", "C:/"], // 磁碟根前綴必須保留分隔符，否則會被當成相對路徑
    ["C:/proj/*.md", "C:/proj"],
    ["src//*.md", "src/"], // 空段可接受（原樣連接）
    ["src/*/", "src"], // 結尾 / 可接受
  ];
  for (const [src, prefix] of cases) {
    assertEquals(parseGlobPath(w(src)), { prefix }, src);
  }
});

Deno.test("parseGlobPath: 拒絕的形態", () => {
  for (
    const src of [
      "*/outside/secret", // 可能展開成旗標的多段 glob
      "*/x.md",
      "-*",
      "~/*.md",
      '"src"/*.md', // 含引號片段
      "src/\\*.md", // 含反斜線
      "C:*.md", // 磁碟相對
      "sub*/../x", // glob 段之後的字面 ..
      ".*", // . 開頭的 glob 段
      "sub/.*",
      "[.]*", // [ 開頭的 glob 段
      "x/[ab]*",
      "a.md", // 無 glob
    ]
  ) {
    assertEquals(parseGlobPath(w(src)), null, src);
  }
});

Deno.test("mayExpandToOption: 只有開頭即 glob 元字元者為 true", () => {
  for (const src of ["*.md", "?x", "[ab]x"]) assertEquals(mayExpandToOption(w(src)), true, src);
  for (const src of ["./*.md", "src/*.md", "a.md"]) assertEquals(mayExpandToOption(w(src)), false, src);
});

Deno.test("hasGlobstarSegment: 恰為 ** 的段才算", () => {
  assertEquals(hasGlobstarSegment(w("src/**/*.ts")), true);
  assertEquals(hasGlobstarSegment(w("/**/*.md")), true);
  assertEquals(hasGlobstarSegment(w("src/a**b/*.ts")), false);
  assertEquals(hasGlobstarSegment(w("*.md")), false);
});

Deno.test("isGlobAttachedValue: 只接受單段、無反斜線的黏寫 glob 值", () => {
  assertEquals(isGlobAttachedValue(w("--include=*.md"), "--include"), true);
  assertEquals(isGlobAttachedValue(w("--include=a.md"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--exclude=*.log"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=*/../../../**"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=src/*.md"), "--include"), false);
  assertEquals(isGlobAttachedValue(w('--include="*.md"'), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=\\*.md"), "--include"), false); // 含反斜線
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/glob_test.ts`
Expected: FAIL（`Module not found ... glob.ts`）

- [ ] **Step 3: 把 `isDriveRelative` 從 `scope.ts` 搬到 `word.ts`**

在 `src/engine/word.ts` 檔尾新增（註解原樣從 scope.ts 搬來）：

```ts
/**
 * Windows 磁碟前綴但缺分隔符（`C:Windows`）。這個形態的語義有歧義——不同程式解析結果不同
 * （實測 `cd`/`realpath` 解析到 C 磁碟，`cat`/`ls` 當成含冒號的相對檔名）——且沒有任何正當
 * 寫法會用它：要指 C 磁碟就寫 `/c/Windows` 或 `C:/Windows`。歧義且無正當用途，依 default-deny
 * 一律拒絕，不去臆測它會落在哪裡。
 *
 * 定義於 word.ts（而非 scope.ts）以便 glob.ts 使用而不形成 glob.ts ↔ scope.ts 循環 import；
 * scope.ts 以 re-export 維持既有匯入點。
 */
export function isDriveRelative(p: string): boolean {
  return /^[A-Za-z]:(?![/\\])/.test(p);
}
```

在 `src/engine/scope.ts`：
1. 刪除原本的 `isDriveRelative` 函式與其 JSDoc 註解（`export function isDriveRelative(p: string): boolean { return /^[A-Za-z]:(?![/\\])/.test(p); }` 那一段）。
2. 把第 2 行 `import { staticValue } from "./word.ts";` 改為：

```ts
import { isDriveRelative, staticValue } from "./word.ts";
```

3. 在 import 區塊之後（`export type PathScope = ...` 之前）新增：

```ts
// 維持既有匯入點（cwd.ts 等從 scope.ts 匯入）；定義已搬到 word.ts。
export { isDriveRelative };
```

- [ ] **Step 4: 建立 `src/engine/glob.ts`**

```ts
import type { Word } from "../deps.ts";
import { isDriveRelative } from "./word.ts";

/**
 * glob 路徑操作元的純詞法形態判定（不碰檔案系統）。
 *
 * 依 GNU bash 5.3.9 實測行為設計：
 *  - `shopt -u globskipdots` 時，以字面 `.` 開頭的 glob 段（`.*`、`.[.]`）可展開成 `..`；
 *  - glob 段之後的字面 `..`（`sub*\/../x`）原樣保留，會逃出字面前綴；
 *  - 沒有字面前綴的 glob（`*.md`）展開結果取自 cwd 檔名，可能以 `-` 開頭而被當成旗標；
 *    多段者（`*\/x`）的注入值還會帶 `/`。
 * 只接受在上述行為下仍能保證「展開結果落在字面前綴目錄之下」的形態。
 */

const GLOB_CHAR = /[*?[]/;

export interface GlobPath {
  /** 第一個 glob 段之前的字面前綴（原樣以 `/` 連接）；`""` 代表 cwd，`"/"` 代表根。 */
  prefix: string;
}

/** 未加引號、且第一個字元即 glob 元字元：展開結果可能以 `-` 開頭而被當成旗標。 */
export function mayExpandToOption(word: Word): boolean {
  return word.parts === undefined && GLOB_CHAR.test(word.value.charAt(0));
}

/** 是否含恰為 `**` 的段（globstar 開啟時 shell 展開本身即遞迴遍歷前綴目錄）。 */
export function hasGlobstarSegment(word: Word): boolean {
  return word.value.split("/").includes("**");
}

/** 可被當成 glob 路徑操作元接受時回傳其字面前綴；其餘一律 null（呼叫端維持 dynamic → ask）。 */
export function parseGlobPath(word: Word): GlobPath | null {
  if (word.parts !== undefined) return null; // 含任何引號 / 展開片段
  const v = word.value;
  if (v.includes("\\") || !GLOB_CHAR.test(v)) return null;
  if (v.startsWith("-") || v.startsWith("~") || isDriveRelative(v)) return null;
  // 可能展開成旗標者必須單段：被注入的 token 才不可能帶 `/`（旗標值只能指向 cwd 內檔名）
  if (mayExpandToOption(word) && v.includes("/")) return null;
  const segs = v.split("/");
  const g = segs.findIndex((s) => GLOB_CHAR.test(s));
  for (const s of segs.slice(g)) {
    if (s === "..") return null;
    if (GLOB_CHAR.test(s) && (s.startsWith(".") || s.startsWith("["))) return null;
  }
  const head = segs.slice(0, g);
  if (head.length === 0) return { prefix: "" };
  const joined = head.join("/");
  if (joined === "") return { prefix: "/" }; // `/*.md`
  // `C:/*.md` 切段後前綴只剩 `C:`；補回分隔符，否則會被當成相對路徑而解析到 cwd 之內
  if (/^[A-Za-z]:$/.test(joined)) return { prefix: joined + "/" };
  return { prefix: joined };
}

/**
 * `--flag=<glob>` 黏寫值形態：值含 glob 字元、整個 value 不含反斜線且不含 `/`。
 * bash 把整個 word 當路徑 pattern 展開；單段只會匹配 cwd 內名為 `--flag=...` 的項目，
 * 結果仍以 `--flag=` 開頭（同一旗標、不同值）。多段者可經 `..` / `**` 遍歷 cwd 之外，一律拒絕。
 */
export function isGlobAttachedValue(word: Word, flagName: string): boolean {
  if (word.parts !== undefined) return false;
  const v = word.value;
  const head = flagName + "=";
  if (!v.startsWith(head)) return false;
  if (v.includes("\\") || v.includes("/")) return false;
  return GLOB_CHAR.test(v.slice(head.length));
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `deno test --allow-env src/engine/glob_test.ts src/engine/scope_test.ts src/engine/cwd_test.ts`
Expected: PASS（全部）

- [ ] **Step 6: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過

- [ ] **Step 7: Commit（git-master）**

檔案：`src/engine/word.ts`、`src/engine/scope.ts`、`src/engine/glob.ts`、`src/engine/glob_test.ts`
Message: `feat(engine): add lexical glob path shape detection`

---

### Task 2: `scope.ts` 的 `resolveGlobPath` 與 `globMaySelectDangerousRoot`

**Files:**
- Modify: `src/engine/scope.ts`（檔尾新增兩個函式與兩個私有 helper；import `parseGlobPath`）
- Test: `src/engine/scope_test.ts`（檔尾新增測試；擴充第 4 行 import）

- [ ] **Step 1: 寫失敗測試**

把 `src/engine/scope_test.ts` 第 4 行的 import 加入 `globMaySelectDangerousRoot, resolveGlobPath`：

```ts
import { buildScopeConfig, canonicalizeExecPath, dangerousRoot, globMaySelectDangerousRoot, isDangerousRootAbs, isReadScoped, isWithin, normalizeAbsolute, resolveGlobPath, resolvePath, resolvePathValue, rootScope, type PathScope, type ScopeConfig } from "./scope.ts";
```

檔尾新增（`wordOf` 為檔內既有 helper：取第一個 argv Word）：

```ts
const GLOB_CWD: CwdState = { kind: "known", path: "/proj" };

/** 專案 /proj + 外部 allow/deny/ask（皆為目錄 root，另可給 allow 精確單檔）。 */
function extScope(
  allowRoots: string[],
  allowFiles: string[] = [],
  denyRoots: string[] = [],
  askRoots: string[] = [],
): ScopeConfig {
  return {
    ...rootScope("/proj"),
    allow: { roots: allowRoots, files: allowFiles },
    deny: { roots: denyRoots, files: [] },
    ask: { roots: askRoots, files: [] },
  };
}

Deno.test("resolveGlobPath: 三態", () => {
  const s = rootScope("/proj");
  assertEquals(resolveGlobPath(wordOf("cat *.md"), GLOB_CWD, s), "in-project");
  assertEquals(resolveGlobPath(wordOf("cat src/**/*.ts"), GLOB_CWD, s), "in-project");
  assertEquals(resolveGlobPath(wordOf("cat ../*.md"), GLOB_CWD, s), "out-of-project");
  assertEquals(resolveGlobPath(wordOf("cat /etc/*.conf"), GLOB_CWD, s), "out-of-project");
  assertEquals(resolveGlobPath(wordOf("cat src/*.ts"), { kind: "unknown" }, s), "dynamic");
  assertEquals(resolveGlobPath(wordOf("cat *.md"), { kind: "unknown" }, s), "dynamic");
  assertEquals(resolveGlobPath(wordOf("cat .*"), GLOB_CWD, s), "dynamic"); // 非合格 glob 形態
});

Deno.test("resolveGlobPath: 外部 allow root 涵蓋、巢狀 deny/ask 否決", () => {
  assertEquals(resolveGlobPath(wordOf("cat /ext/*"), GLOB_CWD, extScope(["/ext"])), "in-project");
  assertEquals(
    resolveGlobPath(wordOf("cat /ext/*"), GLOB_CWD, extScope(["/ext"], [], ["/ext/private"])),
    "out-of-project",
  );
  assertEquals(
    resolveGlobPath(wordOf("cat /ext/*"), GLOB_CWD, extScope(["/ext"], [], [], ["/ext/private"])),
    "out-of-project",
  );
  // 前綴本身被 deny 覆蓋
  assertEquals(resolveGlobPath(wordOf("cat /ext/a/*"), GLOB_CWD, extScope(["/ext"], [], ["/ext"])), "out-of-project");
  // 專案內 root-first：專案內的 deny 條目不影響
  assertEquals(resolveGlobPath(wordOf("cat src/*"), GLOB_CWD, extScope([], [], ["/proj/src/secret"])), "in-project");
});

Deno.test("resolveGlobPath: 精確單檔 allow 不擴大成其子路徑", () => {
  assertEquals(resolveGlobPath(wordOf("cat /ext/data/*"), GLOB_CWD, extScope([], ["/ext/data"])), "out-of-project");
  assertEquals(resolveGlobPath(wordOf("cat /ext/data/*"), GLOB_CWD, extScope(["/ext/data"])), "in-project");
});

Deno.test("resolveGlobPath: 巢狀 deny/ask 的 file 條目同樣否決", () => {
  const s: ScopeConfig = {
    ...rootScope("/proj"),
    allow: { roots: ["/ext"], files: [] },
    deny: { roots: [], files: ["/ext/private.key"] },
  };
  assertEquals(resolveGlobPath(wordOf("cat /ext/*"), GLOB_CWD, s), "out-of-project");
  const a: ScopeConfig = {
    ...rootScope("/proj"),
    allow: { roots: ["/ext"], files: [] },
    ask: { roots: [], files: ["/ext/private.key"] },
  };
  assertEquals(resolveGlobPath(wordOf("cat /ext/*"), GLOB_CWD, a), "out-of-project");
});

Deno.test("resolveGlobPath / globMaySelectDangerousRoot: 絕對前綴不受 cwd unknown 影響", () => {
  assertEquals(resolveGlobPath(wordOf("cat /proj/src/*.ts"), { kind: "unknown" }, rootScope("/proj")), "in-project");
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /proj/src/*"), { kind: "unknown" }, "/home/me"), false);
});

Deno.test("resolveGlobPath / globMaySelectDangerousRoot: 磁碟根前綴（C:/*）", () => {
  const cwd: CwdState = { kind: "known", path: "D:/proj" };
  assertEquals(resolveGlobPath(wordOf("cat C:/*.md"), cwd, rootScope("D:/proj")), "out-of-project");
  assertEquals(resolveGlobPath(wordOf("cat C:/**/*.md"), cwd, rootScope("D:/proj")), "out-of-project");
  assertEquals(globMaySelectDangerousRoot(wordOf("ls C:/*"), cwd, null), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls C:/**/*.md"), cwd, null), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls C:/proj/*"), cwd, null), false);
});

Deno.test({
  name: "globMaySelectDangerousRoot: Windows 上 /c/* 前綴等同磁碟根",
  ignore: Deno.build.os !== "windows",
  fn() {
    const cwd: CwdState = { kind: "known", path: "D:/proj" };
    assertEquals(globMaySelectDangerousRoot(wordOf("ls /c/*"), cwd, null), true);
    assertEquals(resolveGlobPath(wordOf("cat /c/*.md"), cwd, rootScope("D:/proj")), "out-of-project");
  },
});

Deno.test("resolveGlobPath: trusted root 涵蓋", () => {
  const s: ScopeConfig = { ...rootScope("/proj"), trusted: ["/trusted"] };
  assertEquals(resolveGlobPath(wordOf("cat /trusted/*.txt"), GLOB_CWD, s), "in-project");
});

Deno.test({
  name: "resolveGlobPath: Windows 上 /d/ 前綴等同 D:/",
  ignore: Deno.build.os !== "windows",
  fn() {
    const cwd: CwdState = { kind: "known", path: "D:/proj" };
    assertEquals(resolveGlobPath(wordOf("cat /d/proj/src/*.ts"), cwd, rootScope("D:/proj")), "in-project");
  },
});

Deno.test("globMaySelectDangerousRoot", () => {
  const H = "/home/me";
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /*"), GLOB_CWD, H), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /home/me/*"), GLOB_CWD, H), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /home/m?"), GLOB_CWD, H), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /h*/me"), GLOB_CWD, H), true); // 前綴 /
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /home/me/src/*"), GLOB_CWD, H), false);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls src/*"), GLOB_CWD, H), false);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls m?"), { kind: "known", path: "/home" }, H), true);
  assertEquals(globMaySelectDangerousRoot(wordOf("ls src/*"), { kind: "unknown" }, H), true); // fail-closed
  assertEquals(globMaySelectDangerousRoot(wordOf("ls .*"), GLOB_CWD, H), false); // 非合格 glob 形態
  assertEquals(globMaySelectDangerousRoot(wordOf("ls /home/*"), GLOB_CWD, null), false); // home 未知
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL（`resolveGlobPath` / `globMaySelectDangerousRoot` 未匯出）

- [ ] **Step 3: 實作**

在 `src/engine/scope.ts` import 區塊新增：

```ts
import { parseGlobPath } from "./glob.ts";
```

在檔尾新增：

```ts
/** glob 前綴解析成已正規化絕對路徑；cwd unknown 且前綴為相對路徑時回 null。 */
function globPrefixAbs(prefix: string, cwd: CwdState): string | null {
  if (isAbsolute(prefix)) return normalizeAbsolute(prefix);
  if (cwd.kind === "unknown") return null;
  return prefix === "" ? normalizeAbsolute(cwd.path) : resolveAgainst(cwd.path, prefix);
}

/** ReadScope 是否有任何 root / file 嚴格位於 dir 之下。 */
function hasStrictDescendant(s: ReadScope, dir: string): boolean {
  return [...s.roots, ...s.files].some((x) => {
    const n = normalizeAbsolute(x);
    return n !== dir && isWithin(dir, n);
  });
}

/**
 * glob 路徑操作元的範圍判定（三態）。glob 展開結果必落在字面前綴目錄 P 之下，故判定 P 是否被
 * 「以目錄形式」涵蓋：專案根 → 涵蓋；外部則需 allow root / trusted root 涵蓋（**精確單檔 allow
 * 不算**），且 P 之下不得有任何 deny/ask 條目（glob 可能展開進被否決的子樹）。
 */
export function resolveGlobPath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  const g = parseGlobPath(arg);
  if (g === null) return "dynamic";
  const p = globPrefixAbs(g.prefix, cwd);
  if (p === null) return "dynamic";
  if (isWithin(scope.root, p)) return "in-project"; // root-first
  if (hits(scope.deny, p) || hits(scope.ask, p)) return "out-of-project";
  const covered = scope.allow.roots.some((r) => isWithin(r, p)) ||
    scope.trusted.some((r) => isWithin(r, p));
  if (!covered) return "out-of-project";
  if (hasStrictDescendant(scope.deny, p) || hasStrictDescendant(scope.ask, p)) return "out-of-project";
  return "in-project";
}

/**
 * glob 操作元是否可能選中磁碟根 / 家目錄根：前綴 P 本身是危險根（展開為其子項，效果等同遍歷整個根；
 * Windows 上 `/` 的子項 `/c` 即磁碟根），或 P 是家目錄的祖先（可能選中家目錄本身，如 `/home/m?`）。
 * cwd unknown 且前綴相對 → true（fail-closed）。非合格 glob 形態 → false（它不會被當成 glob 操作元接受）。
 */
export function globMaySelectDangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean {
  const g = parseGlobPath(arg);
  if (g === null) return false;
  const p = globPrefixAbs(g.prefix, cwd);
  if (p === null) return true;
  if (isDangerousRootAbs(p, home)) return true;
  return home !== null && isWithin(p, normalizeAbsolute(home));
}
```

（`hits`、`resolveAgainst`、`isAbsolute`、`isWithin`、`isDangerousRootAbs`、`normalizeAbsolute` 皆為 scope.ts 既有函式；`ReadScope` 已由第 4 行 `import type` 匯入。）

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過

- [ ] **Step 6: Commit（git-master）**

檔案：`src/engine/scope.ts`、`src/engine/scope_test.ts`
Message: `feat(engine): add glob prefix scope and dangerous-root resolution`

---

### Task 3: `CommandSpec` / `parseArgv` 分類 glob token

**Files:**
- Modify: `src/rules/command_spec.ts`
- Test: `src/rules/command_spec_test.ts`（檔尾新增）

- [ ] **Step 1: 寫失敗測試**

在 `src/rules/command_spec_test.ts` 檔尾新增（`ctxOf`、`DEMO` 為檔內既有）：

```ts
const GLOB_SPEC: CommandSpec = {
  flags: [
    { name: "-e", value: "required" },
    { name: "--include", value: "required", valueAcceptsGlob: true },
    { name: "--file", value: "required", valueIsPath: true },
  ],
  positionals: (seen) => (seen.has("-e") ? "paths" : "pattern-then-paths"),
  globOperands: true,
};

Deno.test("parseArgv: glob 路徑操作元收進 globOperands、不標 dynamic", () => {
  const p = parseArgv(ctxOf("demo", "demo x *.md sub/*.md a.txt"), GLOB_SPEC);
  assertEquals(p.dynamic, false);
  assertEquals(p.globOperands.map((w) => w.value), ["*.md", "sub/*.md"]);
  assertEquals(p.pathOperands.map((w) => w.value), ["a.txt"]);
  assertEquals(p.nonPathOperands.map((w) => w.value), ["x"]);
});

Deno.test("parseArgv: glob 落在 PATTERN 位置或作為獨立 token 旗標值 → dynamic", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo *.md a.txt"), GLOB_SPEC).dynamic, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -e *.md a.txt"), GLOB_SPEC).dynamic, true);
});

Deno.test("parseArgv: 黏寫 glob 值只對 valueAcceptsGlob 旗標成立", () => {
  const ok = parseArgv(ctxOf("demo", "demo --include=*.md x ."), GLOB_SPEC);
  assertEquals(ok.dynamic, false);
  assertEquals(ok.seenFlags.has("--include"), true);
  assertEquals(ok.globOperands.length, 0);
  assertEquals(parseArgv(ctxOf("demo", "demo --file=*.x x ."), GLOB_SPEC).dynamic, true);
  assertEquals(parseArgv(ctxOf("demo", "demo --include=*/../x x ."), GLOB_SPEC).dynamic, true);
});

Deno.test("parseArgv: 不合格的 glob 形態仍為 dynamic", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -e x .*"), GLOB_SPEC).dynamic, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -e x */y"), GLOB_SPEC).dynamic, true);
});

Deno.test("parseArgv: 未開 globOperands 的 spec，glob 維持 dynamic", () => {
  const p = parseArgv(ctxOf("demo", "demo -b *.md"), DEMO);
  assertEquals(p.dynamic, true);
  assertEquals(p.globOperands.length, 0);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/command_spec_test.ts`
Expected: FAIL（型別錯誤：`valueAcceptsGlob` / `globOperands` 不存在）

- [ ] **Step 3: 實作**

`src/rules/command_spec.ts`：

1. import 區塊新增：

```ts
import { isGlobAttachedValue, parseGlobPath } from "../engine/glob.ts";
```

2. `FlagSpec` 介面在 `valueIsPath?: boolean;` 之後新增：

```ts
  /**
   * 黏寫值（`--opt=<glob>`）是否容許含 glob 字元。僅適用於值**不是路徑**的 "required" 長旗標
   * （grep 的 --include / --exclude）。形態由 glob.ts 的 isGlobAttachedValue 判定（單段、無反斜線）。
   */
  valueAcceptsGlob?: boolean;
```

3. `CommandSpec` 介面在 `recursive?: ...;` 之後新增：

```ts
  /**
   * opt-in：接受合格的 glob 路徑操作元（glob.ts 的 parseGlobPath）。只有經旗標注入分析確認
   * 「任何旗標被注入都無害」的固定清單（grep/egrep/fgrep、head、wc）可開啟。
   */
  globOperands?: boolean;
```

4. `ArgvParse` 介面在 `pathOperands: Word[];` 之後新增：

```ts
  /** 合格的 glob 路徑操作元（需走 resolveGlobPath）；不含於 pathOperands。 */
  globOperands: Word[];
```

5. `doParse` 內，在 `let optionsDone = false;` 之後新增：

```ts
  const globs = new Set<Word>();
```

6. `doParse` 迴圈開頭的

```ts
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }
```

改為：

```ts
    const t = staticValue(argv[i]);
    if (t === null) {
      const w = argv[i];
      // `--include=*.md`：值不是路徑、且 glob 只會展開成同一旗標的不同值 → 記為該旗標，不標 dynamic
      if (!optionsDone) {
        const globFlag = spec.flags.find((s) =>
          s.value === "required" && s.valueAcceptsGlob === true && isGlobAttachedValue(w, s.name)
        );
        if (globFlag) { see(globFlag.name, null); continue; }
      }
      if (spec.globOperands && parseGlobPath(w) !== null) {
        positional.push(w);
        globs.add(w);
        continue;
      }
      dynamic = true;
      continue;
    }
```

7. `doParse` 尾端，在

```ts
  if (kind === "pattern-then-paths" && positional.length > 0) {
    nonPathOperands = positional.slice(0, 1);
    pathOperands = positional.slice(1);
  }
```

之後新增：

```ts
  // glob 落在非路徑位置（grep 的 PATTERN）→ 展開結果會改變 PATTERN / FILE 分界，無法靜態判定
  if (nonPathOperands.some((w) => globs.has(w))) dynamic = true;
  const globOperands = pathOperands.filter((w) => globs.has(w));
  pathOperands = pathOperands.filter((w) => !globs.has(w));
```

8. `return { ... }` 物件在 `pathOperands,` 之後新增一行 `globOperands,`。

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/rules/command_spec_test.ts`
Expected: PASS

- [ ] **Step 5: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過（尚未有任何 spec 開啟 `globOperands`，既有行為不變）

- [ ] **Step 6: Commit（git-master）**

檔案：`src/rules/command_spec.ts`、`src/rules/command_spec_test.ts`
Message: `feat(rules): classify glob operands and attached glob values in parseArgv`

---

### Task 4: 危險根閘門、注入護欄與 spec 路徑接線（grep / head / wc）

**Files:**
- Modify: `src/rules/types.ts`（`RuleContext` 新增兩個選填方法）
- Modify: `src/rules/factory.ts`（`globRootGate`、`injectionGuard`、`evaluateWithSpec`、`cwdIndependent` 述詞）
- Modify: `src/rules/commands/grep.ts`
- Modify: `src/rules/commands/coreutils.ts`（僅 `HEAD_SPEC` / `WC_SPEC`）
- Test: `src/rules/commands/grep_test.ts`、`src/rules/commands/coreutils_test.ts`

- [ ] **Step 1: 寫失敗測試（grep）**

`src/rules/commands/grep_test.ts`：把第 6 行 import 改為

```ts
import { dangerousRoot, globMaySelectDangerousRoot, resolveGlobPath, resolvePath, resolvePathValue, rootScope, type ScopeConfig } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";
```

檔尾新增：

```ts
const HOME = "/home/me";
/** 家目錄被 Read(~/**) 放行 / 磁碟根被 Read(//**) 放行的設定：危險根 deny 不得受其影響。 */
const HOME_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: [HOME], files: [] } };
const ROOT_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: ["/"], files: [] } };

/** 可指定 cwd / home / scope，並綁定 glob 相關方法的 RuleContext。 */
function envCtx(
  name: string,
  src: string,
  env: { cwd?: string; home?: string | null; scope?: ScopeConfig } = {},
): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd: CwdState = { kind: "known", path: env.cwd ?? "/proj" };
  const home = env.home === undefined ? HOME : env.home;
  const scope = env.scope ?? { ...rootScope("/proj"), home };
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, cwd, scope),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, home),
    resolveGlobPath: (w) => resolveGlobPath(w, cwd, scope),
    globMaySelectDangerousRoot: (w) => globMaySelectDangerousRoot(w, cwd, home),
  };
}

Deno.test("grep glob: allow", () => {
  for (
    const src of [
      "grep -n x *.md sub/*.md",
      "grep -rn x --include=*.md .",
      'grep -rn "Nginx 5xx" --include=*.md .',
      'grep -n "careTreatment\\|WebApi\\|webapi" *.md runtime-behavior/*.md',
      'grep "a\\|b" *.md',
      "grep -m 5 x *.md",
      "grep -rn x *.md",
      "grep /outside/secret ./*.md", // 有字面前綴、不會注入 → 不套用注入護欄
    ]
  ) {
    assertEquals(grepRule.evaluate(envCtx("grep", src)).kind, "allow", src);
  }
});

Deno.test("grep glob: ask", () => {
  for (
    const src of [
      "grep *.md f", // glob 在 PATTERN 位置
      "grep -e *.md f", // glob 作為獨立 token 旗標值
      "grep -f *.x f",
      "grep x ../*.md", // 前綴在範圍外
      "grep x /home/m?/a.md", // 非遞迴、無注入 → 不觸發危險根閘門，依一般範圍判定
      // 注入護欄
      "grep /outside/secret *.md",
      "grep *.md -e /outside",
      "grep -e . ?? --label=/../../secret",
      "grep /outside/secret -- *.md", // 護欄不看 --
      "grep -n x *.md --include=*.md", // 裸 glob + 非靜態旗標值
      "grep ?e -e --file=/outside/secret ./safe.txt",
      "grep ?e -e -f/outside/secret ./safe.txt",
      "grep ?e -e --file=C:secret ./safe.txt",
    ]
  ) {
    assertEquals(grepRule.evaluate(envCtx("grep", src)).kind, "ask", src);
  }
});

Deno.test("grep glob: 危險根 deny（不受讀取放寬影響、不被 ask 搶先）", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    for (
      const src of [
        "grep x ?r ~", // 注入 -r
        "grep -r x /home/m?",
        "grep -r x /*",
        "grep x /home/me/**/*.md", // globstar 視為遞迴
      ]
    ) {
      assertEquals(grepRule.evaluate(envCtx("grep", src, { scope })).kind, "deny", src);
    }
    assertEquals(grepRule.evaluate(envCtx("grep", "grep -r x m?", { cwd: "/home", scope })).kind, "deny");
  }
});

Deno.test("grep glob: 磁碟根 glob → deny（含 Read(//C:/**) 放行時）", () => {
  const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
  for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
    for (const src of ["grep -r x C:/*", "grep x C:/**/*.md"]) {
      assertEquals(grepRule.evaluate(envCtx("grep", src, { cwd: "D:/proj", scope })).kind, "deny", src);
    }
  }
});

Deno.test({
  name: "grep glob: Windows 上 /c/* → deny（含 Read(//C:/**) 放行時）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
    for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
      for (const src of ["grep -r x /c/*", "grep x /c/**/*.md"]) {
        assertEquals(grepRule.evaluate(envCtx("grep", src, { cwd: "D:/proj", scope })).kind, "deny", src);
      }
    }
  },
});

Deno.test("grep glob: 未提供 glob 方法的 RuleContext → fail-closed ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -n x src/*.md")).kind, "ask");
});
```

- [ ] **Step 2: 寫失敗測試（head / wc）**

`src/rules/commands/coreutils_test.ts`：把第 6 行 import 改為

```ts
import { dangerousRoot, globMaySelectDangerousRoot, resolveGlobPath, resolvePath, resolvePathValue, rootScope, type ScopeConfig } from "../../engine/scope.ts";
```

在 `ctxOf` 函式之後新增：

```ts
const HOME = "/home/me";
const HOME_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: [HOME], files: [] } };
const ROOT_OPEN: ScopeConfig = { ...rootScope("/proj"), home: HOME, allow: { roots: ["/"], files: [] } };

/** 可指定 cwd / home / scope，並綁定 glob 相關方法的 RuleContext。 */
function envCtx(
  src: string,
  env: { cwd?: string; home?: string | null; scope?: ScopeConfig } = {},
): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd: CwdState = { kind: "known", path: env.cwd ?? "/proj" };
  const home = env.home === undefined ? HOME : env.home;
  const scope = env.scope ?? { ...rootScope("/proj"), home };
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, cwd, scope),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, home),
    resolveGlobPath: (w) => resolveGlobPath(w, cwd, scope),
    globMaySelectDangerousRoot: (w) => globMaySelectDangerousRoot(w, cwd, home),
  };
}
```

檔尾新增：

```ts
Deno.test("head / wc glob: allow", () => {
  for (const src of ["wc -l *.md", "head *.md", "head -n 5 src/*.ts", "wc -l runtime-behavior/*.md"]) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "allow", src);
  }
});

Deno.test("head / wc glob: ask", () => {
  for (
    const src of [
      "wc --files0-from=*.x", // 吃路徑值的旗標，黏寫 glob 不容許
      "head *.md -n /outside/x", // 注入護欄：-n 的值可能被推成檔案
      "head ../*.md",
    ]
  ) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "ask", src);
  }
});

Deno.test("head glob: globstar 選中危險根 → deny", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    assertEquals(fileReaderRule.evaluate(envCtx("head /**/*.md", { scope })).kind, "deny");
  }
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/grep_test.ts src/rules/commands/coreutils_test.ts`
Expected: FAIL（型別錯誤：`RuleContext` 無 `resolveGlobPath` / `globMaySelectDangerousRoot`）

- [ ] **Step 4: `RuleContext` 新增選填方法**

`src/rules/types.ts` 的 `RuleContext` 介面，在 `isDangerousRoot(arg: Word): boolean;` 之後新增：

```ts
  /**
   * glob 路徑操作元的範圍判定（前綴目錄須以目錄形式被涵蓋）。
   * 選填；未提供時呼叫端視同 "dynamic"（fail-closed → ask）。classify 永遠提供。
   */
  resolveGlobPath?(arg: Word): PathScope;
  /**
   * glob 操作元是否可能選中磁碟根 / 家目錄根。
   * 選填；未提供時呼叫端視同 true（fail-closed → deny）。classify 永遠提供。
   */
  globMaySelectDangerousRoot?(arg: Word): boolean;
```

- [ ] **Step 5: `factory.ts` 新增兩道閘門並接到 spec 路徑**

`src/rules/factory.ts`：

1. import 區塊新增：

```ts
import { hasGlobstarSegment, mayExpandToOption } from "../engine/glob.ts";
```

2. 在 `evaluateWithSpec` 函式之前新增：

```ts
/**
 * 旗標注入護欄允許旗標 token 使用的字元。排除 `/` `\` `:` `~` 後，被注入旗標吞掉原旗標而使其
 * 生效時，任何黏寫值（`--file=x`、`-fx`）都只能指向 cwd 內的某個檔名。
 */
const SAFE_OPTION_TOKEN = /^[A-Za-z0-9_=.,+-]+$/;

/**
 * glob 危險根閘門（spec 與 legacy 兩條路徑共用），必須先於任何可能回 ask 的檢查。
 * 遞迴（明確旗標、被注入的 -r/-R、或 globstar）時，glob 可能選中磁碟根 / 家目錄根 → 硬 deny；
 * 有注入風險時，其餘 argv 指向危險根者也 deny（注入的遞迴旗標會作用在它們身上）。
 * 不受任何讀取範圍放寬影響，以維持「遞迴遍歷磁碟根/家目錄根 = 硬 deny」。
 */
export function globRootGate(ctx: RuleContext, globWords: Word[], isRecursive: boolean): RuleVerdict | null {
  if (globWords.length === 0) return null;
  const injectable = globWords.some(mayExpandToOption);
  const globstar = globWords.some(hasGlobstarSegment);
  if (!(isRecursive || injectable || globstar)) return null;
  for (const w of globWords) {
    if (ctx.globMaySelectDangerousRoot?.(w) ?? true) return deny(recursiveRootDenyReason(ctx.name, w.value));
  }
  if (injectable) {
    for (const w of ctx.argv) {
      if (!globWords.includes(w) && ctx.isDangerousRoot(w)) return deny(recursiveRootDenyReason(ctx.name, w.value));
    }
  }
  return null;
}

/**
 * 旗標注入護欄（spec 與 legacy 兩條路徑共用）。有「可能展開成旗標」的 glob 時，被注入的旗標可改變
 * 任何其他 token 的解讀（PATTERN 變檔案、`--` 使旗標變檔案、吃值旗標吞掉下一 token），故其餘每個
 * token 都必須能當成路徑且落在範圍內；以 `-` 開頭者另須只含安全字元。
 */
export function injectionGuard(ctx: RuleContext, globWords: Word[]): RuleVerdict | null {
  if (!globWords.some(mayExpandToOption)) return null;
  for (const w of ctx.argv) {
    if (globWords.includes(w)) continue;
    const reason = `${ctx.name}：glob 可能展開成旗標，${w.value} 可能被當成檔案讀取且超出範圍`;
    if (ctx.resolvePath(w) !== "in-project") return ask(reason);
    const t = staticValue(w);
    if (t !== null && t.startsWith("-") && !SAFE_OPTION_TOKEN.test(t)) return ask(reason);
  }
  return null;
}
```

3. 把 `evaluateWithSpec` 整個函式替換為：

```ts
/** spec 驅動的判定；與 cwdIndependent 共用 parseArgv 的同一份快取結果。 */
function evaluateWithSpec(ctx: RuleContext, spec: CommandSpec): RuleVerdict {
  const p = parseArgv(ctx, spec);
  // 遞迴根 deny 必須先於任何路徑 ask，否則既有硬 deny 會被降級成 ask。
  // 危險根可能藏在被 value-flag 吃掉的位置，故掃描全部 argv token。
  if (p.isRecursive) {
    for (const w of ctx.argv) {
      if (ctx.isDangerousRoot(w)) return deny(recursiveRootDenyReason(ctx.name, w.value));
    }
  }
  const gate = globRootGate(ctx, p.globOperands, p.isRecursive);
  if (gate) return gate;
  if (p.dynamic) return ask(`${ctx.name}：含動態 token，無法靜態判定`);
  if (p.unknownFlag !== null) {
    return ask(`${ctx.name}：未列入安全集合的旗標 ${p.unknownFlag}`);
  }
  for (const v of p.pathValues) {
    if (ctx.resolvePathValue(v) !== "in-project") {
      return ask(`${ctx.name}：旗標的路徑值超出專案範圍或無法解析（${v}）`);
    }
  }
  for (const arg of p.pathOperands) {
    if (ctx.resolvePath(arg) !== "in-project") {
      return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
    }
  }
  for (const arg of p.globOperands) {
    if ((ctx.resolveGlobPath?.(arg) ?? "dynamic") !== "in-project") {
      return ask(`${ctx.name}：glob 路徑超出專案範圍或無法靜態解析（${arg.value}）`);
    }
  }
  return injectionGuard(ctx, p.globOperands) ?? allow();
}
```

4. `flagGatedReader` 回傳物件中 `cwdIndependent` 述詞的最後一個 `return` 改為：

```ts
        return !p.isRecursive && !p.dynamic && p.unknownFlag === null &&
          p.pathOperands.length === 0 && p.pathValues.length === 0 && p.globOperands.length === 0;
```

- [ ] **Step 6: grep / head / wc 開啟 glob**

`src/rules/commands/grep.ts`：

1. 在 `const PATH_VALUE = [...]` 之後新增：

```ts
/** 值是 grep 自己的檔名 glob（不是路徑）；黏寫形態 `--include=*.md` 可容許 shell glob 字元。 */
const GLOB_VALUE = new Set(["--include", "--exclude"]);
```

2. `flags` 陣列中的

```ts
  ...NON_PATH_VALUE.map((name): FlagSpec => ({ name, value: "required" })),
```

改為：

```ts
  ...NON_PATH_VALUE.map((name): FlagSpec => ({
    name,
    value: "required",
    ...(GLOB_VALUE.has(name) ? { valueAcceptsGlob: true } : {}),
  })),
```

3. `specFor` 回傳物件新增 `globOperands: true,`：

```ts
function specFor(_name: string, argv: Word[]): CommandSpec {
  return {
    flags,
    positionals: positionalsFor,
    recursive: (name, seen) => recursiveFor(name, seen, argv),
    globOperands: true,
  };
}
```

`src/rules/commands/coreutils.ts`：`HEAD_SPEC` 與 `WC_SPEC` 各新增 `globOperands: true`，改完後兩者為：

```ts
const HEAD_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-c", "--bytes", "-n", "--lines"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
  numericShorthand: true, // head -100
  globOperands: true, // 固定清單成員：旗標被 glob 注入也無害
};

const WC_SPEC: CommandSpec = {
  flags: [
    ...["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    { name: "--files0-from", value: "required", valueIsPath: true },
  ],
  positionals: "paths",
  globOperands: true, // 固定清單成員；注入 --files0-from 的殘留風險為已接受限制
};
```

- [ ] **Step 7: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/grep_test.ts src/rules/commands/coreutils_test.ts src/rules/command_spec_test.ts`
Expected: PASS

- [ ] **Step 8: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過

- [ ] **Step 9: Commit（git-master）**

檔案：`src/rules/types.ts`、`src/rules/factory.ts`、`src/rules/commands/grep.ts`、`src/rules/commands/coreutils.ts`、`src/rules/commands/grep_test.ts`、`src/rules/commands/coreutils_test.ts`
Message: `feat(rules): accept glob operands for grep/head/wc with root gate and injection guard`

---

### Task 5: legacy 路徑接線（cat / ls）與 ls 群集遞迴偵測

**Files:**
- Modify: `src/rules/factory.ts`（`FlagGatedReaderOptions.globOperandNames`、legacy 分支）
- Modify: `src/rules/commands/coreutils.ts`（`fileReaderRule`）
- Test: `src/rules/commands/coreutils_test.ts`（檔尾新增；沿用 Task 4 的 `envCtx`、`HOME_OPEN`、`ROOT_OPEN`）

- [ ] **Step 1: 寫失敗測試**

`src/rules/commands/coreutils_test.ts` 檔尾新增：

```ts
Deno.test("cat / ls glob: allow", () => {
  for (const src of ["cat src/*.ts", "cat src/**/*.ts", "ls *.md", "ls -la *.md", "ls -lR src"]) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "allow", src);
  }
});

Deno.test("cat / ls glob: ask", () => {
  for (
    const src of [
      "cat ../*.md", // 前綴在範圍外
      "ls .*", // . 開頭 glob 段不合格
      "stat *.md", // 清單外成員
      "cat *.md --x=/../../secret", // 注入護欄：注入 -- 使旗標變檔案
      "ls -la *.md --hide=/../../x",
      "cat /home/me/*.md", // 非遞迴、無注入 → 不觸發閘門，依一般範圍判定
    ]
  ) {
    assertEquals(fileReaderRule.evaluate(envCtx(src)).kind, "ask", src);
  }
});

Deno.test("cat / ls glob: 危險根 deny（不受讀取放寬影響、不被 ask 搶先）", () => {
  for (const scope of [undefined, HOME_OPEN, ROOT_OPEN]) {
    for (
      const src of [
        "ls ?R /", // 注入 -R
        "ls -R /home/me/*",
        "ls -lR /home/me/*",
        "ls -lR /*",
        "cat /home/me/**/*.md", // globstar 視為遞迴
        "ls -lR ~", // 群集遞迴偵測（既有行為收緊）
        "ls -lR /",
      ]
    ) {
      assertEquals(fileReaderRule.evaluate(envCtx(src, { scope })).kind, "deny", src);
    }
  }
});

Deno.test("cat / ls glob: 磁碟根 glob → deny（含 Read(//C:/**) 放行時）", () => {
  const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
  for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
    for (const src of ["ls -R C:/*", "ls -lR C:/*", "cat C:/**/*.md"]) {
      assertEquals(fileReaderRule.evaluate(envCtx(src, { cwd: "D:/proj", scope })).kind, "deny", src);
    }
  }
});

Deno.test({
  name: "cat / ls glob: Windows 上 /c/* → deny（含 Read(//C:/**) 放行時）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const DRIVE_OPEN: ScopeConfig = { ...rootScope("D:/proj"), home: HOME, allow: { roots: ["C:/"], files: [] } };
    for (const scope of [rootScope("D:/proj"), DRIVE_OPEN]) {
      for (const src of ["ls -lR /c/*", "cat /c/**/*.md"]) {
        assertEquals(fileReaderRule.evaluate(envCtx(src, { cwd: "D:/proj", scope })).kind, "deny", src);
      }
    }
  },
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: FAIL。`cat src/*.ts` 等 allow 案例回 ask；`ls -lR ~` 在此測試設定（未提供 shellHome）下回 ask 而非 deny，因為 `-lR` 尚未被認成遞迴；`ls -lR /home/me/*` 等回 ask 而非 deny。

- [ ] **Step 3: `factory.ts` legacy 分支接線**

`src/rules/factory.ts`：

1. import 行 `import { hasGlobstarSegment, mayExpandToOption } from "../engine/glob.ts";` 改為：

```ts
import { hasGlobstarSegment, mayExpandToOption, parseGlobPath } from "../engine/glob.ts";
```

2. `FlagGatedReaderOptions` 介面在 `cwdIndependentExtraGuard?: ...;` 之後新增：

```ts
  /**
   * legacy 路徑（未提供 spec 者）中接受合格 glob 路徑操作元的指令名。只有經旗標注入分析確認
   * 「任何旗標被注入都無害」的固定清單（cat、ls）可列入。
   */
  globOperandNames?: string[];
```

3. `flagGatedReader` 的 `evaluate` 中，從 `const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;` 到函式結尾 `return allow();` 的整段替換為：

```ts
      const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;
      if (isRecursive) {
        for (const w of ctx.argv) {
          if (ctx.isDangerousRoot(w)) {
            return deny(recursiveRootDenyReason(ctx.name, w.value));
          }
        }
      }
      const pos = positionals(ctx.argv, valueFlags);
      const globWords = (opts.globOperandNames ?? []).includes(ctx.name)
        ? pos.filter((w) => parseGlobPath(w) !== null)
        : [];
      const gate = globRootGate(ctx, globWords, isRecursive);
      if (gate) return gate;
      const pathFlagVerdict = checkPathValueFlags(ctx, opts.pathValueFlags ?? []);
      if (pathFlagVerdict) return pathFlagVerdict;
      for (const arg of pos) {
        const scope = globWords.includes(arg)
          ? (ctx.resolveGlobPath?.(arg) ?? "dynamic")
          : ctx.resolvePath(arg);
        if (scope !== "in-project") {
          return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
        }
      }
      return injectionGuard(ctx, globWords) ?? allow();
```

（原本位於此段前面的註解「遞迴根 deny 必須先於任何路徑 ask…」保留不動。）

- [ ] **Step 4: `fileReaderRule` 開啟 cat/ls 並補強 ls 遞迴偵測**

`src/rules/commands/coreutils.ts`：

1. 在 `const SPECS: Record<string, CommandSpec> = ...` 之後新增：

```ts
/**
 * ls 短旗標群集含 R（`-lR`、`-Rla`）代表遞迴。與 grep.ts 的 shortClusterHasR 同形式；
 * 可能多判（`-wR` 的 R 其實是 -w 的值），方向安全。
 */
const lsShortClusterHasR: FlagMatcher = (t) =>
  /^-[^-]/.test(t) && !t.includes("=") && t.slice(1).includes("R");
```

2. `fileReaderRule` 的

```ts
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
```

改為：

```ts
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive"), lsShortClusterHasR]),
```

3. `fileReaderRule` 在 `cwdDependentNames: ["ls"],` 之後新增：

```ts
  // 固定清單：cat / ls 的所有旗標（coreutils 8.32）皆無寫檔、執行程式、讀取操作元以外檔案的副作用，
  // 被 glob 注入也無害。清單不擴增；其餘成員含 glob 維持 ask。
  globOperandNames: ["cat", "ls"],
```

- [ ] **Step 5: 執行測試確認通過**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: PASS

- [ ] **Step 6: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過

- [ ] **Step 7: Commit（git-master）**

檔案：`src/rules/factory.ts`、`src/rules/commands/coreutils.ts`、`src/rules/commands/coreutils_test.ts`
Message: `feat(rules): accept glob operands for cat/ls and detect clustered ls -R`

---

### Task 6: `classify.ts` 綁定、端到端測試與 operational verification

**Files:**
- Modify: `src/engine/classify.ts`
- Test: `src/engine/classify_test.ts`（檔尾新增）
- Modify: `scripts/verify-hook-binary.ts`（`CASES` 陣列）

- [ ] **Step 1: 寫失敗測試**

`src/engine/classify_test.ts` 檔尾新增（`only`、`onlyWith`、`rulesOf`、`evaluate`、`ROOT`、`START` 為檔內既有）：

```ts
Deno.test("glob: 清單內指令經 classify 綁定後 allow", () => {
  for (const src of ["wc -l *.md", "head *.md", "cat src/*.ts", "ls *.md", "grep -n x *.md sub/*.md"]) {
    assertEquals(only(src).kind, "allow", src);
  }
});

Deno.test("glob: 輸入重導向 < 的 glob 目標仍 ask（resolvePath 未放寬）", () => {
  assertEquals(only("cat < *.md").kind, "ask");
});

Deno.test("glob: 清單外指令含 glob 維持 ask", () => {
  for (const src of ["stat *.md", "tail *.md", "diff *.md x", "sort *.md"]) {
    assertEquals(only(src).kind, "ask", src);
  }
});

Deno.test("glob: Bash(stat *) 不會升級含 glob 的 stat", () => {
  assertEquals(onlyWith("stat *.md", rulesOf({ allow: ["Bash(stat *)"] })).kind, "ask");
});

Deno.test("glob: chain-cd 到專案外不因 cwd 豁免放行", () => {
  assertEquals(evaluate("cd /outside && wc -l *.md", ROOT, START).verdict, "ask");
});

Deno.test("glob: 使用者範例三條指令 allow", () => {
  for (
    const src of [
      "ls -la && wc -l *.md",
      'grep -rn "Nginx 5xx" --include=*.md . | head -40',
      'grep -n "careTreatment\\|WebApi\\|webapi" *.md runtime-behavior/*.md | head -40',
    ]
  ) {
    assertEquals(evaluate(src, ROOT, START).verdict, "allow", src);
  }
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL。classify 尚未提供兩個 glob 方法，因此走 Task 4 的 fail-closed fallback：
- 含開頭即 glob 元字元者（`wc -l *.md`、`head *.md`、`ls *.md`、`grep -n x *.md sub/*.md`、範例 1 與 3）→ `globMaySelectDangerousRoot` 缺席視同 true → **deny**；
- 有字面前綴、非遞迴者（`cat src/*.ts`）→ `resolveGlobPath` 缺席視同 dynamic → **ask**；
- 範例 2（只有黏寫值 glob、無 glob 操作元）此時已是 allow，該斷言通過。
其餘 ask 類斷言此時已通過。只要失敗的斷言恰為上述 allow 類，即為預期狀態。

- [ ] **Step 3: 實作 classify 綁定**

`src/engine/classify.ts`：

1. 第 5 行 import 改為：

```ts
import { buildScopeConfig, dangerousRoot, globMaySelectDangerousRoot, isReadScoped, normalizeAbsolute, resolveGlobPath, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
```

2. `const ctx: RuleContext = { ... }` 物件在 `isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),` 之後新增：

```ts
    resolveGlobPath: (w) => resolveGlobPath(w, inv.cwd, scope),
    globMaySelectDangerousRoot: (w) => globMaySelectDangerousRoot(w, inv.cwd, scope.home),
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS

- [ ] **Step 5: 新增 operational verification 案例**

`scripts/verify-hook-binary.ts` 的 `CASES` 陣列：

在 `// ---- 期望 allow ----` 區段最後一個案例（`cd "$(cygpath -u <專案根>)" && cat deno.json` 那筆）之後新增：

```ts
  {
    description: "ls -la && wc -l *.md（清單內 wc 接受裸 glob）",
    command: () => "ls -la && wc -l *.md",
    expected: "allow",
  },
  {
    description: "grep -rn --include=*.md . | head（grep 黏寫值 glob）",
    command: () => 'grep -rn "Nginx 5xx" --include=*.md . | head -40',
    expected: "allow",
  },
  {
    description: "grep -n 多個 glob 操作元 | head",
    command: () => 'grep -n "careTreatment\\|WebApi\\|webapi" *.md runtime-behavior/*.md | head -40',
    expected: "allow",
  },
```

在陣列最後一個案例（`cd "$(echo C:Windows)" && cat win.ini` 那筆）之後、`];` 之前新增：

```ts
  {
    description: "cat < *.md（< 目標的 glob 不放寬）",
    command: () => "cat < *.md",
    expected: "ask",
  },
  {
    description: "stat *.md（清單外指令含 glob）",
    command: () => "stat *.md",
    expected: "ask",
  },
  {
    description: "grep *.md f（glob 在 PATTERN 位置）",
    command: () => "grep *.md f",
    expected: "ask",
  },
  {
    description: "ls .*（. 開頭 glob 段在 globskipdots 關閉時會產生 ..）",
    command: () => "ls .*",
    expected: "ask",
  },
  {
    description: "grep /outside/secret *（注入 -e 會使 PATTERN 變成檔案）",
    command: () => "grep /outside/secret *",
    expected: "ask",
  },
```

- [ ] **Step 6: 驗證（含 build 與 operational verification）**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過

Run: `deno run --allow-run --allow-read --allow-write --allow-env scripts/verify-hook-binary.ts`
Expected: 腳本自行 `deno task build`，所有案例（含新增 8 筆）PASS，結束碼 0。

- [ ] **Step 7: Commit（git-master）**

檔案：`src/engine/classify.ts`、`src/engine/classify_test.ts`、`scripts/verify-hook-binary.ts`
Message: `feat(engine): bind glob resolution into rule context and add verification cases`

---

### Task 7: `CLAUDE.md` 文件同步

**Files:**
- Modify: `CLAUDE.md`

文件須自我完備（CLAUDE.md 會被簽入），不得引用本機 MEMORY。

- [ ] **Step 1: 「這是什麼」一節補充**

在第一段（以「一個 Claude Code `PreToolUse`（matcher: `Bash`）hook」開頭、以「從 stdin 收 hook JSON…永遠 `exit 0`。」結尾的段落）之後新增一段：

```markdown
glob 支援限於**固定清單**：`grep`/`egrep`/`fgrep`、`head`、`wc`、`cat`、`ls`。合格的 glob 路徑操作元（`*.md`、`runtime-behavior/*.md`、`src/**/*.ts`）與 grep 的黏寫值 glob（`--include=*.md`）在能以純詞法確認展開結果落在讀取範圍內時 `allow`；清單外指令、`<` 重導向目標、不合格形態一律維持 `ask`。
```

- [ ] **Step 2: 架構一節新增 glob 模組說明**

在 `## 架構（評估管線）` 的 `- **`tilde.ts`**` 項目之後新增：

```markdown
- **`glob.ts`** glob 路徑操作元的純詞法形態判定：`parseGlobPath(word)` 只接受完全未加引號、無反斜線、
  不以 `-`/`~` 開頭、非磁碟相對的 word，且 (a) 開頭即 glob 元字元者（`mayExpandToOption`）必須是單段、
  (b) 第一個 glob 段起不得有字面 `..`、含 glob 字元的段不得以 `.` 或 `[` 開頭；回傳字面前綴。
  `isGlobAttachedValue(word, flag)` 判定 `--flag=<glob>`（單段、無反斜線）；`hasGlobstarSegment` 偵測 `**` 段。
  `scope.ts` 的 `resolveGlobPath` 判定前綴目錄是否被**以目錄形式**涵蓋（專案根 / allow root / trusted root；
  精確單檔的 allow 不算；外部前綴之下有 deny/ask 條目即否決），`globMaySelectDangerousRoot` 判定前綴是否為
  危險根或家目錄的祖先。`resolvePath` 不處理 glob（`<` 目標等仍 ask）。
  規則端以 `CommandSpec.globOperands` / `FlagSpec.valueAcceptsGlob`（grep/head/wc）或
  `FlagGatedReaderOptions.globOperandNames`（cat/ls）opt-in；兩條路徑共用 `factory.ts` 的
  `globRootGate`（遞迴、有注入風險或含 `**` 時，glob 可能選中危險根即硬 deny，先於任何 ask）與
  `injectionGuard`（有 `mayExpandToOption` 的 glob 時，其餘每個 token 都須能當成路徑落在範圍內，
  以 `-` 開頭者另須只含 `[A-Za-z0-9_=.,+-]`）。`RuleContext.resolveGlobPath` / `globMaySelectDangerousRoot`
  為選填（測試字面量不必提供），缺席時分別視同 `dynamic` / `true`（fail-closed）。
```

- [ ] **Step 3: 「不要再犯的問題」新增 bash glob 事實小節**

在 `### 第三方套件：unbash（禁止憑印象，已驗證的事實）` 小節之後、`### 安全誤放` 之前新增：

```markdown
### 第三方行為：bash pathname expansion（GNU bash 5.3.9 實測，禁止憑印象）

- 預設 shopt：`extglob`/`globstar`/`dotglob`/`nullglob`/`failglob` 皆 off，`globskipdots` on。
- **`shopt -u globskipdots` 時以字面 `.` 開頭的 glob 段會產生 `..`**：`.*` → `. .. .h`、`sub/.*` → `sub/..`、
  `.[.]` → `..`。不以 `.` 開頭的段（`??`、`[.]*`、`*`）在 dotglob / globskipdots 任一組合下皆不產生 `.`/`..`。
- **glob 段之後的字面 `..` 原樣保留**：`sub*/../x` → `subdir/../x`，逃出字面前綴。
- `*` `?` `[...]` 皆不匹配 `/`；globstar 未開時 `**` 等同 `*`，開啟時只在字面前綴之下遞迴。
- 無匹配：預設保留字面、`nullglob` 移除該 word、`failglob` 報錯並中止整段 script。
- **旗標形 word 也會展開**：`--include=*.md` 會匹配 cwd 內名為 `--include=x.md` 的檔案（結果仍以 `--include=` 開頭）。
- **檔名注入旗標**：cwd 有名為 `--x` 的檔案時 `cat *` 會把它當旗標（`cat: unknown option`）。本工具的旗標解析器
  看不到被注入的旗標，這正是 glob 支援限於固定清單、且需要 `injectionGuard` 的原因。
```

- [ ] **Step 4: 「安全誤放」小節新增 review 抓到的 glob 誤放**

在 `### 安全誤放（auto-allow 不該 allow）——這些是 review 實際抓到的` 小節最後一個 bullet（`base64` 的 `-w` 那筆）之後新增：

```markdown
- **glob 支援的清單是固定的，不可擴增**：被注入的旗標不在本工具的解析結果裡，逐指令擴增等同對 GNU
  全旗標集做 denylist。清單成員的注入分析：cat/ls（coreutils 8.32 對照 `src/cat.c`、`src/ls.c` 的
  `long_options[]`）與 head 所有旗標皆無寫檔、exec、讀取操作元以外檔案的副作用；grep 無寫檔 / exec 旗標，
  但注入 `-e`/`-f`/`--` 會翻轉位置參數分類（由 `injectionGuard` 處理）；wc 的 `--files0-from=<cwd 內檔名>`
  可讀出該檔所列任意路徑的**計數與檔名**。這是已接受的限制：攻擊者須先在專案內植入兩個特製檔名的檔案，
  且只洩漏計數與檔名、不洩漏內容。
- **注入會翻轉任何 token 的解讀**：cwd 有 `-e^` 檔時 `grep /outside/secret *` 會讀出 `/outside/secret` 內容；
  注入 `--` 使 `--label=/../../secret` 變成檔案；注入吃值旗標吞掉原本的 `-e`，使其值 `--file=/outside/secret`
  生效。故 `injectionGuard` 不區分 token 種類、全部當路徑檢查，並限制旗標 token 的字元集。
- **多段 glob 的注入值會帶 `/`**：專案內有名為 `-f` 的目錄時 `*/outside/secret` 展開成 `-f/outside/secret`。
  故開頭即 glob 元字元者必須單段；黏寫值 glob 亦必須單段（`--include=*/../../../**` 會遍歷 cwd 之外）。
- **glob 可繞過遞迴危險根 deny**：注入的 `-r`/`-R`（`grep x ?r ~`）、glob 選中家目錄（`grep -r x /home/m?`）、
  globstar（`cat /home/me/**/*.md`）。`globRootGate` 須先於任何 ask，且不受 `Read()` 放寬影響。
  ls 的遞迴偵測須認得群集寫法（`-lR`），否則閘門失效——這也使明寫的 `ls -lR ~` 從 allow 收緊為 deny。
- **精確單檔的 `Read()` allow 不可當成 glob 前綴目錄的授權**：`Read(//outside/data)` 只授權該路徑本身。
```

- [ ] **Step 5: 核心不變量補充**

在 `## 核心不變量（改動時不可違反）` 的 `- **deny 四類**：① 遞迴遍歷磁碟根/家目錄根（find/tree/ls -R/grep -r/rg）` 這句中，把 `（find/tree/ls -R/grep -r/rg）` 改為：

```markdown
（find/tree/ls -R（含 `-lR` 等群集）/grep -r/rg，以及清單內指令的 glob 經 `globRootGate` 判定可能遞迴選中危險根者）
```

- [ ] **Step 6: 驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部通過（文件變更不影響，但依規則仍須執行）

- [ ] **Step 7: Commit（git-master）**

檔案：`CLAUDE.md`
Message: `docs: document glob operand support, fixed command list and injection guards`
