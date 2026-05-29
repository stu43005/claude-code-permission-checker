# Bash 權限檢查器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Deno 撰寫、`deno compile` 成單一執行檔的 Claude Code PreToolUse hook，對 Bash 指令判定 `allow` / `ask`（永不 `deny`），只在「純唯讀且全部落在專案內」時自動允許。

**Architecture:** 無狀態 per-command 分類器 + 最弱環節合併。`unbash` 解析 → `walk` 列舉所有葉指令並穿 cwd 脈絡 → 每指令套 allowlist 規則（中央前置檢查 cwd 範圍與寫入重導向，再跑 per-command rule）→ 任一 `ask` 則整體 `ask`。所有路徑檢查純詞法、不碰 FS。

**Tech Stack:** Deno、TypeScript、`npm:unbash@3.0.0`（純 ESM、零相依）、`jsr:@std/assert`（測試）。

**Conventions（全程適用）:**
- 每個檔案單一職責；引擎為純函式，測試免 FS、免真 hook。
- 第三方型別一律從 `src/deps.ts` 單一入口匯入。
- 路徑一律以 posix 風格（`/`）正規化後比較；Windows drive 與 `\` 由 `scope.ts` 處理。
- 提交訊息採 SEMANTIC + ENGLISH（與現有 git log 一致）；以具體檔案路徑 `git add`，經 `git-master` 技能提交。

---

## File Structure

| 檔案 | 職責 |
| --- | --- |
| `deno.json` | import map + tasks（test/check/lint/build） |
| `src/deps.ts` | 從 `unbash` re-export `parse` 與所有 AST 型別（單一入口） |
| `src/types.ts` | `Verdict`、`CwdState`、`CommandInvocation`、`Decision` |
| `src/engine/word.ts` | Word 靜態解析（`isStatic`、`staticValue`） |
| `src/engine/scope.ts` | 路徑正規化、`isWithin`、`resolvePath`（三態） |
| `src/project.ts` | 從 `$CLAUDE_PROJECT_DIR` 解析專案根 |
| `src/rules/types.ts` | `CommandRule`、`RuleContext`、`RuleVerdict` |
| `src/engine/parse.ts` | 包 `unbash.parse`，回傳 `{script, errors}` |
| `src/engine/redirect.ts` | 寫入型重導向偵測 + null 裝置特例 |
| `src/rules/flags.ts` | flag matcher、`positionals`、`hasAnyFlag` |
| `src/engine/cwd.ts` | `cd` 套用 + git 指令級路徑選項 effective cwd |
| `src/engine/walk.ts` | AST 走訪 → `CommandInvocation[]`（含 cwd 與 command substitution 內層） |
| `src/rules/factory.ts` | `flagGatedReader` 規則工廠 |
| `src/rules/commands/coreutils.ts` | 純讀取 file-readers + pure-utils + `cd` 規則 |
| `src/rules/commands/sed.ts` | sed 腳本掃描白名單 |
| `src/rules/commands/awk.ts` | awk 程式掃描白名單 |
| `src/rules/commands/find.ts` | find action 偵測 |
| `src/rules/commands/simple-flag.ts` | sort / yq / tree / file / date（用 factory） |
| `src/rules/commands/positional-output.ts` | xxd / uniq（位置輸出檔） |
| `src/rules/commands/grep.ts` | grep / rg / egrep / fgrep |
| `src/rules/commands/git.ts` | git 子指令判定 |
| `src/rules/allowlist.ts` | name → CommandRule 索引 |
| `src/engine/classify.ts` | 單指令判定（name/allowlist/中央前置/rule） |
| `src/engine/combine.ts` | 最弱環節合併 |
| `src/engine/evaluate.ts` | 主流程編排 |
| `src/hook/types.ts` | `HookInput` / `HookOutput` |
| `src/hook/io.ts` | 讀 stdin、輸出 decision JSON |
| `src/main.ts` | 進入點 |
| `README.md` | build / 接線 / 擴充說明 |

---

## Task 1: 專案骨架與 unbash 匯入冒煙測試

**Files:**
- Create: `deno.json`
- Create: `src/deps.ts`
- Test: `src/deps_test.ts`

- [ ] **Step 1: 建立 `deno.json`**

```json
{
  "imports": {
    "unbash": "npm:unbash@3.0.0",
    "unbash/printer": "npm:unbash@3.0.0/printer",
    "@std/assert": "jsr:@std/assert@^1.0.0"
  },
  "tasks": {
    "test": "deno test --allow-run --allow-env --allow-read",
    "check": "deno check src/**/*.ts",
    "lint": "deno lint",
    "build": "deno compile --allow-env=CLAUDE_PROJECT_DIR --output dist/permission-checker src/main.ts"
  },
  "lint": { "rules": { "tags": ["recommended"] } }
}
```

- [ ] **Step 2: 建立 `src/deps.ts`（第三方單一入口）**

```typescript
export { parse } from "unbash";
export type {
  AndOr,
  ArithmeticCommand,
  ArithmeticFor,
  AssignmentPrefix,
  BraceGroup,
  Case,
  CaseItem,
  Command,
  CompoundList,
  Coproc,
  For,
  Function as ShFunction,
  If,
  Node,
  ParseError,
  Pipeline,
  Redirect,
  RedirectOperator,
  Script,
  Select,
  Statement,
  Subshell,
  TestCommand,
  While,
  Word,
  WordPart,
} from "unbash";
```

- [ ] **Step 3: 寫冒煙測試 `src/deps_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "./deps.ts";

Deno.test("unbash parses a simple command into Script.commands", () => {
  const script = parse("cat file.txt");
  assertEquals(script.type, "Script");
  assertEquals(script.commands.length, 1);
  const stmt = script.commands[0];
  assertEquals(stmt.type, "Statement");
  assertEquals(stmt.command.type, "Command");
});

Deno.test("unbash exposes errors as an array field", () => {
  const script = parse("cat file.txt");
  // 正常指令無錯誤；errors 可能為 undefined 或空陣列
  assertEquals(script.errors ?? [], []);
});
```

- [ ] **Step 4: 執行測試確認通過**

Run: `deno test --allow-env src/deps_test.ts`
Expected: PASS（首次執行會下載 `npm:unbash@3.0.0`）

- [ ] **Step 5: Commit**

```bash
git add deno.json src/deps.ts src/deps_test.ts
git commit -m "chore: scaffold deno project and unbash deps entry"
```

---

## Task 2: 核心領域型別

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: 建立 `src/types.ts`**

```typescript
import type { AssignmentPrefix, Redirect, Word } from "./deps.ts";

export type Verdict = "allow" | "ask";

/** 指令執行時的有效工作目錄狀態。 */
export type CwdState =
  | { kind: "known"; path: string } // 已正規化的絕對 posix 路徑
  | { kind: "unknown" }; // 無法靜態確定

/** 從 AST 抽取出的單一葉指令呼叫（已附上其執行 cwd）。 */
export interface CommandInvocation {
  /** 靜態解析出的指令名；動態（如 $CMD）為 null。 */
  name: string | null;
  /** unbash 的 suffix（argv）。 */
  argv: Word[];
  /** var=val 前綴。 */
  assignments: AssignmentPrefix[];
  /** 此指令承載的重導向（含繼承自外層 Statement / 複合結構者）。 */
  redirects: Redirect[];
  /** 此指令執行時的有效工作目錄。 */
  cwd: CwdState;
}

/** 引擎最終判定。 */
export interface Decision {
  verdict: Verdict;
  reason: string;
}
```

- [ ] **Step 2: 型別檢查**

Run: `deno check src/types.ts`
Expected: 無輸出（通過）

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add core domain types"
```

---

## Task 3: Word 靜態解析

判斷一個 `Word` 是否為純靜態字面值，並取得其值。含任何展開部位（變數、`$()`、算術、process substitution、brace、glob）即為動態。

**Files:**
- Create: `src/engine/word.ts`
- Test: `src/engine/word_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/word_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isStatic, staticValue } from "./word.ts";

/** 解析單一指令並回傳第一個 argv Word。 */
function firstArg(src: string) {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("static literal word", () => {
  const w = firstArg("cat file.txt");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "file.txt");
});

Deno.test("single-quoted word is static", () => {
  const w = firstArg("cat 'a b.txt'");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "a b.txt");
});

Deno.test("word with variable expansion is dynamic", () => {
  const w = firstArg("cat $FILE");
  assertEquals(isStatic(w), false);
  assertEquals(staticValue(w), null);
});

Deno.test("word with command substitution is dynamic", () => {
  const w = firstArg("cat $(ls)");
  assertEquals(isStatic(w), false);
  assertEquals(staticValue(w), null);
});

Deno.test("double-quoted word with expansion is dynamic", () => {
  const w = firstArg('cat "$HOME/x"');
  assertEquals(isStatic(w), false);
});

Deno.test("unquoted glob word is dynamic", () => {
  assertEquals(isStatic(firstArg("cat *.txt")), false);
  assertEquals(isStatic(firstArg("cat ?.txt")), false);
  assertEquals(isStatic(firstArg("cat [ab].txt")), false);
});

Deno.test("quoted glob is static (glob chars protected by quotes)", () => {
  const w = firstArg("cat '*.txt'");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "*.txt");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: FAIL（`word.ts` 不存在 / 函式未定義）

- [ ] **Step 3: 實作 `src/engine/word.ts`**

```typescript
import type { Word, WordPart } from "../deps.ts";

/** 會讓 Word 失去靜態確定性的 WordPart type。 */
const DYNAMIC_PART_TYPES = new Set<string>([
  "SimpleExpansion",
  "ParameterExpansion",
  "CommandExpansion",
  "ArithmeticExpansion",
  "ProcessSubstitution",
  "BraceExpansion",
  "ExtendedGlob",
]);

/**
 * 未加引號的 glob 元字元。unbash 不結構化表示 glob（`*.txt` 與字面值 `a.txt` 的
 * Word 結構相同、皆無 parts），故須詞法偵測：未加引號的 `*` / `?` / `[` 會被 shell
 * 展開、無法靜態確定指向哪些路徑 → 視為動態。
 */
const GLOB_CHARS = /[*?[]/;

/** 雙引號內的 part：glob 字元被引號保護不展開，僅展開類 part 才算動態。 */
function nestedPartIsDynamic(part: WordPart): boolean {
  return DYNAMIC_PART_TYPES.has(part.type);
}

/** 頂層 part：展開類 → 動態；未加引號的 Literal 含 glob 字元 → 動態。 */
function topPartIsDynamic(part: WordPart): boolean {
  if (DYNAMIC_PART_TYPES.has(part.type)) return true;
  if (part.type === "Literal") return GLOB_CHARS.test(part.value); // 未加引號字面值
  // 雙引號 / locale 字串：內部 glob 不展開，只看展開類 part
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    return part.parts.some(nestedPartIsDynamic);
  }
  return false; // SingleQuoted / AnsiCQuoted → 引號保護的字面值
}

/** Word 是否為純靜態字面值（不含展開、且無未加引號的 glob）。 */
export function isStatic(word: Word): boolean {
  if (!word.parts) {
    // 無 parts = 未加引號的字面值；含 glob 元字元即視為動態
    return !GLOB_CHARS.test(word.value);
  }
  return !word.parts.some(topPartIsDynamic);
}

/** 靜態時回傳字面值，動態回傳 null。 */
export function staticValue(word: Word): string | null {
  return isStatic(word) ? word.value : null;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/word.ts src/engine/word_test.ts
git commit -m "feat: add static word resolution"
```

---

## Task 4: 路徑範圍解析（scope.ts）

純詞法路徑正規化與「是否落在專案根之下」判定，並提供 `resolvePath` 三態。不碰檔案系統。

**Files:**
- Create: `src/engine/scope.ts`
- Test: `src/engine/scope_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/scope_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isWithin, normalizeAbsolute, resolvePath, type PathScope } from "./scope.ts";

function firstArg(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

Deno.test("normalizeAbsolute collapses . and ..", () => {
  assertEquals(normalizeAbsolute("/a/b/../c/./d"), "/a/c/d");
});

Deno.test("normalizeAbsolute keeps windows drive and uppercases it", () => {
  assertEquals(normalizeAbsolute("d:\\proj\\src"), "D:/proj/src");
});

Deno.test("isWithin: exact root and descendant true, sibling false", () => {
  assertEquals(isWithin("/proj", "/proj"), true);
  assertEquals(isWithin("/proj", "/proj/src/a.ts"), true);
  assertEquals(isWithin("/proj", "/proj-other/a"), false);
  assertEquals(isWithin("/proj", "/etc/passwd"), false);
});

Deno.test("resolvePath: relative in-project under known cwd", () => {
  const scope: PathScope = resolvePath(
    firstArg("cat src/a.ts"),
    { kind: "known", path: "/proj" },
    "/proj",
  );
  assertEquals(scope, "in-project");
});

Deno.test("resolvePath: absolute outside project", () => {
  assertEquals(
    resolvePath(firstArg("cat /etc/passwd"), { kind: "known", path: "/proj" }, "/proj"),
    "out-of-project",
  );
});

Deno.test("resolvePath: relative escaping via .. is out-of-project", () => {
  assertEquals(
    resolvePath(firstArg("cat ../secret"), { kind: "known", path: "/proj" }, "/proj"),
    "out-of-project",
  );
});

Deno.test("resolvePath: dynamic arg is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat $X"), { kind: "known", path: "/proj" }, "/proj"),
    "dynamic",
  );
});

Deno.test("resolvePath: relative arg with unknown cwd is dynamic", () => {
  assertEquals(
    resolvePath(firstArg("cat a.ts"), { kind: "unknown" }, "/proj"),
    "dynamic",
  );
});

Deno.test("resolvePath: absolute arg resolves even when cwd unknown", () => {
  assertEquals(
    resolvePath(firstArg("cat /proj/a.ts"), { kind: "unknown" }, "/proj"),
    "in-project",
  );
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/scope.ts`**

```typescript
import type { Word } from "../deps.ts";
import { staticValue } from "./word.ts";
import type { CwdState } from "../types.ts";

export type PathScope = "in-project" | "out-of-project" | "dynamic";

/** 反斜線轉斜線。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 是否為絕對路徑（posix `/`、Windows `X:/`、UNC `//`）。 */
export function isAbsolute(p: string): boolean {
  const s = toPosix(p);
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

/**
 * 詞法正規化為絕對 posix 路徑（折疊 `.` / `..`）。
 * 假設輸入已是絕對路徑；Windows drive 一律轉大寫以便比較。
 */
export function normalizeAbsolute(abs: string): string {
  const posix = toPosix(abs);
  let prefix = "";
  let rest = posix;
  const drive = posix.match(/^([A-Za-z]):\//);
  if (drive) {
    prefix = drive[1].toUpperCase() + ":";
    rest = posix.slice(drive[0].length - 1); // 保留開頭的 "/"
  }
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return prefix + "/" + out.join("/");
}

/** 把相對路徑接在 cwd 之後再正規化。 */
function resolveAgainst(cwdPath: string, arg: string): string {
  const a = toPosix(arg);
  if (isAbsolute(a)) return normalizeAbsolute(a);
  const base = cwdPath.endsWith("/") ? cwdPath : cwdPath + "/";
  return normalizeAbsolute(base + a);
}

/** target 是否等於 root 或在 root 之下（兩者皆會先正規化）。 */
export function isWithin(root: string, target: string): boolean {
  const r = normalizeAbsolute(root);
  const t = normalizeAbsolute(target);
  if (t === r) return true;
  const rSlash = r.endsWith("/") ? r : r + "/";
  return t.startsWith(rSlash);
}

/** 解析單一參數對專案根的範圍（三態）。 */
export function resolvePath(arg: Word, cwd: CwdState, root: string): PathScope {
  const val = staticValue(arg);
  if (val === null) return "dynamic"; // 含展開
  if (isAbsolute(val)) {
    return isWithin(root, val) ? "in-project" : "out-of-project";
  }
  if (cwd.kind === "unknown") return "dynamic"; // 相對路徑但 cwd 未知
  const resolved = resolveAgainst(cwd.path, val);
  return isWithin(root, resolved) ? "in-project" : "out-of-project";
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts
git commit -m "feat: add lexical path scope resolution"
```

---

## Task 5: 專案根解析（project.ts）

**Files:**
- Create: `src/project.ts`
- Test: `src/project_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/project_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { resolveProjectRoot } from "./project.ts";

function envOf(value: string | undefined) {
  return { get: (_k: string) => value } as { get(k: string): string | undefined };
}

Deno.test("resolves and normalizes CLAUDE_PROJECT_DIR", () => {
  assertEquals(resolveProjectRoot(envOf("/home/me/proj/")), "/home/me/proj");
});

Deno.test("normalizes windows path", () => {
  assertEquals(resolveProjectRoot(envOf("D:\\proj")), "D:/proj");
});

Deno.test("unset returns null", () => {
  assertEquals(resolveProjectRoot(envOf(undefined)), null);
});

Deno.test("blank returns null", () => {
  assertEquals(resolveProjectRoot(envOf("   ")), null);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/project_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/project.ts`**

```typescript
import { normalizeAbsolute } from "./engine/scope.ts";

export interface EnvReader {
  get(key: string): string | undefined;
}

/** 從 $CLAUDE_PROJECT_DIR 解析專案根；未設定 / 空白 → null。 */
export function resolveProjectRoot(env: EnvReader): string | null {
  const raw = env.get("CLAUDE_PROJECT_DIR");
  if (!raw || raw.trim() === "") return null;
  return normalizeAbsolute(raw.trim());
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/project_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/project.ts src/project_test.ts
git commit -m "feat: resolve project root from env"
```

---

## Task 6: 規則模型型別 + parse 包裝

**Files:**
- Create: `src/rules/types.ts`
- Create: `src/engine/parse.ts`
- Test: `src/engine/parse_test.ts`

- [ ] **Step 1: 建立 `src/rules/types.ts`**

```typescript
import type { AssignmentPrefix, Redirect, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import type { PathScope } from "../engine/scope.ts";

/** 由 CommandInvocation 投影建構；name 已確認非 null。 */
export interface RuleContext {
  name: string;
  argv: Word[];
  redirects: Redirect[];
  assignments: AssignmentPrefix[];
  cwd: CwdState;
  /** 對某參數做範圍檢查（內部已綁定 cwd 與 root）。 */
  resolvePath(arg: Word): PathScope;
}

export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
}

/** 便利建構子。 */
export const allow = (): RuleVerdict => ({ kind: "allow" });
export const ask = (reason: string): RuleVerdict => ({ kind: "ask", reason });
```

- [ ] **Step 2: 寫失敗測試 `src/engine/parse_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";

Deno.test("valid command: no errors", () => {
  const r = parseCommand("cat file.txt");
  assertEquals(r.errors.length, 0);
  assertEquals(r.script.commands.length, 1);
});

Deno.test("errors are always an array (never undefined)", () => {
  const r = parseCommand("");
  assertEquals(Array.isArray(r.errors), true);
});
```

- [ ] **Step 3: 執行確認失敗**

Run: `deno test --allow-env src/engine/parse_test.ts`
Expected: FAIL

- [ ] **Step 4: 實作 `src/engine/parse.ts`**

```typescript
import { parse } from "../deps.ts";
import type { ParseError, Script } from "../deps.ts";

export interface ParseResult {
  script: Script;
  errors: ParseError[];
}

/** 包 unbash.parse；errors 統一為陣列（容錯解析永不拋例外）。 */
export function parseCommand(source: string): ParseResult {
  const script = parse(source);
  return { script, errors: script.errors ?? [] };
}
```

- [ ] **Step 5: 執行確認通過**

Run: `deno test --allow-env src/engine/parse_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/rules/types.ts src/engine/parse.ts src/engine/parse_test.ts
git commit -m "feat: add rule model types and parse wrapper"
```

---

## Task 7: 寫入型重導向偵測（redirect.ts）

中央前置規則之二：任何寫入型重導向 → ask，但 null 裝置（`/dev/null` / `NUL`）與純 fd 複製除外。

**Files:**
- Create: `src/engine/redirect.ts`
- Test: `src/engine/redirect_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/redirect_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";

function redirectsOf(src: string) {
  return (parse(src).commands[0].command as Command).redirects;
}

Deno.test("plain > to a file is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("echo hi > out.txt")), true);
});

Deno.test(">> append is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("echo hi >> out.txt")), true);
});

Deno.test("&>> append-both is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd &>> out.log")), true);
});

Deno.test("redirect to /dev/null is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("grep x f 2>/dev/null")), false);
});

Deno.test("> /dev/null is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd >/dev/null")), false);
});

Deno.test("windows NUL (case-insensitive) is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd > NUL")), false);
});

Deno.test("pure fd-dup 2>&1 is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd 2>&1")), false);
});

Deno.test(">&filename is a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("ls >&out.txt")), true);
});

Deno.test(">&fd-number is not a write (dup)", () => {
  assertEquals(hasWriteRedirect(redirectsOf("ls >&2")), false);
});

Deno.test("input redirect < is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd < in.txt")), false);
});

Deno.test("dynamic write target still asks", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd > $OUT")), true);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/redirect_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/redirect.ts`**

```typescript
import type { Redirect } from "../deps.ts";
import { staticValue } from "./word.ts";

/** 一律寫檔的運算子（建立 / 覆寫 / 附加檔案）。 */
const WRITE_OPERATORS = new Set<string>([">", ">>", ">|", "&>", "&>>", "<>"]);

/** 目標是否為 null 裝置（無副作用）。 */
function isNullDevice(value: string): boolean {
  const v = value.replace(/\\/g, "/").toLowerCase();
  return v === "/dev/null" || v === "nul";
}

/** target 是否為 fd 數字或關閉符 `-`（代表 fd 複製 / 關閉，非寫檔）。 */
function isFdOrClose(value: string): boolean {
  return /^\d+$/.test(value) || value === "-";
}

/**
 * 單一重導向是否會造成檔案寫入。
 * - `>&`：接檔名 → 寫檔（如 `ls >&out.txt`）；接 fd 數字 / `-` → fd 複製 / 關閉
 *   （如 `2>&1`、`>&2`、`>&-`），非寫檔。`<&` 為輸入複製，永不寫檔。
 * - WRITE_OPERATORS：一律寫檔，但目標為 null 裝置 → 視為無副作用。
 * - 目標為動態（無法靜態確認）→ 保守視為寫檔（ask）。
 */
function isWriteRedirect(r: Redirect): boolean {
  if (r.operator === ">&") {
    if (!r.target) return false;
    const v = staticValue(r.target);
    if (v !== null && isFdOrClose(v)) return false; // fd 複製 / 關閉
    if (v !== null && isNullDevice(v)) return false;
    return true; // 檔名或動態目標 → 寫檔
  }
  if (!WRITE_OPERATORS.has(r.operator)) return false; // 含 `<&`、純輸入運算子
  if (!r.target) return false; // 無檔案目標
  const val = staticValue(r.target);
  if (val !== null && isNullDevice(val)) return false;
  return true;
}

/** 是否存在任一會造成檔案寫入的重導向。 */
export function hasWriteRedirect(redirects: Redirect[]): boolean {
  return redirects.some(isWriteRedirect);
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/redirect_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/redirect.ts src/engine/redirect_test.ts
git commit -m "feat: detect write redirects with null-device exception"
```

---

## Task 8: flag 工具（flags.ts）

提供 flag matcher 與「位置參數抽取」（正確跳過會吃下一個 token 當值的 flag），供各規則共用。

**Files:**
- Create: `src/rules/flags.ts`
- Test: `src/rules/flags_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/flags_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { exact, hasAnyFlag, positionals, prefix } from "./flags.ts";

function argvOf(src: string) {
  return (parse(src).commands[0].command as Command).suffix;
}

Deno.test("hasAnyFlag matches exact and prefix", () => {
  const matchers = [exact("-i", "--in-place"), prefix("-i")];
  assertEquals(hasAnyFlag(argvOf("sed -i 's/a/b/' f"), matchers), true);
  assertEquals(hasAnyFlag(argvOf("sed -i.bak 's/a/b/' f"), matchers), true);
  assertEquals(hasAnyFlag(argvOf("sed -n '1,5p' f"), matchers), false);
});

Deno.test("positionals skips value-consuming flags", () => {
  // -l 吃掉 16，剩 file 是唯一位置參數
  const valueFlags = [exact("-l", "-s", "-c", "-g")];
  const got = positionals(argvOf("xxd -l 16 file"), valueFlags).map((w) => w.value);
  assertEquals(got, ["file"]);
});

Deno.test("positionals counts two when output file present", () => {
  const valueFlags = [exact("-l", "-s", "-c", "-g")];
  const got = positionals(argvOf("xxd in out.bin"), valueFlags).map((w) => w.value);
  assertEquals(got, ["in", "out.bin"]);
});

Deno.test("positionals ignores --opt=val single tokens", () => {
  const got = positionals(argvOf("sort --buffer-size=1M file"), []).map((w) => w.value);
  // --buffer-size=1M 是單一 token 旗標（以 - 開頭），file 是位置參數
  assertEquals(got, ["file"]);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/flags_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/flags.ts`**

```typescript
import type { Word } from "../deps.ts";
import { staticValue } from "../engine/word.ts";

export type FlagMatcher = (token: string) => boolean;

export const exact = (...names: string[]): FlagMatcher => (t) => names.includes(t);
export const prefix = (...pfx: string[]): FlagMatcher => (t) => pfx.some((p) => t.startsWith(p));

/** 取得 Word 的靜態 token；動態時回傳 null。 */
function tokenOf(w: Word): string | null {
  return staticValue(w);
}

/** argv 中是否有任一 token 命中任一 matcher。 */
export function hasAnyFlag(argv: Word[], matchers: FlagMatcher[]): boolean {
  for (const w of argv) {
    const t = tokenOf(w);
    if (t === null) continue;
    if (matchers.some((m) => m(t))) return true;
  }
  return false;
}

/**
 * 抽取位置參數（非 flag）。`valueFlags` 列出「會吃掉下一個 token 當值」的 flag，
 * 命中時跳過其後一個 token，避免把 flag 的值誤認為位置參數。
 * 以 `-` 開頭的 token 一律視為 flag（含 `--opt=val` 單 token 形式）。
 */
export function positionals(argv: Word[], valueFlags: FlagMatcher[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = tokenOf(argv[i]);
    if (t !== null && t.startsWith("-") && t !== "-" && t !== "--") {
      // 若是「會吃值」的 flag 且值是獨立 token（非 --opt=val 形式），跳過下一個 token
      const takesValue = valueFlags.some((m) => m(t)) && !t.includes("=");
      if (takesValue) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/flags_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/flags.ts src/rules/flags_test.ts
git commit -m "feat: add flag matchers and positional extraction"
```

---

## Task 9: 工作目錄計算（cwd.ts）

兩個職責：(1) `applyCd` — `cd` 對「之後的循序語句」產生的新 threaded cwd；(2) `gitEffectiveCwd` — git 指令級路徑選項（`-C`、`--git-dir`、`--work-tree`、`-c core.worktree`）對「該次 git 指令」的有效 cwd（不外洩）。

**Files:**
- Create: `src/engine/cwd.ts`
- Test: `src/engine/cwd_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/cwd_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { applyCd, gitEffectiveCwd, isCd } from "./cwd.ts";

function cmdOf(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("isCd recognises cd", () => {
  assertEquals(isCd(cmdOf("cd src")), true);
  assertEquals(isCd(cmdOf("cat src")), false);
});

Deno.test("applyCd: static relative path updates known cwd", () => {
  const next = applyCd(cmdOf("cd src"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/proj/src" });
});

Deno.test("applyCd: absolute path", () => {
  const next = applyCd(cmdOf("cd /tmp"), { kind: "known", path: "/proj" });
  assertEquals(next, { kind: "known", path: "/tmp" });
});

Deno.test("applyCd: no arg (=$HOME) -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("applyCd: dynamic arg -> unknown", () => {
  assertEquals(applyCd(cmdOf("cd $X"), { kind: "known", path: "/proj" }), { kind: "unknown" });
});

Deno.test("gitEffectiveCwd: -C subdir resolves under cwd", () => {
  const c = gitEffectiveCwd(cmdOf("git -C sub status"), { kind: "known", path: "/proj" });
  assertEquals(c, { kind: "known", path: "/proj/sub" });
});

Deno.test("gitEffectiveCwd: --work-tree wins over -C base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -C sub --work-tree=wt status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/proj/sub/wt" });
});

Deno.test("gitEffectiveCwd: -c core.worktree changes base", () => {
  const c = gitEffectiveCwd(
    cmdOf("git -c core.worktree=/outside status"),
    { kind: "known", path: "/proj" },
  );
  assertEquals(c, { kind: "known", path: "/outside" });
});

Deno.test("gitEffectiveCwd: --git-dir out-of-project sets cwd outside", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git --git-dir=/outside/.git status"), { kind: "known", path: "/proj" }),
    { kind: "known", path: "/outside/.git" },
  );
});

Deno.test("gitEffectiveCwd: dynamic path option -> unknown", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git -C $D status"), { kind: "known", path: "/proj" }),
    { kind: "unknown" },
  );
});

Deno.test("gitEffectiveCwd: no path options -> unchanged", () => {
  assertEquals(
    gitEffectiveCwd(cmdOf("git status"), { kind: "known", path: "/proj" }),
    { kind: "known", path: "/proj" },
  );
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/cwd.ts`**

```typescript
import type { Command, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { isAbsolute, normalizeAbsolute } from "./scope.ts";

const UNKNOWN: CwdState = { kind: "unknown" };

export function isCd(cmd: Command): boolean {
  return cmd.name ? staticValue(cmd.name) === "cd" : false;
}

/** 把單一靜態路徑接到目前 cwd 上；動態 / cwd 未知 → unknown。 */
function applyPath(cwd: CwdState, value: string): CwdState {
  if (isAbsolute(value)) return { kind: "known", path: normalizeAbsolute(value) };
  if (cwd.kind === "unknown") return UNKNOWN;
  const base = cwd.path.endsWith("/") ? cwd.path : cwd.path + "/";
  return { kind: "known", path: normalizeAbsolute(base + value.replace(/\\/g, "/")) };
}

/** `cd` 之後的新 threaded cwd。無參數（=$HOME）或動態參數 → unknown。 */
export function applyCd(cmd: Command, cwd: CwdState): CwdState {
  if (cmd.suffix.length === 0) return UNKNOWN; // cd 無參數 = $HOME
  const val = staticValue(cmd.suffix[0]);
  if (val === null) return UNKNOWN;
  return applyPath(cwd, val);
}

/** 取得緊接在 flag 之後的值：支援 `--opt=val` 與 `--opt val` / `-C val`。 */
function optionValue(argv: Word[], i: number, token: string): { value: string | null; consumedNext: boolean } {
  const eq = token.indexOf("=");
  if (eq >= 0) return { value: token.slice(eq + 1), consumedNext: false };
  const next = argv[i + 1];
  if (!next) return { value: null, consumedNext: false };
  return { value: staticValue(next), consumedNext: true };
}

/**
 * 解析 git 指令級路徑選項，回傳該次 git 指令的有效 cwd。
 * 處理 `-C <path>`（多個累積）、`--git-dir=`/`--git-dir <p>`、
 * `--work-tree=`/`--work-tree <p>`、`-c core.worktree=<p>`。
 * 任一相關路徑為動態 → unknown。work-tree 設定後即為有效基準。
 */
export function gitEffectiveCwd(cmd: Command, cwd: CwdState): CwdState {
  let base = cwd; // 隨 -C 累積
  let workTree: string | null = null; // 相對於套用 -C 後的 base
  let gitDir: string | null = null; // --git-dir 路徑（納入範圍檢查）
  const argv = cmd.suffix;

  for (let i = 0; i < argv.length; i++) {
    const tok = staticValue(argv[i]);
    if (tok === null || !tok.startsWith("-")) continue;

    if (tok === "-C") {
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      base = applyPath(base, v.value);
      if (v.consumedNext) i++;
    } else if (tok === "--work-tree" || tok.startsWith("--work-tree=")) {
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      workTree = v.value;
      if (v.consumedNext) i++;
    } else if (tok === "--git-dir" || tok.startsWith("--git-dir=")) {
      // --git-dir 指向倉庫目錄；靜態值須納入範圍檢查（落在專案外 → 該指令 cwd 視為該處）
      const v = optionValue(argv, i, tok);
      if (v.value === null) return UNKNOWN;
      gitDir = v.value;
      if (v.consumedNext) i++;
    } else if (tok === "-c") {
      const v = optionValue(argv, i, tok);
      if (v.value === null) {
        // 動態 config，無法判斷是否 core.worktree → 保守 unknown
        return UNKNOWN;
      }
      const m = v.value.match(/^core\.worktree=(.*)$/);
      if (m) workTree = m[1];
      if (v.consumedNext) i++;
    } else if (tok.startsWith("-c")) {
      // -ckey=val 黏寫形式
      const inline = tok.slice(2);
      const m = inline.match(/^core\.worktree=(.*)$/);
      if (m) workTree = m[1];
    }
  }

  if (workTree !== null) return applyPath(base, workTree);
  // --git-dir 在專案外 → effective cwd 指向該處，使中央 cwd 前置規則 ask；
  // 在專案內則維持 in-project（讀取子指令仍可 allow）。
  if (gitDir !== null) return applyPath(base, gitDir);
  return base;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/cwd_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/cwd.ts src/engine/cwd_test.ts
git commit -m "feat: compute cwd from cd and git path options"
```

---

## Task 10: AST 走訪（walk.ts）

把 `Script` 攤平成 `CommandInvocation[]`，每個葉 `Command` 一筆，並：
- 在頂層循序語句間穿 cwd（`cd` 持久、subshell/pipeline/控制流不持久）。
- 對 git 指令套用其指令級路徑選項得到 per-command cwd。
- 把外層 `Statement` / 複合結構的重導向**繼承**給內部每個葉指令（保守）。
- 列舉 command substitution `$(…)` / process substitution 內層指令（在當前 cwd 副本、非持久）。
- 控制流（if/for/while/case）若內部含 `cd`，其後的 threaded cwd 標 `unknown`。

**Files:**
- Create: `src/engine/walk.ts`
- Test: `src/engine/walk_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/walk_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import type { CwdState } from "../types.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function names(src: string) {
  return walk(parseCommand(src).script, START, ROOT).map((i) => i.name);
}

Deno.test("single command", () => {
  assertEquals(names("cat a.txt"), ["cat"]);
});

Deno.test("pipeline enumerates each segment", () => {
  assertEquals(names("cat a | grep x | wc -l"), ["cat", "grep", "wc"]);
});

Deno.test("&& chain enumerates both", () => {
  assertEquals(names("cd src && cat a"), ["cd", "cat"]);
});

Deno.test("cd threads cwd across && to next command", () => {
  const invs = walk(parseCommand("cd src && cat a.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/proj/src" });
});

Deno.test("cd in subshell does not leak out", () => {
  const invs = walk(parseCommand("( cd /tmp ) ; cat a.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "known", path: "/proj" });
});

Deno.test("command substitution inner command is enumerated", () => {
  assertEquals(names("cat $(ls src)").sort(), ["cat", "ls"]);
});

Deno.test("git -C sets per-command cwd without leaking", () => {
  const invs = walk(parseCommand("git -C sub status ; cat a").script, START, ROOT);
  const git = invs.find((i) => i.name === "git")!;
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(git.cwd, { kind: "known", path: "/proj/sub" });
  assertEquals(cat.cwd, { kind: "known", path: "/proj" });
});

Deno.test("statement-level redirect is inherited by inner command", () => {
  const invs = walk(parseCommand("( cat a ) > out.txt").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.redirects.length >= 1, true);
});

Deno.test("control flow containing cd marks subsequent cwd unknown", () => {
  const invs = walk(
    parseCommand("if true; then cd /tmp; fi ; cat a").script,
    START,
    ROOT,
  );
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cat.cwd, { kind: "unknown" });
});

Deno.test("dynamic command name yields null name invocation", () => {
  const invs = walk(parseCommand("$CMD a").script, START, ROOT);
  assertEquals(invs[0].name, null);
});

Deno.test("empty / comment-only script yields no invocations", () => {
  assertEquals(walk(parseCommand("# just a comment").script, START, ROOT).length, 0);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/walk.ts`**

```typescript
import type {
  Command,
  Node,
  Redirect,
  Script,
  Statement,
  Word,
  WordPart,
} from "../deps.ts";
import type { CommandInvocation, CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { applyCd, gitEffectiveCwd, isCd } from "./cwd.ts";

/** 走訪 Script，回傳所有葉指令呼叫。 */
export function walk(script: Script, startCwd: CwdState, _root: string): CommandInvocation[] {
  const out: CommandInvocation[] = [];
  walkSequence(script.commands, startCwd, out, [], true);
  return out;
}

/** 依序處理頂層 / 複合語句序列，回傳序列結束後的 threaded cwd。 */
function walkSequence(
  statements: Statement[],
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
  persistent: boolean,
): CwdState {
  let cur = cwd;
  for (const stmt of statements) {
    cur = walkNode(stmt.command, cur, out, [...inherited, ...stmt.redirects], persistent);
  }
  return cur;
}

/**
 * 處理單一節點，列舉葉指令到 out，回傳處理後的 threaded cwd。
 * persistent=true 表示此節點在當前 shell 執行（cd 會持久）。
 */
function walkNode(
  node: Node,
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
  persistent: boolean,
): CwdState {
  switch (node.type) {
    case "Command": {
      emitCommand(node, cwd, out, inherited);
      if (persistent && isCd(node)) return applyCd(node, cwd);
      return cwd;
    }
    case "AndOr": {
      // && / || 在當前 shell 依序執行 → cd 在成員間傳遞
      let cur = cwd;
      for (const m of node.commands) cur = walkNode(m, cur, out, inherited, persistent);
      return cur;
    }
    case "Pipeline": {
      // 各段在 subshell 執行 → cd 不持久；皆以同一 cwd 列舉
      for (const m of node.commands) walkNode(m, cwd, out, inherited, false);
      return cwd;
    }
    case "Subshell": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return cwd; // 內部 cd 不外洩
    }
    case "BraceGroup": {
      // { …; } 在當前 shell 執行 → cd 持久
      return walkSequence(node.body.commands, cwd, out, inherited, persistent);
    }
    case "If": {
      walkSequence(node.clause.commands, cwd, out, inherited, false);
      walkSequence(node.then.commands, cwd, out, inherited, false);
      if (node.else) {
        if (node.else.type === "If") walkNode(node.else, cwd, out, inherited, false);
        else walkSequence(node.else.commands, cwd, out, inherited, false);
      }
      return afterControlFlow(node, cwd, persistent);
    }
    case "For":
    case "Select": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "While": {
      walkSequence(node.clause.commands, cwd, out, inherited, false);
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "ArithmeticFor": {
      walkSequence(node.body.commands, cwd, out, inherited, false);
      return afterControlFlow(node, cwd, persistent);
    }
    case "Case": {
      for (const item of node.items) {
        walkSequence(item.body.commands, cwd, out, inherited, false);
      }
      return afterControlFlow(node, cwd, persistent);
    }
    case "CompoundList": {
      return walkSequence(node.commands, cwd, out, inherited, persistent);
    }
    case "Statement": {
      return walkNode(
        node.command,
        cwd,
        out,
        [...inherited, ...node.redirects],
        persistent,
      );
    }
    // Function 定義本體當下不執行；TestCommand / ArithmeticCommand 無外部指令。
    case "Function":
    case "TestCommand":
    case "ArithmeticCommand":
    case "Coproc":
    default:
      return cwd;
  }
}

/** 控制流之後：若內部含 cd，threaded cwd 保守標 unknown。 */
function afterControlFlow(node: Node, cwd: CwdState, persistent: boolean): CwdState {
  if (persistent && containsCd(node)) return { kind: "unknown" };
  return cwd;
}

/** 建立一筆葉指令呼叫，並列舉其參數內的 command substitution 內層指令。 */
function emitCommand(
  cmd: Command,
  cwd: CwdState,
  out: CommandInvocation[],
  inherited: Redirect[],
): void {
  const name = cmd.name ? staticValue(cmd.name) : null;
  const execCwd = name === "git" ? gitEffectiveCwd(cmd, cwd) : cwd;

  out.push({
    name,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: [...inherited, ...cmd.redirects],
    cwd: execCwd,
  });

  // command substitution / process substitution 內層指令（非持久、用當前 cwd 副本）
  const words: Word[] = [
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.suffix,
    ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
    ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
  ];
  for (const w of words) enumerateInnerScripts(w, cwd, out);
}

/** 掃描 Word 內的 CommandExpansion / ProcessSubstitution，列舉其內層 Script。 */
function enumerateInnerScripts(word: Word, cwd: CwdState, out: CommandInvocation[]): void {
  if (!word.parts) return;
  for (const part of word.parts) walkPart(part, cwd, out);
}

function walkPart(part: WordPart, cwd: CwdState, out: CommandInvocation[]): void {
  if (
    (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") &&
    part.script
  ) {
    walkSequence(part.script.commands, cwd, out, [], false);
  } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) walkPart(child, cwd, out);
  }
}

/** 子樹是否含有 `cd` 指令（決定控制流後是否標 unknown）。 */
function containsCd(node: Node): boolean {
  switch (node.type) {
    case "Command":
      return isCd(node);
    case "AndOr":
    case "Pipeline":
      return node.commands.some(containsCd);
    case "Subshell":
    case "BraceGroup":
    case "CompoundList":
      return seqContainsCd(node.type === "CompoundList" ? node.commands : node.body.commands);
    case "If":
      return (
        seqContainsCd(node.clause.commands) ||
        seqContainsCd(node.then.commands) ||
        (node.else
          ? node.else.type === "If"
            ? containsCd(node.else)
            : seqContainsCd(node.else.commands)
          : false)
      );
    case "For":
    case "Select":
    case "ArithmeticFor":
      return seqContainsCd(node.body.commands);
    case "While":
      return seqContainsCd(node.clause.commands) || seqContainsCd(node.body.commands);
    case "Case":
      return node.items.some((it) => seqContainsCd(it.body.commands));
    case "Statement":
      return containsCd(node.command);
    default:
      return false;
  }
}

function seqContainsCd(statements: Statement[]): boolean {
  return statements.some((s) => containsCd(s.command));
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/walk.ts src/engine/walk_test.ts
git commit -m "feat: flatten AST into command invocations with cwd threading"
```

---

## Task 11: 規則工廠 + coreutils / cd 規則

`flagGatedReader` 工廠：命中 askFlags → ask，否則對位置參數做範圍檢查。再用它與兩個手寫規則涵蓋純讀取 coreutils 與 `cd`。

**Files:**
- Create: `src/rules/factory.ts`
- Create: `src/rules/commands/coreutils.ts`
- Test: `src/rules/commands/coreutils_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/coreutils_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cdRule, fileReaderRule, pureUtilRule } from "./coreutils.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

Deno.test("fileReader allows in-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat src/a.ts")).kind, "allow");
});

Deno.test("fileReader asks for out-of-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat /etc/passwd")).kind, "ask");
});

Deno.test("fileReader asks for dynamic path", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat $X")).kind, "ask");
});

Deno.test("pureUtil always allows (no file operands)", () => {
  assertEquals(pureUtilRule.evaluate(ctxOf("echo hello world")).kind, "allow");
  assertEquals(pureUtilRule.evaluate(ctxOf("whoami")).kind, "allow");
});

Deno.test("fileReader scope-checks basename path operand", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("basename src/a.ts")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath /etc/passwd")).kind, "ask");
});

Deno.test("cd always allows", () => {
  assertEquals(cdRule.evaluate(ctxOf("cd /anywhere")).kind, "allow");
});

Deno.test("rules expose expected names", () => {
  assertEquals(fileReaderRule.names.includes("cat"), true);
  assertEquals(pureUtilRule.names.includes("echo"), true);
  assertEquals(cdRule.names, ["cd"]);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/factory.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "./types.ts";
import { allow, ask } from "./types.ts";
import { type FlagMatcher, hasAnyFlag, positionals } from "./flags.ts";

export interface FlagGatedReaderOptions {
  names: string[];
  /** 命中任一即 ask（寫入 / 副作用 flag）。 */
  askFlags?: FlagMatcher[];
  /** 會吃掉下一 token 當值的 flag（供位置參數抽取正確跳過）。 */
  valueFlags?: FlagMatcher[];
  /** ask 時的說明（含指令名）。 */
  askReason?: (name: string) => string;
}

/**
 * 通用唯讀規則：命中 askFlags → ask；否則對位置參數逐一 resolvePath，
 * 任一 out-of-project / dynamic → ask，全部 in-project 才 allow。
 */
export function flagGatedReader(opts: FlagGatedReaderOptions): CommandRule {
  const askFlags = opts.askFlags ?? [];
  const valueFlags = opts.valueFlags ?? [];
  return {
    names: opts.names,
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      for (const arg of positionals(ctx.argv, valueFlags)) {
        const scope = ctx.resolvePath(arg);
        if (scope !== "in-project") {
          return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
        }
      }
      return allow();
    },
  };
}
```

- [ ] **Step 4: 實作 `src/rules/commands/coreutils.ts`**

```typescript
import type { CommandRule } from "../types.ts";
import { allow } from "../types.ts";
import { flagGatedReader } from "../factory.ts";

/**
 * 會把非 flag 參數當作要讀取 / 解析的路徑，需做範圍檢查（spec line 218 要求整份
 * 清單皆「路徑做範圍檢查」）。basename/dirname/realpath/readlink 接受路徑操作元，
 * 故一併納入受範圍檢查的群組。
 */
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "tail", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "diff", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // 這些指令無「會寫檔」的 flag（已於 spec 查證）；故 askFlags 留空。
});

/** 不接受檔案路徑操作元、且無寫入能力的純工具：一律 allow。 */
export const pureUtilRule: CommandRule = {
  names: ["echo", "pwd", "whoami", "which"],
  evaluate: () => allow(),
};

/** cd 本身不寫檔（cwd 變動由 walk 處理）：一律 allow。 */
export const cdRule: CommandRule = {
  names: ["cd"],
  evaluate: () => allow(),
};
```

- [ ] **Step 5: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/coreutils.ts src/rules/commands/coreutils_test.ts
git commit -m "feat: add rule factory and coreutils/cd rules"
```

---

## Task 12: sed 腳本掃描白名單

**Files:**
- Create: `src/rules/commands/sed.ts`
- Test: `src/rules/commands/sed_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/sed_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { sedRule } from "./sed.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "sed",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

Deno.test("sed -n print range allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '30,45p' file")).kind, "allow");
});

Deno.test("sed delete to stdout allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '/foo/d' file")).kind, "allow");
});

Deno.test("sed substitution allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/g' file")).kind, "allow");
});

Deno.test("sed -i asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -i.bak asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i.bak 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -f scriptfile asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -f prog.sed file")).kind, "ask");
});

Deno.test("sed s///w write flag asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/w out' file")).kind, "ask");
});

Deno.test("sed w command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n 'w out' file")).kind, "ask");
});

Deno.test("sed e exec command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '1e cat /etc/passwd' file")).kind, "ask");
});

Deno.test("sed allowed form but out-of-project file asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '1,5p' /etc/passwd")).kind, "ask");
});

Deno.test("sed with no static program (dynamic) asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed $PROG file")).kind, "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/sed_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/sed.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, hasAnyFlag, positionals, prefix } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";

const ASK_FLAGS = [exact("-i", "--in-place", "-f", "--file"), prefix("-i", "--in-place=", "--file=")];
const VALUE_FLAGS = [exact("-e", "--expression", "-f", "--file", "-l")];

/**
 * sed 程式（隱含第一個非 flag 引數 + 所有 -e）中，下列構造代表寫檔 / 執行：
 * 獨立的 w / W / e / r / R 指令，或 s///… 旗標含 w 或 e。
 * 採保守正則偵測；命中或無法靜態取得程式即 ask。
 */
function programHasSideEffect(program: string): boolean {
  // s/.../.../<flags> 內若含 w 或 e 旗標
  if (/s([^\sa-zA-Z0-9])(?:\\.|[^\\])*?\1(?:\\.|[^\\])*?\1[a-z0-9]*[we]/.test(program)) {
    return true;
  }
  // 獨立的 w/W/e/r/R 指令（行首、分號、或位址後出現），保守偵測
  if (/(^|[;\n{])\s*[0-9$/]*\s*[wWeRr]\b/.test(program)) return true;
  if (/(^|[;\n{])\s*[wWeRr]\s/.test(program)) return true;
  return false;
}

/** 收集 sed 的程式片段：第一個非 flag 位置參數，加上所有 -e 的值。 */
function collectProgram(ctx: RuleContext): { text: string | null; explicitExpr: boolean } {
  const parts: string[] = [];
  let explicitExpr = false;
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) continue;
    if (t === "-e" || t === "--expression") {
      explicitExpr = true;
      const v = argv[i + 1] ? staticValue(argv[i + 1]) : null;
      if (v === null) return { text: null, explicitExpr };
      parts.push(v);
      i++;
    } else if (t.startsWith("--expression=")) {
      explicitExpr = true;
      parts.push(t.slice("--expression=".length));
    } else if (t.startsWith("-e")) {
      explicitExpr = true;
      parts.push(t.slice(2));
    }
  }
  if (!explicitExpr) {
    // 隱含程式 = 第一個非 flag 位置參數
    const pos = positionals(argv, VALUE_FLAGS);
    if (pos.length === 0) return { text: null, explicitExpr };
    const v = staticValue(pos[0]);
    if (v === null) return { text: null, explicitExpr };
    parts.push(v);
  }
  return { text: parts.join("\n"), explicitExpr };
}

/** sed 的輸入檔：隱含程式時為第二個起的位置參數；有 -e 時為所有位置參數。 */
function inputPaths(ctx: RuleContext, explicitExpr: boolean) {
  const pos = positionals(ctx.argv, VALUE_FLAGS);
  return explicitExpr ? pos : pos.slice(1);
}

export const sedRule: CommandRule = {
  names: ["sed"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) {
      return ask("sed：-i / -f 可就地寫檔或載入不可見腳本");
    }
    const { text, explicitExpr } = collectProgram(ctx);
    if (text === null) return ask("sed：無法靜態取得程式內容");
    if (programHasSideEffect(text)) return ask("sed：程式含寫檔 / 執行構造（w/W/e/r 或 s///we）");
    for (const p of inputPaths(ctx, explicitExpr)) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`sed：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
};
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/sed_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/sed.ts src/rules/commands/sed_test.ts
git commit -m "feat: add sed read-only program whitelist rule"
```

---

## Task 13: awk 程式掃描白名單

**Files:**
- Create: `src/rules/commands/awk.ts`
- Test: `src/rules/commands/awk_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/awk_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { awkRule } from "./awk.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "awk",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

Deno.test("awk NR range filter allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk 'NR>=8940 && NR<=9281' file")).kind, "allow");
});

Deno.test("awk print field allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{print $1}' file")).kind, "allow");
});

Deno.test("awk -F filter allows", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk -F, '$3>100' file")).kind, "allow");
});

Deno.test("awk redirect to file asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{print > \"out\"}' file")).kind, "ask");
});

Deno.test("awk system() asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{system(\"rm x\")}' file")).kind, "ask");
});

Deno.test("awk getline asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk '{\"cmd\"|getline}' file")).kind, "ask");
});

Deno.test("awk -f progfile asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk -f prog.awk file")).kind, "ask");
});

Deno.test("awk allowed form but out-of-project file asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk 'NR<5' /etc/passwd")).kind, "ask");
});

Deno.test("awk dynamic program asks", () => {
  assertEquals(awkRule.evaluate(ctxOf("awk $PROG file")).kind, "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/awk_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/awk.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, hasAnyFlag, positionals, prefix } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";

const ASK_FLAGS = [exact("-i", "--in-place", "-f", "--file"), prefix("--in-place=", "--file=")];
const VALUE_FLAGS = [exact("-F", "-v", "-f", "--file", "--field-separator", "--assign")];

/** awk 程式中代表副作用的構造：輸出重導向、pipe、system(、getline、close(、fflush(。 */
function programHasSideEffect(program: string): boolean {
  // 輸出重導向：僅在 print / printf 之後出現 > 或 >> 才算寫檔，避開比較運算子
  // （bare pattern 過濾如 $3>100、NR>=8940 必須維持 allow）。
  if (/\b(?:print|printf)\b[^;{}\n]*>/.test(program)) return true;
  // pipe：偵測單一 |（print | "cmd" / "cmd" | getline），排除邏輯 ||。
  if (/(?:^|[^|])\|(?:[^|]|$)/.test(program)) return true;
  if (/\bsystem\s*\(/.test(program)) return true;
  if (/\bgetline\b/.test(program)) return true;
  if (/\bclose\s*\(/.test(program)) return true;
  if (/\bfflush\s*\(/.test(program)) return true;
  return false;
}

/** 隱含程式 = 第一個非 flag 位置參數（awk 無 -e 的普遍標準形式以此為主）。 */
function collectProgram(ctx: RuleContext): { text: string | null; pos: ReturnType<typeof positionals> } {
  // 支援 gawk 的 -e 'prog'
  const eParts: string[] = [];
  let hasE = false;
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) continue;
    if (t === "-e") {
      hasE = true;
      const v = argv[i + 1] ? staticValue(argv[i + 1]) : null;
      if (v === null) return { text: null, pos: [] };
      eParts.push(v);
      i++;
    } else if (t.startsWith("-e") && t.length > 2 && !t.startsWith("--")) {
      hasE = true;
      eParts.push(t.slice(2));
    }
  }
  const pos = positionals(argv, [...VALUE_FLAGS, exact("-e")]);
  if (hasE) return { text: eParts.join("\n"), pos };
  if (pos.length === 0) return { text: null, pos };
  const v = staticValue(pos[0]);
  if (v === null) return { text: null, pos };
  return { text: v, pos: pos.slice(1) };
}

export const awkRule: CommandRule = {
  names: ["awk", "gawk", "mawk"],
  evaluate(ctx: RuleContext): RuleVerdict {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) {
      return ask("awk：-i / -f 可就地寫檔或載入不可見程式");
    }
    const { text, pos } = collectProgram(ctx);
    if (text === null) return ask("awk：無法靜態取得程式內容");
    if (programHasSideEffect(text)) {
      return ask("awk：程式含寫檔 / 執行構造（> / | / system / getline / close / fflush）");
    }
    for (const p of pos) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`awk：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
};
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/awk_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/awk.ts src/rules/commands/awk_test.ts
git commit -m "feat: add awk read-only program whitelist rule"
```

---

## Task 14: find action 偵測

**Files:**
- Create: `src/rules/commands/find.ts`
- Test: `src/rules/commands/find_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/find_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { findRule } from "./find.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "find",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

Deno.test("find search in-project allows", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -name '*.ts'")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find src tests -type f")).kind, "allow");
});

Deno.test("find -delete asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -delete")).kind, "ask");
});

Deno.test("find -exec asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -exec rm {} ;")).kind, "ask");
});

Deno.test("find -fprintf asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -fprintf out '%p'")).kind, "ask");
});

Deno.test("find out-of-project start path asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find /etc -name passwd")).kind, "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/find_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/find.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

const ACTION_FLAGS = new Set<string>([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

export const findRule: CommandRule = {
  names: ["find"],
  evaluate(ctx: RuleContext): RuleVerdict {
    // 起始路徑 = 第一個以 - 開頭的 token 之前的所有非 flag 位置參數
    const starts = [];
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t !== null && t.startsWith("-")) break;
      starts.push(w);
    }
    // 偵測寫檔 / 執行 action
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t !== null && ACTION_FLAGS.has(t)) {
        return ask(`find：${t} 會寫檔或執行外部指令`);
      }
    }
    for (const s of starts) {
      if (ctx.resolvePath(s) !== "in-project") {
        return ask(`find：起始路徑超出專案範圍或無法解析（${s.value}）`);
      }
    }
    return allow();
  },
};
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/find_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/find.ts src/rules/commands/find_test.ts
git commit -m "feat: add find action-detection rule"
```

---

## Task 15: sort / yq / tree / file / date 規則（factory）

**Files:**
- Create: `src/rules/commands/simple-flag.ts`
- Test: `src/rules/commands/simple-flag_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/simple-flag_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { dateRule, fileCmdRule, sortRule, treeRule, yqRule } from "./simple-flag.ts";
import type { CommandRule, RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

function v(rule: CommandRule, name: string, src: string) {
  return rule.evaluate(ctxOf(name, src)).kind;
}

Deno.test("sort allows plain, asks on -o / -T", () => {
  assertEquals(v(sortRule, "sort", "sort file"), "allow");
  assertEquals(v(sortRule, "sort", "sort -k 2 file"), "allow"); // -k 吃值 2
  assertEquals(v(sortRule, "sort", "sort -o out.txt file"), "ask");
  assertEquals(v(sortRule, "sort", "sort --output=out file"), "ask");
  assertEquals(v(sortRule, "sort", "sort -T /tmp file"), "ask");
});

Deno.test("yq allows read, asks on -i", () => {
  assertEquals(v(yqRule, "yq", "yq '.a' f.yml"), "allow");
  assertEquals(v(yqRule, "yq", "yq -i '.a=1' f.yml"), "ask");
  assertEquals(v(yqRule, "yq", "yq --inplace '.a=1' f.yml"), "ask");
});

Deno.test("tree allows, asks on -o", () => {
  assertEquals(v(treeRule, "tree", "tree src"), "allow");
  assertEquals(v(treeRule, "tree", "tree -o t.txt"), "ask");
});

Deno.test("file allows, asks on -C", () => {
  assertEquals(v(fileCmdRule, "file", "file a.bin"), "allow");
  assertEquals(v(fileCmdRule, "file", "file -C -m mymagic"), "ask");
});

Deno.test("date allows, asks on -s", () => {
  assertEquals(v(dateRule, "date", "date '+%Y'"), "allow");
  assertEquals(v(dateRule, "date", "date -s '2020-01-01'"), "ask");
});

Deno.test("sort out-of-project file asks", () => {
  assertEquals(v(sortRule, "sort", "sort /etc/passwd"), "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/simple-flag_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/simple-flag.ts`**

```typescript
import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, prefix } from "../flags.ts";

export const sortRule: CommandRule = flagGatedReader({
  names: ["sort"],
  askFlags: [exact("-o", "--output", "-T", "--temporary-directory"), prefix("-o", "--output=", "-T", "--temporary-directory=")],
  valueFlags: [exact("-o", "-T", "-S", "-k", "-t", "--output", "--temporary-directory", "--buffer-size", "--key", "--field-separator")],
  askReason: () => "sort：-o / -T 會寫檔或指定暫存目錄",
});

export const yqRule: CommandRule = flagGatedReader({
  names: ["yq"],
  askFlags: [exact("-i", "--inplace", "--in-place")],
  valueFlags: [exact("-o", "--output-format", "-p", "--input-format")],
  askReason: () => "yq：-i / --inplace 會就地修改輸入檔",
});

export const treeRule: CommandRule = flagGatedReader({
  names: ["tree"],
  askFlags: [exact("-o"), prefix("-o")],
  valueFlags: [exact("-o", "-L", "-P", "-I")],
  askReason: () => "tree：-o 會把輸出寫入檔案",
});

export const fileCmdRule: CommandRule = flagGatedReader({
  names: ["file"],
  askFlags: [exact("-C", "--compile")],
  valueFlags: [exact("-m", "--magic-file", "-f", "--files-from")],
  askReason: () => "file：-C / --compile 會寫出 magic.mgc",
});

export const dateRule: CommandRule = flagGatedReader({
  names: ["date"],
  askFlags: [exact("-s", "--set"), prefix("--set=", "-s")],
  valueFlags: [exact("-d", "--date", "-r", "--reference", "-f", "--file")],
  askReason: () => "date：-s / --set 會修改系統時間",
});
```

> 註：`flagGatedReader` 會對位置參數做範圍檢查；`date '+%Y'` 的 `+%Y` 解析為相對路徑 → 落在專案內 → allow（無害）。

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/simple-flag_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/simple-flag.ts src/rules/commands/simple-flag_test.ts
git commit -m "feat: add sort/yq/tree/file/date flag-gated rules"
```

---

## Task 16: xxd / uniq 位置輸出檔規則

**Files:**
- Create: `src/rules/commands/positional-output.ts`
- Test: `src/rules/commands/positional-output_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/positional-output_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { uniqRule, xxdRule } from "./positional-output.ts";
import type { CommandRule, RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

function v(rule: CommandRule, name: string, src: string) {
  return rule.evaluate(ctxOf(name, src)).kind;
}

Deno.test("xxd single input allows", () => {
  assertEquals(v(xxdRule, "xxd", "xxd file"), "allow");
});

Deno.test("xxd -l value then single input allows", () => {
  assertEquals(v(xxdRule, "xxd", "xxd -l 16 file"), "allow");
});

Deno.test("xxd input + output file asks", () => {
  assertEquals(v(xxdRule, "xxd", "xxd in out.bin"), "ask");
});

Deno.test("uniq single input allows", () => {
  assertEquals(v(uniqRule, "uniq", "uniq file"), "allow");
});

Deno.test("uniq input + output asks", () => {
  assertEquals(v(uniqRule, "uniq", "uniq in out.txt"), "ask");
});

Deno.test("uniq -f value then single input allows", () => {
  assertEquals(v(uniqRule, "uniq", "uniq -f 2 file"), "allow");
});

Deno.test("xxd out-of-project input asks", () => {
  assertEquals(v(xxdRule, "xxd", "xxd /etc/hosts"), "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/positional-output_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/positional-output.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { exact, type FlagMatcher, positionals } from "../flags.ts";

const XXD_VALUE_FLAGS: FlagMatcher[] = [exact("-s", "-l", "-c", "-g", "-o", "-seek")];
const UNIQ_VALUE_FLAGS: FlagMatcher[] = [
  exact("-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars", "--group", "--all-repeated"),
];

/** `cmd [INPUT [OUTPUT]]`：≥2 個位置參數代表有輸出檔 → ask；否則檢查輸入路徑。 */
function positionalOutputRule(names: string[], valueFlags: FlagMatcher[]): CommandRule {
  return {
    names,
    evaluate(ctx: RuleContext): RuleVerdict {
      const pos = positionals(ctx.argv, valueFlags);
      if (pos.length >= 2) {
        return ask(`${ctx.name}：第二個位置參數為輸出檔（會寫檔）`);
      }
      if (pos.length === 1 && ctx.resolvePath(pos[0]) !== "in-project") {
        return ask(`${ctx.name}：輸入路徑超出專案範圍或無法解析（${pos[0].value}）`);
      }
      return allow();
    },
  };
}

export const xxdRule = positionalOutputRule(["xxd"], XXD_VALUE_FLAGS);
export const uniqRule = positionalOutputRule(["uniq"], UNIQ_VALUE_FLAGS);
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/positional-output_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/positional-output.ts src/rules/commands/positional-output_test.ts
git commit -m "feat: add xxd/uniq positional-output rule"
```

---

## Task 17: grep / rg / egrep / fgrep 規則

讀取型；對位置參數（pattern + 檔案）做範圍檢查，跳過會吃值的 flag。寫重導向由中央規則處理。

**Files:**
- Create: `src/rules/commands/grep.ts`
- Test: `src/rules/commands/grep_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/grep_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { grepRule } from "./grep.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

Deno.test("grep in-project allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep foo bar.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rn TODO src")).kind, "allow");
});

Deno.test("grep reading out-of-project file asks", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep root /etc/passwd")).kind, "ask");
});

Deno.test("rg -A value skipped, in-project allows", () => {
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg -A 3 pattern src")).kind, "allow");
});

Deno.test("rule covers aliases", () => {
  assertEquals(grepRule.names.includes("egrep"), true);
  assertEquals(grepRule.names.includes("rg"), true);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/grep.ts`**

```typescript
import type { CommandRule } from "../types.ts";
import { flagGatedReader } from "../factory.ts";
import { exact } from "../flags.ts";

// grep 與 rg 共通：會吃下一 token 當值的 flag。
const VALUE_FLAGS = [
  exact(
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-d", "--directories", "--color", "--colour",
    "-r", "--replace", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-M",
  ),
];

/**
 * 對所有位置參數（含 pattern）做範圍檢查。pattern 通常為相對字串 → 落在專案內 →
 * allow；只有 pattern / 檔案看起來是專案外絕對路徑時才 ask（保守、罕見誤判可接受）。
 */
export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  valueFlags: VALUE_FLAGS,
});
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/grep.ts src/rules/commands/grep_test.ts
git commit -m "feat: add grep-family rule"
```

---

## Task 18: git 子指令規則

依子指令判定 allow / ask（指令級路徑選項已由 walk 的 `gitEffectiveCwd` 處理，故 cwd 範圍由中央前置規則把關；本規則只看子指令與其 flag）。

**Files:**
- Create: `src/rules/commands/git.ts`
- Test: `src/rules/commands/git_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/commands/git_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { gitRule } from "./git.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "git",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
  };
}

function v(src: string) {
  return gitRule.evaluate(ctxOf(src)).kind;
}

Deno.test("read subcommands allow", () => {
  assertEquals(v("git status"), "allow");
  assertEquals(v("git log --oneline"), "allow");
  assertEquals(v("git diff HEAD~1"), "allow");
  assertEquals(v("git show abc123"), "allow");
});

Deno.test("write subcommands ask", () => {
  assertEquals(v("git commit -m x"), "ask");
  assertEquals(v("git push"), "ask");
  assertEquals(v("git checkout main"), "ask");
});

Deno.test("global path options before read subcommand still allow at rule level", () => {
  assertEquals(v("git -C sub status"), "allow");
  assertEquals(v("git -c core.pager=cat log"), "allow");
});

Deno.test("branch list allows, branch -d asks", () => {
  assertEquals(v("git branch"), "allow");
  assertEquals(v("git branch -d feature"), "ask");
});

Deno.test("config read allows, config set asks", () => {
  assertEquals(v("git config --get user.name"), "allow");
  assertEquals(v("git config user.name Bob"), "ask");
});

Deno.test("stash list allows, stash push asks", () => {
  assertEquals(v("git stash list"), "allow");
  assertEquals(v("git stash"), "ask");
  assertEquals(v("git stash push"), "ask");
});

Deno.test("remote -v allows, remote add asks", () => {
  assertEquals(v("git remote -v"), "allow");
  assertEquals(v("git remote add origin url"), "ask");
});

Deno.test("unknown / dynamic subcommand asks", () => {
  assertEquals(v("git frobnicate"), "ask");
  assertEquals(v("git $SUB"), "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/commands/git_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/commands/git.ts`**

```typescript
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/** git 全域選項中會吃掉下一 token 當值者。 */
const GLOBAL_VALUE_OPTS = new Set<string>([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
]);

/** 純讀取子指令（其餘子指令一律 ask）。 */
const READ_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe",
  "cat-file", "ls-files", "ls-tree", "for-each-ref", "reflog", "shortlog", "grep",
]);

/** 取得子指令與其後的引數（跳過全域選項及其值）。 */
function parseSub(argv: RuleContext["argv"]): { sub: string | null; rest: string[]; dynamic: boolean } {
  let i = 0;
  while (i < argv.length) {
    const t = staticValue(argv[i]);
    if (t === null) return { sub: null, rest: [], dynamic: true };
    if (!t.startsWith("-")) break;
    // 吃值的全域選項：`--opt=val` 為單 token；`--opt val` / `-C val` 吃下一個
    if (GLOBAL_VALUE_OPTS.has(t)) i += 2;
    else i += 1;
  }
  if (i >= argv.length) return { sub: null, rest: [], dynamic: false };
  const subTok = staticValue(argv[i]);
  if (subTok === null) return { sub: null, rest: [], dynamic: true };
  const rest: string[] = [];
  for (let j = i + 1; j < argv.length; j++) {
    const r = staticValue(argv[j]);
    rest.push(r ?? " "); // 動態值以哨符代表
  }
  return { sub: subTok, rest, dynamic: false };
}

function has(rest: string[], ...flags: string[]): boolean {
  return rest.some((r) => flags.includes(r));
}

export const gitRule: CommandRule = {
  names: ["git"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const { sub, rest, dynamic } = parseSub(ctx.argv);
    if (dynamic) return ask("git：子指令含動態值，無法靜態判定");
    if (sub === null) return ask("git：未指定子指令");

    if (READ_SUBCOMMANDS.has(sub)) return allow();

    switch (sub) {
      case "branch":
        return has(rest, "-d", "-D", "-m", "-M", "--delete", "--move")
          ? ask("git branch：含刪除 / 改名旗標")
          : allow();
      case "tag":
        // 純列出（無引數或 -l/--list/-n）→ allow；建立 / 刪除 → ask
        return rest.length === 0 || has(rest, "-l", "--list") ||
            rest.every((r) => r.startsWith("-n"))
          ? allow()
          : ask("git tag：非列出操作");
      case "config":
        return has(rest, "--get", "--get-all", "--get-regexp", "--list", "-l")
          ? allow()
          : ask("git config：非讀取操作（set / unset）");
      case "stash":
        return rest[0] === "list" ? allow() : ask("git stash：非 list 操作");
      case "remote":
        return rest.length === 0 || has(rest, "-v", "--verbose") || rest[0] === "show"
          ? allow()
          : ask("git remote：非列出操作");
      default:
        return ask(`git ${sub}：非唯讀子指令或未列入 allowlist`);
    }
  },
};
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/commands/git_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/git.ts src/rules/commands/git_test.ts
git commit -m "feat: add git subcommand rule"
```

---

## Task 19: allowlist 索引

**Files:**
- Create: `src/rules/allowlist.ts`
- Test: `src/rules/allowlist_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/rules/allowlist_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { lookupRule } from "./allowlist.ts";

Deno.test("known commands resolve to a rule", () => {
  for (const name of ["cat", "echo", "cd", "sed", "awk", "find", "sort", "yq", "tree", "file", "date", "xxd", "uniq", "grep", "rg", "git"]) {
    assertEquals(lookupRule(name) !== undefined, true, `expected rule for ${name}`);
  }
});

Deno.test("excluded / unknown commands resolve to undefined", () => {
  for (const name of ["rm", "mv", "mkdir", "less", "npm", "bash", "tee", "xargs"]) {
    assertEquals(lookupRule(name), undefined, `expected no rule for ${name}`);
  }
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/rules/allowlist_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/rules/allowlist.ts`**

```typescript
import type { CommandRule } from "./types.ts";
import { cdRule, fileReaderRule, pureUtilRule } from "./commands/coreutils.ts";
import { sedRule } from "./commands/sed.ts";
import { awkRule } from "./commands/awk.ts";
import { findRule } from "./commands/find.ts";
import { dateRule, fileCmdRule, sortRule, treeRule, yqRule } from "./commands/simple-flag.ts";
import { uniqRule, xxdRule } from "./commands/positional-output.ts";
import { grepRule } from "./commands/grep.ts";
import { gitRule } from "./commands/git.ts";

const RULES: CommandRule[] = [
  fileReaderRule,
  pureUtilRule,
  cdRule,
  sedRule,
  awkRule,
  findRule,
  sortRule,
  yqRule,
  treeRule,
  fileCmdRule,
  dateRule,
  xxdRule,
  uniqRule,
  grepRule,
  gitRule,
];

const INDEX = new Map<string, CommandRule>();
for (const rule of RULES) {
  for (const name of rule.names) {
    if (INDEX.has(name)) throw new Error(`duplicate rule for command: ${name}`);
    INDEX.set(name, rule);
  }
}

/** 取得指令對應的規則；未列入 allowlist → undefined。 */
export function lookupRule(name: string): CommandRule | undefined {
  return INDEX.get(name);
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/rules/allowlist_test.ts`
Expected: PASS（重複 name 會在載入時即丟例外，等同註冊衝突的回歸測試）

- [ ] **Step 5: Commit**

```bash
git add src/rules/allowlist.ts src/rules/allowlist_test.ts
git commit -m "feat: add allowlist registry"
```

---

## Task 20: 單指令判定（classify.ts）

**Files:**
- Create: `src/engine/classify.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/classify_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import type { CwdState } from "../types.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

function only(src: string) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT);
}

Deno.test("dynamic command name asks", () => {
  assertEquals(only("$CMD a").kind, "ask");
});

Deno.test("not-in-allowlist asks", () => {
  assertEquals(only("rm -rf x").kind, "ask");
});

Deno.test("known-out-of-project cwd asks before rule", () => {
  const invs = walk(parseCommand("cd /tmp && cat a").script, START, ROOT);
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(classify(cat, ROOT).kind, "ask");
});

Deno.test("write redirect asks", () => {
  assertEquals(only("echo hi > out.txt").kind, "ask");
});

Deno.test("read-only in-project allows", () => {
  assertEquals(only("cat src/a.ts").kind, "allow");
});

Deno.test("null-device redirect still allows", () => {
  assertEquals(only("grep x f 2>/dev/null").kind, "allow");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/classify.ts`**

```typescript
import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { isWithin, resolvePath } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";

/** 對單一指令呼叫判定 allow / ask。 */
export function classify(inv: CommandInvocation, root: string): RuleVerdict {
  if (inv.name === null) return ask("動態指令名，無法判定");

  const rule = lookupRule(inv.name);
  if (!rule) return ask(`未列入 allowlist 的指令：${inv.name}`);

  // 中央前置規則之一：cwd 範圍（known 但落在專案外）
  if (inv.cwd.kind === "known" && !isWithin(root, inv.cwd.path)) {
    return ask(`工作目錄超出專案範圍：${inv.cwd.path}`);
  }
  // 中央前置規則之二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, root),
  });
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "feat: classify a single invocation with central pre-rules"
```

---

## Task 21: 合併（combine.ts）

**Files:**
- Create: `src/engine/combine.ts`
- Test: `src/engine/combine_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/combine_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { combine } from "./combine.ts";

Deno.test("all allow -> allow", () => {
  assertEquals(combine([{ kind: "allow" }, { kind: "allow" }]).verdict, "allow");
});

Deno.test("any ask -> ask with first ask reason", () => {
  const d = combine([{ kind: "allow" }, { kind: "ask", reason: "因為 X" }, { kind: "ask", reason: "因為 Y" }]);
  assertEquals(d.verdict, "ask");
  assertEquals(d.reason, "因為 X");
});

Deno.test("empty -> allow (no-op)", () => {
  assertEquals(combine([]).verdict, "allow");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/combine.ts`**

```typescript
import type { Decision } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";

/** 最弱環節：任一 ask → 整體 ask（取首個 ask 原因）；全部 allow → allow。 */
export function combine(verdicts: RuleVerdict[]): Decision {
  for (const v of verdicts) {
    if (v.kind === "ask") return { verdict: "ask", reason: v.reason };
  }
  return { verdict: "allow", reason: "純唯讀指令，全部路徑位於專案內" };
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/combine.ts src/engine/combine_test.ts
git commit -m "feat: add weakest-link combine"
```

---

## Task 22: 主流程編排（evaluate.ts）+ 表格驅動整合測試

**Files:**
- Create: `src/engine/evaluate.ts`
- Test: `src/engine/evaluate_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/engine/evaluate_test.ts`（涵蓋 spec 案例清單）**

```typescript
import { assertEquals } from "@std/assert";
import { evaluate } from "./evaluate.ts";
import type { CwdState, Verdict } from "../types.ts";

const ROOT = "/proj";
const AT_ROOT: CwdState = { kind: "known", path: "/proj" };

const cases: Array<{ cmd: string; want: Verdict; cwd?: CwdState; note: string }> = [
  // 唯讀 allow
  { cmd: "cat src/a.ts", want: "allow", note: "read in-project" },
  { cmd: "sed -n '30,45p' file", want: "allow", note: "sed print range" },
  { cmd: "awk 'NR>=8940 && NR<=9281' file", want: "allow", note: "awk NR filter" },
  { cmd: "git diff", want: "allow", note: "git read" },
  { cmd: "grep -rn TODO src", want: "allow", note: "grep recursive" },
  // null 裝置
  { cmd: "grep foo file 2>/dev/null", want: "allow", note: "null device" },
  { cmd: "cat a > /dev/null 2>&1", want: "allow", note: "null device + fd dup" },
  // 範圍逸出
  { cmd: "cat /etc/passwd", want: "ask", note: "absolute out" },
  { cmd: "cd /tmp && ls", want: "ask", note: "cd out then ls" },
  { cmd: "cat ../secret", want: "ask", note: "relative escape" },
  { cmd: "sed -n '1,5p' /etc/passwd", want: "ask", note: "flag-cond out" },
  { cmd: "awk 'NR<5' /etc/passwd", want: "ask", note: "awk out" },
  { cmd: "xxd /etc/hosts", want: "ask", note: "xxd out" },
  // 寫入
  { cmd: "sed -i 's/a/b/' file", want: "ask", note: "sed -i" },
  { cmd: "git commit -m x", want: "ask", note: "git write" },
  { cmd: "echo hi > out.txt", want: "ask", note: "redirect write" },
  { cmd: "mkdir foo", want: "ask", note: "not in allowlist" },
  // 動態
  { cmd: "cat $FILE", want: "ask", note: "dynamic path" },
  { cmd: "cat $(ls)", want: "ask", note: "command substitution arg" },
  { cmd: "cat *.txt", want: "ask", note: "glob" },
  { cmd: "cd $X && cat f", want: "ask", note: "unknown cwd then relative" },
  // 組合
  { cmd: "cat a | tee b", want: "ask", note: "pipe with non-allowed tee" },
  { cmd: "cat a && rm b", want: "ask", note: "and-or with write" },
  { cmd: "( cat a; mkdir b )", want: "ask", note: "subshell with write" },
  { cmd: "echo $(rm x)", want: "ask", note: "command substitution inner write" },
  // 旗標寫入破綻
  { cmd: "sed 's/a/b/w out' file", want: "ask", note: "sed s///w" },
  { cmd: "sort -o out.txt file", want: "ask", note: "sort -o" },
  { cmd: "yq -i '.a=1' f.yml", want: "ask", note: "yq -i" },
  { cmd: "xxd in out.bin", want: "ask", note: "xxd positional out" },
  { cmd: "uniq in out.txt", want: "ask", note: "uniq positional out" },
  { cmd: "tree -o t.txt", want: "ask", note: "tree -o" },
  { cmd: "date -s '2020-01-01'", want: "ask", note: "date -s" },
  { cmd: "find . -delete", want: "ask", note: "find -delete" },
  { cmd: "awk '{print > \"out\"}' file", want: "ask", note: "awk redirect" },
  { cmd: "awk -f prog.awk file", want: "ask", note: "awk -f" },
  { cmd: "less file", want: "ask", note: "less excluded" },
  // git 指令級路徑
  { cmd: "git --git-dir=/outside/.git status", want: "ask", note: "git-dir out" },
  { cmd: "git --work-tree=/outside status", want: "ask", note: "work-tree out" },
  { cmd: "git -c core.worktree=/outside status", want: "ask", note: "core.worktree out" },
  { cmd: "git -C src status", want: "allow", note: "git -C in-project" },
  { cmd: "git -C /tmp status", want: "ask", note: "git -C out" },
  // 邊界
  { cmd: "# just a comment", want: "allow", note: "no-op" },
  { cmd: "", want: "allow", note: "empty" },
];

for (const c of cases) {
  Deno.test(`evaluate: ${c.note} -> ${c.want}  [${c.cmd}]`, () => {
    const d = evaluate(c.cmd, ROOT, c.cwd ?? AT_ROOT);
    assertEquals(d.verdict, c.want, `${c.cmd}: ${d.reason}`);
  });
}

Deno.test("trusted extension example: a custom allow rule would allow", () => {
  // 信任擴充以加入 allowlist 規則為之（見 allowlist_test）；此處確認 cat allow
  assertEquals(evaluate("cat README.md", ROOT, AT_ROOT).verdict, "allow");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/engine/evaluate.ts`**

```typescript
import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import { combine } from "./combine.ts";

/**
 * 主流程：parse → walk → 逐指令判定 → 合併。
 * 任何例外 → ask（fail-safe）。root 必為有效專案根。
 */
export function evaluate(command: string, root: string, initialCwd: CwdState): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    return combine(invocations.map((inv) => classify(inv, root)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: PASS（全部表格案例綠）

- [ ] **Step 5: Commit**

```bash
git add src/engine/evaluate.ts src/engine/evaluate_test.ts
git commit -m "feat: orchestrate evaluation with table-driven coverage"
```

---

## Task 23: hook I/O

**Files:**
- Create: `src/hook/types.ts`
- Create: `src/hook/io.ts`
- Test: `src/hook/io_test.ts`

- [ ] **Step 1: 建立 `src/hook/types.ts`**

```typescript
import type { Verdict } from "../types.ts";

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
  session_id?: string;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: Verdict;
    permissionDecisionReason: string;
  };
}
```

- [ ] **Step 2: 寫失敗測試 `src/hook/io_test.ts`**

```typescript
import { assertEquals } from "@std/assert";
import { parseHookInput, renderDecision } from "./io.ts";

Deno.test("parseHookInput extracts fields", () => {
  const input = parseHookInput(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat a" }, cwd: "/proj" }),
  );
  assertEquals(input.tool_name, "Bash");
  assertEquals(input.tool_input?.command, "cat a");
  assertEquals(input.cwd, "/proj");
});

Deno.test("renderDecision builds the exact hook output JSON", () => {
  const json = renderDecision({ verdict: "allow", reason: "ok" });
  assertEquals(JSON.parse(json), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "ok",
    },
  });
});
```

- [ ] **Step 3: 執行確認失敗**

Run: `deno test --allow-env src/hook/io_test.ts`
Expected: FAIL

- [ ] **Step 4: 實作 `src/hook/io.ts`**

```typescript
import type { Decision } from "../types.ts";
import type { HookInput, HookOutput } from "./types.ts";

/** 讀取 stdin 全部內容為字串。 */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

export function parseHookInput(raw: string): HookInput {
  return JSON.parse(raw) as HookInput;
}

/** 產出嚴格符合 hook 契約的 decision JSON。 */
export function renderDecision(decision: Decision): string {
  const out: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.verdict,
      permissionDecisionReason: decision.reason,
    },
  };
  return JSON.stringify(out);
}
```

- [ ] **Step 5: 執行確認通過**

Run: `deno test --allow-env src/hook/io_test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/hook/types.ts src/hook/io.ts src/hook/io_test.ts
git commit -m "feat: add hook input/output io"
```

---

## Task 24: 進入點（main.ts）+ 端對端測試

**Files:**
- Create: `src/main.ts`
- Test: `src/main_test.ts`

- [ ] **Step 1: 寫失敗測試 `src/main_test.ts`（以子行程餵 stdin）**

```typescript
import { assertEquals } from "@std/assert";

/** 以子行程執行 main.ts，餵入 hook JSON，回傳 stdout。 */
async function runHook(payload: unknown, projectDir: string): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "src/main.ts"],
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout } = await child.output();
  return new TextDecoder().decode(stdout).trim();
}

Deno.test("e2e: read-only in-project -> allow", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat src/a.ts" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: write -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: non-Bash tool -> no output", async () => {
  const out = await runHook(
    { tool_name: "Read", tool_input: {}, cwd: "/proj" },
    "/proj",
  );
  assertEquals(out, "");
});

Deno.test("e2e: malformed stdin -> ask, never crash", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "src/main.ts"],
    env: { CLAUDE_PROJECT_DIR: "/proj" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not json"));
  await writer.close();
  const { stdout, code } = await child.output();
  const out = new TextDecoder().decode(stdout).trim();
  assertEquals(code, 0);
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `src/main.ts`**

```typescript
import { parseHookInput, readStdin, renderDecision } from "./hook/io.ts";
import { resolveProjectRoot } from "./project.ts";
import { evaluate } from "./engine/evaluate.ts";
import { normalizeAbsolute } from "./engine/scope.ts";
import type { CwdState, Decision } from "./types.ts";

function initialCwd(cwd: string | undefined, root: string): CwdState {
  if (cwd && cwd.trim() !== "") return { kind: "known", path: normalizeAbsolute(cwd.trim()) };
  return { kind: "known", path: root };
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "無法讀取 hook 輸入" }));
    return;
  }

  let input;
  try {
    input = parseHookInput(raw);
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "hook 輸入非合法 JSON" }));
    return;
  }

  // 非 Bash：不輸出任何 decision，交回 Claude Code 預設流程。
  if (input.tool_name !== "Bash") return;

  const root = resolveProjectRoot(Deno.env);
  let decision: Decision;
  if (root === null) {
    decision = {
      verdict: "ask",
      reason: "無法確定專案根目錄（CLAUDE_PROJECT_DIR 未設定）",
    };
  } else {
    const command = input.tool_input?.command ?? "";
    decision = evaluate(command, root, initialCwd(input.cwd, root));
  }
  console.log(renderDecision(decision));
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" }));
  }
  Deno.exit(0);
}
```

- [ ] **Step 4: 執行確認通過**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/main_test.ts
git commit -m "feat: add hook entry point"
```

---

## Task 25: README、全套驗證與 compile

**Files:**
- Create: `README.md`

- [ ] **Step 1: 撰寫 `README.md`**

````markdown
# Bash 權限檢查器（Claude Code PreToolUse hook）

解析 Bash 指令，僅在「純唯讀且全部落在當前專案內」時自動 `allow`，其餘 `ask`。
永不 `deny`。詳見 `docs/superpowers/specs/2026-05-29-bash-permission-checker-design.md`。

## 建置

```bash
deno task build
# 產出 dist/permission-checker（Windows 為 dist/permission-checker.exe）
```

## 接線（`~/.claude/settings.json`）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "D:\\path\\to\\dist\\permission-checker.exe" }
        ]
      }
    ]
  }
}
```

## 開發

```bash
deno task test    # 單元 + 整合測試
deno task check   # 型別檢查
deno task lint
```

## 新增信任指令

在 `src/rules/commands/` 新增一個 `CommandRule`（或調整既有規則），於
`src/rules/allowlist.ts` 註冊，重新 `deno task build`。規則的 `evaluate`
回傳 `allow()` 或 `ask(reason)`；對會讀檔的參數呼叫 `ctx.resolvePath(arg)`
做範圍檢查。
````

- [ ] **Step 2: 全套單元 + 整合測試**

Run: `deno task test`
Expected: 全部 PASS（task 已含 `--allow-run --allow-env --allow-read`）

- [ ] **Step 3: 型別檢查與 lint**

Run: `deno task check && deno task lint`
Expected: 皆無錯誤

- [ ] **Step 4: compile 並 operational verification（實際餵 JSON）**

Run:
```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"cat README.md"},"cwd":"'"$PWD"'"}' \
  | CLAUDE_PROJECT_DIR="$PWD" ./dist/permission-checker
```
Expected stdout（單行 JSON）：
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"純唯讀指令，全部路徑位於專案內"}}`

> 若 compile 後執行期報缺其他 `--allow-env` 變數，依實際錯誤訊息補進 `deno.json`
> 的 `build` task（operational verification）。

- [ ] **Step 5: 確認 exit code 為 0**

Run:
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"'"$PWD"'"}' \
  | CLAUDE_PROJECT_DIR="$PWD" ./dist/permission-checker > /dev/null; echo "exit=$?"
```
Expected: `exit=0`（且該指令判定為 `ask`）

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add README with build and wiring instructions"
```

---

## 完成準則

- `deno task test`（含 `--allow-run --allow-env --allow-read`）、`deno task check`、
  `deno task lint` 全綠。
- `deno task build` 產出單一執行檔；實際餵 JSON 的 operational verification 通過、
  exit code 0。
- spec 案例清單（Task 22 表格）全數符合預期判定。

