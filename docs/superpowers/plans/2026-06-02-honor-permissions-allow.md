# Honor permissions.allow at Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 PreToolUse Bash 檢查器在 runtime 讀取使用者的 `permissions.allow`，把原本會 `ask` 但已被使用者明確放行（且未被 deny/ask）的指令升級為 `allow`，消除「hook ask 蓋過 settings allow」的重複詢問。

**Architecture:** 新增 `src/permissions/` 兩個模組——`matcher.ts`（解析 `Bash(...)` 規則、字串匹配、把 invocation 還原成可比對字串、綜合升級判定）與 `settings.ts`（讀取並合併三個 settings 檔成規則集）。在 `classify` 判定為 `ask` 後嘗試以規則升級；`evaluate`/`main` 把規則一路傳入；`combine` 的 allow 訊息改為對兩種放行機制皆成立的中性措辭。

**Tech Stack:** Deno + TypeScript；測試用 `@std/assert` 與 `deno test`；解析沿用 `parse.ts`/`walk.ts`；型別自 `src/deps.ts`、`src/types.ts`、`src/rules/types.ts`。

---

## File Structure

- **Create `src/permissions/matcher.ts`** — `BashPattern` 型別、`parseBashRule`、`matchesPattern`、`matchesAny`、`reconstructCommand`、`settingsAllows`。
- **Create `src/permissions/matcher_test.ts`** — 上述函式的單元測試。
- **Create `src/permissions/settings.ts`** — `PermissionRules`、`EMPTY_RULES`、`ReadText`、`defaultReadText`、`loadPermissionRules`。
- **Create `src/permissions/settings_test.ts`** — 載入/合併/家目錄解析測試（注入 `ReadText`、`EnvReader`）。
- **Modify `src/engine/classify.ts`** — 主體抽成 `classifyBuiltin`，新 `classify` 在 ask 時嘗試升級。
- **Modify `src/engine/classify_test.ts`** — 新增升級相關案例。
- **Modify `src/engine/combine.ts`** — allow 訊息改中性措辭。
- **Modify `src/engine/combine_test.ts`** — 新增 allow reason 斷言。
- **Modify `src/engine/evaluate.ts`** — 新增 `rules` 參數並下傳。
- **Modify `src/engine/evaluate_test.ts`** — 新增帶 rules 的升級案例。
- **Modify `src/main.ts`** — 載入規則並傳入 `evaluate`。
- **Modify `deno.json`** — build 旗標加 `--allow-read` 並擴充 `--allow-env`。
- **Create `src/testdata/proj-with-settings/.claude/settings.json`** — e2e fixture。
- **Modify `src/main_test.ts`** — e2e 升級測試 + runHook 加 `--allow-read`。

依賴順序：matcher 核心 → reconstruct → settings → settingsAllows → classify → combine → evaluate → main/build → e2e。

---

## Task 1: matcher.ts — BashPattern 解析與字串匹配

**Files:**
- Create: `src/permissions/matcher.ts`
- Test: `src/permissions/matcher_test.ts`

- [ ] **Step 1: 寫失敗測試（parseBashRule / matchesPattern / matchesAny）**

建立 `src/permissions/matcher_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { matchesAny, matchesPattern, parseBashRule } from "./matcher.ts";

Deno.test("parseBashRule: :* -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(npm test:*)"), { kind: "prefix-boundary", prefix: "npm test" });
});

Deno.test("parseBashRule: space-star -> prefix-boundary", () => {
  assertEquals(parseBashRule("Bash(ls *)"), { kind: "prefix-boundary", prefix: "ls" });
});

Deno.test("parseBashRule: trailing star no space -> prefix-loose", () => {
  assertEquals(parseBashRule("Bash(ls*)"), { kind: "prefix-loose", prefix: "ls" });
});

Deno.test("parseBashRule: no star -> exact", () => {
  assertEquals(parseBashRule("Bash(git status)"), { kind: "exact", text: "git status" });
});

Deno.test("parseBashRule: non-Bash tool -> null", () => {
  assertEquals(parseBashRule("Read(./x)"), null);
});

Deno.test("parseBashRule: mid-star -> null", () => {
  assertEquals(parseBashRule("Bash(git * --x)"), null);
  assertEquals(parseBashRule("Bash(git * status:*)"), null);
});

Deno.test("parseBashRule: empty inner -> null", () => {
  assertEquals(parseBashRule("Bash()"), null);
});

Deno.test("parseBashRule: empty prefix (matches all) -> null", () => {
  assertEquals(parseBashRule("Bash(*)"), null);
  assertEquals(parseBashRule("Bash(:*)"), null);
  assertEquals(parseBashRule("Bash( *)"), null);
});

Deno.test("parseBashRule: not Bash(...) shape -> null", () => {
  assertEquals(parseBashRule("Bash(ls"), null);
  assertEquals(parseBashRule("npm test"), null);
});

Deno.test("matchesPattern: prefix-boundary matches prefix and prefix+space, not glued", () => {
  const p = parseBashRule("Bash(ls *)")!;
  assertEquals(matchesPattern("ls", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
  assertEquals(matchesPattern("lsof", p), false);
});

Deno.test("matchesPattern: prefix-loose matches glued", () => {
  const p = parseBashRule("Bash(ls*)")!;
  assertEquals(matchesPattern("lsof", p), true);
  assertEquals(matchesPattern("ls -la", p), true);
});

Deno.test("matchesPattern: exact matches only equal", () => {
  const p = parseBashRule("Bash(git status)")!;
  assertEquals(matchesPattern("git status", p), true);
  assertEquals(matchesPattern("git status --short", p), false);
});

Deno.test("matchesAny: true if any pattern matches", () => {
  const pats = [parseBashRule("Bash(git status)")!, parseBashRule("Bash(npm test:*)")!];
  assertEquals(matchesAny("npm test --silent", pats), true);
  assertEquals(matchesAny("rm -rf x", pats), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: FAIL（`Module not found` 或 `parseBashRule is not exported`）。

- [ ] **Step 3: 實作 matcher.ts（本 Task 範圍）**

建立 `src/permissions/matcher.ts`：

```ts
/** 解析後的 Bash(...) 規則。prefix / text 經 parseBashRule 保證非空。 */
export type BashPattern =
  | { kind: "exact"; text: string }
  | { kind: "prefix-boundary"; prefix: string }
  | { kind: "prefix-loose"; prefix: string };

/** 解析 "Bash(...)" 規則字串；非 Bash(...) 或無法可靠解析的形式 → null。 */
export function parseBashRule(rule: string): BashPattern | null {
  if (!rule.startsWith("Bash(") || !rule.endsWith(")")) return null;
  const inner = rule.slice("Bash(".length, -1);
  if (inner === "") return null;

  if (inner.endsWith(":*")) {
    const p = inner.slice(0, -2);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-boundary", prefix: p };
  }
  if (inner.endsWith(" *")) {
    const p = inner.slice(0, -2);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-boundary", prefix: p };
  }
  if (inner.endsWith("*")) {
    const p = inner.slice(0, -1);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-loose", prefix: p };
  }
  if (!inner.includes("*")) {
    return { kind: "exact", text: inner };
  }
  return null;
}

/** 單一指令字串是否命中某 pattern。 */
export function matchesPattern(cmd: string, pat: BashPattern): boolean {
  switch (pat.kind) {
    case "exact":
      return cmd === pat.text;
    case "prefix-boundary":
      return cmd === pat.prefix || cmd.startsWith(pat.prefix + " ");
    case "prefix-loose":
      return cmd.startsWith(pat.prefix);
  }
}

/** 是否命中任一 pattern。 */
export function matchesAny(cmd: string, pats: BashPattern[]): boolean {
  return pats.some((p) => matchesPattern(cmd, p));
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/permissions/matcher.ts src/permissions/matcher_test.ts
git commit -m "feat(permissions): add Bash rule parsing and matching"
```

---

## Task 2: matcher.ts — reconstructCommand

**Files:**
- Modify: `src/permissions/matcher.ts`
- Test: `src/permissions/matcher_test.ts`

- [ ] **Step 1: 寫失敗測試（reconstructCommand）**

於 `src/permissions/matcher_test.ts` 頂部 import 補上 `reconstructCommand`，並新增建構 invocation 的 helper 與測試：

```ts
import { parseCommand } from "../engine/parse.ts";
import { walk } from "../engine/walk.ts";
import type { CwdState } from "../types.ts";
import { matchesAny, matchesPattern, parseBashRule, reconstructCommand } from "./matcher.ts";

const ROOT = "/proj";
const START: CwdState = { kind: "known", path: "/proj" };

/** 取單一指令的第一筆 invocation。 */
function firstInv(src: string) {
  return walk(parseCommand(src).script, START, ROOT)[0];
}

Deno.test("reconstructCommand: name + static argv joined by single space", () => {
  assertEquals(reconstructCommand(firstInv("git diff --stat")), "git diff --stat");
});

Deno.test("reconstructCommand: quoted arg is de-quoted, single-space joined", () => {
  assertEquals(reconstructCommand(firstInv('grep "foo bar" f')), "grep foo bar f");
});

Deno.test("reconstructCommand: dynamic argv (variable) -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $FILE")), null);
});

Deno.test("reconstructCommand: command substitution arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat $(ls)")), null);
});

Deno.test("reconstructCommand: unquoted glob arg -> null", () => {
  assertEquals(reconstructCommand(firstInv("cat *.txt")), null);
});

Deno.test("reconstructCommand: assignment prefix -> null", () => {
  assertEquals(reconstructCommand(firstInv("FOO=bar cat a")), null);
});

Deno.test("reconstructCommand: dynamic command name -> null", () => {
  assertEquals(reconstructCommand(firstInv("$CMD a")), null);
});
```

（注意：原本 Task 1 的 `import { matchesAny, matchesPattern, parseBashRule } from "./matcher.ts";` 那行併入上面這行，避免重複 import。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: FAIL（`reconstructCommand is not exported`）。

- [ ] **Step 3: 於 matcher.ts 加入 reconstructCommand**

在 `src/permissions/matcher.ts` 頂部加入 import，並於檔尾加入函式：

```ts
import type { CommandInvocation } from "../types.ts";
import { staticValue } from "../engine/word.ts";
```

```ts
/**
 * 把 invocation 還原成單一可比對指令字串。
 * - name === null（動態指令名）→ null
 * - 有賦值前綴（VAR=val）→ null（env 前綴可改變行為，且 Claude Code 字面比對亦不會命中 cmd:*）
 * - 任一 argv 動態（變數 / $() / 未引號 glob，staticValue 回 null）→ null
 * 否則回 [name, ...argv 靜態值].join(" ")。引號值已去引號、不重新加引號；不含重導向。
 */
export function reconstructCommand(inv: CommandInvocation): string | null {
  if (inv.name === null) return null;
  if (inv.assignments.length > 0) return null;
  const parts: string[] = [inv.name];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    parts.push(v);
  }
  return parts.join(" ");
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: PASS。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/permissions/matcher.ts src/permissions/matcher_test.ts
git commit -m "feat(permissions): reconstruct invocation into matchable command string"
```

---

## Task 3: settings.ts — 載入與合併

**Files:**
- Create: `src/permissions/settings.ts`
- Test: `src/permissions/settings_test.ts`

- [ ] **Step 1: 寫失敗測試（loadPermissionRules）**

建立 `src/permissions/settings_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import type { EnvReader } from "../project.ts";
import { EMPTY_RULES, loadPermissionRules, type ReadText } from "./settings.ts";

const ROOT = "/proj";

/** 以 map 模擬讀檔；未列入的路徑回 null（不存在）。 */
function fakeReadText(map: Record<string, string>): ReadText {
  return (path) => (path in map ? map[path] : null);
}

/** 以 map 模擬環境變數。 */
function fakeEnv(map: Record<string, string>): EnvReader {
  return { get: (k) => map[k] };
}

const noHome = fakeEnv({});

Deno.test("EMPTY_RULES has three empty lists", () => {
  assertEquals(EMPTY_RULES, { allow: [], deny: [], ask: [] });
});

Deno.test("extracts Bash rules from a single project settings file", () => {
  const content = JSON.stringify({
    permissions: {
      allow: ["Bash(npm test:*)", "Read(./x)", 123, "Bash(git status)"],
      deny: ["Bash(rm:*)"],
      ask: ["Bash(curl:*)"],
    },
  });
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": content }),
  );
  assertEquals(rules.allow, [
    { kind: "prefix-boundary", prefix: "npm test" },
    { kind: "exact", text: "git status" },
  ]);
  assertEquals(rules.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
  assertEquals(rules.ask, [{ kind: "prefix-boundary", prefix: "curl" }]);
});

Deno.test("missing file -> empty", () => {
  const rules = loadPermissionRules(noHome, ROOT, fakeReadText({}));
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("malformed JSON -> empty, no throw", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": "not json {{{" }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("permissions not an object -> empty", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": JSON.stringify({ permissions: 42 }) }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("top-level not an object (array/number) -> empty", () => {
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": "[1,2,3]" }),
  );
  assertEquals(rules, { allow: [], deny: [], ask: [] });
});

Deno.test("rule list not an array -> that list empty", () => {
  const content = JSON.stringify({ permissions: { allow: "Bash(ls:*)", deny: ["Bash(rm:*)"] } });
  const rules = loadPermissionRules(
    noHome,
    ROOT,
    fakeReadText({ "/proj/.claude/settings.json": content }),
  );
  assertEquals(rules.allow, []);
  assertEquals(rules.deny, [{ kind: "prefix-boundary", prefix: "rm" }]);
});

Deno.test("merges project + local + user (union)", () => {
  const env = fakeEnv({ HOME: "/home/u", USERPROFILE: "/home/u" });
  const rules = loadPermissionRules(
    env,
    ROOT,
    fakeReadText({
      "/proj/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(a:*)"] } }),
      "/proj/.claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(b:*)"] } }),
      "/home/u/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(c:*)"] } }),
    }),
  );
  assertEquals(rules.allow.map((p) => (p as { prefix: string }).prefix), ["a", "b", "c"]);
});

Deno.test("requests the three expected file paths (posix home)", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(fakeEnv({ HOME: "/home/u" }), ROOT, reader);
  assertEquals(requested, [
    "/proj/.claude/settings.json",
    "/proj/.claude/settings.local.json",
    "/home/u/.claude/settings.json",
  ]);
});

Deno.test("no home env -> only project paths requested", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(noHome, ROOT, reader);
  assertEquals(requested, [
    "/proj/.claude/settings.json",
    "/proj/.claude/settings.local.json",
  ]);
});

Deno.test({
  name: "windows: USERPROFILE preferred; backslashes normalized",
  ignore: Deno.build.os !== "windows",
  fn() {
    const requested: string[] = [];
    const reader: ReadText = (path) => {
      requested.push(path);
      return null;
    };
    loadPermissionRules(fakeEnv({ USERPROFILE: "C:\\Users\\X", HOME: "/c/other" }), "D:/proj", reader);
    assertEquals(requested[2], "C:/Users/X/.claude/settings.json");
  },
});

Deno.test({
  name: "windows: falls back to HOME when USERPROFILE missing (MSYS form normalized)",
  ignore: Deno.build.os !== "windows",
  fn() {
    const requested: string[] = [];
    const reader: ReadText = (path) => {
      requested.push(path);
      return null;
    };
    loadPermissionRules(fakeEnv({ HOME: "/c/Users/X" }), "D:/proj", reader);
    assertEquals(requested[2], "C:/Users/X/.claude/settings.json");
  },
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/settings_test.ts`
Expected: FAIL（`Module not found ./settings.ts`）。

- [ ] **Step 3: 實作 settings.ts**

建立 `src/permissions/settings.ts`：

```ts
import type { EnvReader } from "../project.ts";
import { normalizeAbsolute } from "../engine/scope.ts";
import { type BashPattern, parseBashRule } from "./matcher.ts";

export interface PermissionRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** 空規則常數，供 classify.ts / evaluate.ts 作為預設參數（只讀，勿變動）。 */
export const EMPTY_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

/** 讀檔器：回傳檔案內容字串；不存在 / 無法讀 → null。注入以利測試。 */
export type ReadText = (path: string) => string | null;

/** 預設讀檔器：任何錯誤（NotFound / 權限 / 路徑為目錄 / I/O）一律吞掉回 null，不區分類型、不重拋。 */
export const defaultReadText: ReadText = (path) => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
};

function emptyRules(): PermissionRules {
  return { allow: [], deny: [], ask: [] };
}

function parseRuleList(value: unknown): BashPattern[] {
  if (!Array.isArray(value)) return [];
  const out: BashPattern[] = [];
  for (const el of value) {
    if (typeof el !== "string") continue;
    const pat = parseBashRule(el);
    if (pat !== null) out.push(pat);
  }
  return out;
}

function parseFile(content: string | null): PermissionRules {
  if (content === null) return emptyRules();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return emptyRules();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRules();
  const perms = (parsed as Record<string, unknown>).permissions;
  if (typeof perms !== "object" || perms === null) return emptyRules();
  const p = perms as Record<string, unknown>;
  return {
    allow: parseRuleList(p.allow),
    deny: parseRuleList(p.deny),
    ask: parseRuleList(p.ask),
  };
}

/** 依平台解析家目錄；皆無 → null。 */
function resolveHome(env: EnvReader): string | null {
  const isWindows = Deno.build.os === "windows";
  const primary = isWindows ? env.get("USERPROFILE") : env.get("HOME");
  const fallback = isWindows ? env.get("HOME") : env.get("USERPROFILE");
  if (primary && primary.trim() !== "") return primary;
  if (fallback && fallback.trim() !== "") return fallback;
  return null;
}

/**
 * 讀取並合併 專案 settings.json / settings.local.json / 使用者 ~/.claude/settings.json。
 * 任一檔失敗僅該檔貢獻空集合；永不丟例外、永不回 null（最外層 try/catch 兜底）。
 */
export function loadPermissionRules(
  env: EnvReader,
  root: string,
  readText: ReadText = defaultReadText,
): PermissionRules {
  try {
    const paths: string[] = [
      `${root}/.claude/settings.json`,
      `${root}/.claude/settings.local.json`,
    ];
    const home = resolveHome(env);
    if (home !== null) {
      paths.push(normalizeAbsolute(`${home}/.claude/settings.json`));
    }
    const merged = emptyRules();
    for (const path of paths) {
      let rules: PermissionRules;
      try {
        rules = parseFile(readText(path));
      } catch {
        rules = emptyRules();
      }
      merged.allow.push(...rules.allow);
      merged.deny.push(...rules.deny);
      merged.ask.push(...rules.ask);
    }
    return merged;
  } catch {
    return emptyRules();
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/permissions/settings_test.ts`
Expected: PASS（Windows 上含兩個平台案例；非 Windows 上該兩案例被 ignore）。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/permissions/settings.ts src/permissions/settings_test.ts
git commit -m "feat(permissions): load and merge Bash rules from settings files"
```

---

## Task 4: matcher.ts — settingsAllows

**Files:**
- Modify: `src/permissions/matcher.ts`
- Test: `src/permissions/matcher_test.ts`

- [ ] **Step 1: 寫失敗測試（settingsAllows）**

於 `src/permissions/matcher_test.ts` 補 import 並新增測試（沿用 Task 2 的 `firstInv` helper 與 `parseBashRule`）：

```ts
import type { PermissionRules } from "./settings.ts";
import { settingsAllows } from "./matcher.ts";

/** 由字串規則組出 PermissionRules。 */
function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}

Deno.test("settingsAllows: allow match -> true", () => {
  assertEquals(settingsAllows(firstInv("npm test --silent"), rulesOf({ allow: ["Bash(npm test:*)"] })), true);
});

Deno.test("settingsAllows: also denied -> false", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(npm test:*)"] });
  assertEquals(settingsAllows(firstInv("npm test"), rules), false);
});

Deno.test("settingsAllows: also asked -> false", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], ask: ["Bash(npm test:*)"] });
  assertEquals(settingsAllows(firstInv("npm test"), rules), false);
});

Deno.test("settingsAllows: no allow match -> false", () => {
  assertEquals(settingsAllows(firstInv("npm run build"), rulesOf({ allow: ["Bash(npm test:*)"] })), false);
});

Deno.test("settingsAllows: non-reconstructable (dynamic) -> false", () => {
  assertEquals(settingsAllows(firstInv("cat $FILE"), rulesOf({ allow: ["Bash(cat:*)"] })), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: FAIL（`settingsAllows is not exported`）。

- [ ] **Step 3: 於 matcher.ts 加入 settingsAllows**

在 `src/permissions/matcher.ts` 頂部加入型別 import（**僅型別**，避免 runtime 循環），檔尾加入函式：

```ts
import type { PermissionRules } from "./settings.ts";
```

```ts
/**
 * 綜合判定：此 invocation 是否應依 settings 升級為 allow。
 *   cmd = reconstructCommand(inv)；null → false
 *   matchesAny(cmd, deny) 或 matchesAny(cmd, ask) → false（完整優先序）
 *   matchesAny(cmd, allow) → true；否則 false
 */
export function settingsAllows(inv: CommandInvocation, rules: PermissionRules): boolean {
  const cmd = reconstructCommand(inv);
  if (cmd === null) return false;
  if (matchesAny(cmd, rules.deny)) return false;
  if (matchesAny(cmd, rules.ask)) return false;
  return matchesAny(cmd, rules.allow);
}
```

> 注意：`settings.ts` 以值匯入 `matcher.ts` 的 `parseBashRule`；`matcher.ts` 僅以 `import type` 匯入 `settings.ts` 的 `PermissionRules`。型別匯入在編譯期抹除，故 runtime 無循環相依。務必維持此方向，勿把 `PermissionRules` 改成值匯入。

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/permissions/matcher_test.ts`
Expected: PASS。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/permissions/matcher.ts src/permissions/matcher_test.ts
git commit -m "feat(permissions): settingsAllows combines reconstruct + deny/ask/allow matching"
```

---

## Task 5: classify.ts — ask 時嘗試升級

**Files:**
- Modify: `src/engine/classify.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: 寫失敗測試（升級行為）**

於 `src/engine/classify_test.ts` 頂部補 import，並新增 helper 與測試：

```ts
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";

function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}

function onlyWith(src: string, rules: PermissionRules) {
  const invs = walk(parseCommand(src).script, START, ROOT);
  return classify(invs[0], ROOT, rules);
}

Deno.test("settings allow upgrades ask -> allow", () => {
  assertEquals(onlyWith("npm test x", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("builtin allow stays allow regardless of rules", () => {
  assertEquals(onlyWith("cat src/a.ts", rulesOf({ allow: ["Bash(npm test:*)"] })).kind, "allow");
});

Deno.test("deny blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], deny: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("ask rule blocks the upgrade -> stays ask", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"], ask: ["Bash(npm test:*)"] });
  assertEquals(onlyWith("npm test", rules).kind, "ask");
});

Deno.test("no rules arg behaves as before (npm asks)", () => {
  assertEquals(only("npm test").kind, "ask");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL（`classify` 第三參數不存在 / 升級未實作 → `npm test x` 仍為 ask）。

- [ ] **Step 3: 重構 classify.ts**

將 `src/engine/classify.ts` 全檔改為（主體搬入 `classifyBuiltin`，新 `classify` 包升級）：

```ts
import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { allow, ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { isWithin, resolvePath, resolvePathValue } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";

/** 既有的中央前置規則 + allowlist 規則判定。 */
function classifyBuiltin(inv: CommandInvocation, root: string): RuleVerdict {
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
  // 中央前置規則之三：環境變數賦值前綴（LD_PRELOAD/BASH_ENV 等）可改變執行行為
  if (inv.assignments.length > 0) {
    return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);
  }

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, root),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, root),
  });
}

/** 對單一指令呼叫判定 allow / ask；builtin 判 ask 時，命中 settings allow（未被 deny/ask 命中）則升級。 */
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
): RuleVerdict {
  const v = classifyBuiltin(inv, root);
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS（含既有 8 個案例與新增 5 個）。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "feat(engine): upgrade ask to allow on settings permissions.allow match"
```

---

## Task 6: combine.ts — allow 訊息中性化

**Files:**
- Modify: `src/engine/combine.ts`
- Test: `src/engine/combine_test.ts`

- [ ] **Step 1: 新增/更新測試斷言 allow reason**

於 `src/engine/combine_test.ts` 把第一個測試改為同時斷言 reason：

```ts
Deno.test("all allow -> allow with neutral reason", () => {
  const d = combine([{ kind: "allow" }, { kind: "allow" }]);
  assertEquals(d.verdict, "allow");
  assertEquals(d.reason, "全部指令均通過（唯讀放行或命中 permissions.allow）");
});
```

（其餘兩個測試不變。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: FAIL（reason 仍為舊字串 `"純唯讀指令，全部路徑位於專案內"`）。

- [ ] **Step 3: 改 combine.ts 的 allow 訊息**

於 `src/engine/combine.ts` 將最後的 return 改為：

```ts
  return { verdict: "allow", reason: "全部指令均通過（唯讀放行或命中 permissions.allow）" };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/combine_test.ts`
Expected: PASS。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/engine/combine.ts src/engine/combine_test.ts
git commit -m "refactor(engine): neutral allow reason covering settings-based allow"
```

---

## Task 7: evaluate.ts — 新增 rules 參數並下傳

**Files:**
- Modify: `src/engine/evaluate.ts`
- Test: `src/engine/evaluate_test.ts`

- [ ] **Step 1: 寫失敗測試（帶 rules 的升級）**

於 `src/engine/evaluate_test.ts` 末尾新增：

```ts
import { parseBashRule } from "../permissions/matcher.ts";
import type { PermissionRules } from "../permissions/settings.ts";

function rulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const conv = (xs?: string[]) => (xs ?? []).map((s) => parseBashRule(s)!).filter(Boolean);
  return { allow: conv(spec.allow), deny: conv(spec.deny), ask: conv(spec.ask) };
}

Deno.test("evaluate: settings allow upgrades a single ask command", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("npm test --silent", ROOT, AT_ROOT, rules).verdict, "allow");
});

Deno.test("evaluate: compound builtin-allow + settings-allow -> allow", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("git diff && npm test", ROOT, AT_ROOT, rules).verdict, "allow");
});

Deno.test("evaluate: compound with one un-allowed command -> ask (weakest link)", () => {
  const rules = rulesOf({ allow: ["Bash(npm test:*)"] });
  assertEquals(evaluate("git diff && rm x", ROOT, AT_ROOT, rules).verdict, "ask");
});

Deno.test("evaluate: no rules arg keeps current behavior", () => {
  assertEquals(evaluate("npm test", ROOT, AT_ROOT).verdict, "ask");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL（`evaluate` 第四參數不存在 / 升級未生效）。

- [ ] **Step 3: 修改 evaluate.ts**

將 `src/engine/evaluate.ts` 全檔改為：

```ts
import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { classify } from "./classify.ts";
import { combine } from "./combine.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";

/**
 * 主流程：parse → walk → 逐指令判定 → 合併。
 * 任何例外 → ask（fail-safe）。root 必為有效專案根。
 */
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: PASS（含既有表格案例與新增 4 個）。

- [ ] **Step 5: type check + lint**

Run: `deno task check && deno task lint`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/engine/evaluate.ts src/engine/evaluate_test.ts
git commit -m "feat(engine): thread permission rules through evaluate"
```

---

## Task 8: main.ts 接線 + deno.json build 旗標

**Files:**
- Modify: `src/main.ts`
- Modify: `deno.json`

- [ ] **Step 1: 修改 main.ts 載入並傳入規則**

於 `src/main.ts`：頂部新增 import，並在 root 有效分支載入規則後傳入 `evaluate`。

新增 import（與既有 import 並列）：

```ts
import { loadPermissionRules } from "./permissions/settings.ts";
```

把既有的 `else` 分支：

```ts
  } else {
    const command = input.tool_input?.command ?? "";
    decision = evaluate(command, root, initialCwd(input.cwd, root));
  }
```

改為：

```ts
  } else {
    const command = input.tool_input?.command ?? "";
    const rules = loadPermissionRules(Deno.env, root);
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules);
  }
```

- [ ] **Step 2: 修改 deno.json build 旗標**

於 `deno.json` 把 `build` 任務改為（新增 `--allow-read`、擴充 `--allow-env`）：

```json
    "build": "deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE --output dist/permission-checker src/main.ts"
```

- [ ] **Step 3: type check + lint + 全測試**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠（`main_test.ts` 既有 e2e 仍通過——`/proj` 無 settings 檔，`defaultReadText` 吞讀取例外回 null → 空規則 → 行為不變）。

- [ ] **Step 4: Commit**

```bash
git add src/main.ts deno.json
git commit -m "feat: load permission rules in main and grant read/env in build"
```

---

## Task 9: e2e fixture + main_test 升級驗證

**Files:**
- Create: `src/testdata/proj-with-settings/.claude/settings.json`
- Modify: `src/main_test.ts`

- [ ] **Step 1: 建立 e2e fixture（版本控制，免寫檔）**

建立 `src/testdata/proj-with-settings/.claude/settings.json`：

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)"]
  }
}
```

- [ ] **Step 2: 寫失敗測試（e2e 升級）**

於 `src/main_test.ts`：(a) 在 `runHook` 的 `args` 加入 `--allow-read`；(b) 末尾新增兩個 e2e 測試。

把 `runHook` 內的 `args` 由：

```ts
    args: ["run", "--allow-env", "src/main.ts"],
```

改為：

```ts
    args: ["run", "--allow-env", "--allow-read", "src/main.ts"],
```

末尾新增：

```ts
const SETTINGS_FIXTURE = `${Deno.cwd()}/src/testdata/proj-with-settings`;

Deno.test("e2e: command matching settings allow -> allow (upgrade)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm test --silent" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: command not in settings allow -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm run build" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
```

- [ ] **Step 3: 跑測試確認新案例先失敗（未加 --allow-read 時）後通過**

Run: `deno test --allow-run --allow-env --allow-read src/main_test.ts`
Expected: PASS（升級案例回 allow、未命中案例回 ask；既有 4 個 e2e 仍通過）。

> 說明：子行程 env 僅含 `CLAUDE_PROJECT_DIR`，未帶 `HOME`/`USERPROFILE`，故使用者來源被略過，測試只驗證專案 fixture 的 allow，互不污染。

- [ ] **Step 4: 全測試 + check + lint**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠。

- [ ] **Step 5: Commit**

```bash
git add src/testdata/proj-with-settings/.claude/settings.json src/main_test.ts
git commit -m "test(e2e): verify settings allow upgrades ask to allow"
```

---

## Task 10: Operational verification（真實 binary）

**Files:** 無（僅驗證，不改碼）

- [ ] **Step 1: 建置**

Run: `deno task build`
Expected: 產出 `dist/permission-checker(.exe)`，無錯誤。

- [ ] **Step 2: 準備臨時專案 settings 並驗證升級**

在某可寫測試目錄（以下記為 `D:/proj`，請換成實際存在的路徑）建立 `D:/proj/.claude/settings.json`，內容：

```json
{"permissions":{"allow":["Bash(npm test:*)"]}}
```

餵原本會 ask 的指令，期望 **allow、exit 0**：

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npm test --silent"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
```

Expected: 輸出 JSON 的 `hookSpecificOutput.permissionDecision` 為 `allow`，行程 exit code 0。

- [ ] **Step 3: 驗證 deny 否決升級**

把 settings 改為：

```json
{"permissions":{"allow":["Bash(npm test:*)"],"deny":["Bash(npm test:*)"]}}
```

餵同一指令，期望維持 **ask**：

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npm test --silent"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
```

Expected: `permissionDecision` 為 `ask`。

- [ ] **Step 4: 驗證未命中仍 ask**

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf x"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
```

Expected: `permissionDecision` 為 `ask`。

- [ ] **Step 5: 清理臨時 settings（若為臨時建立）**

移除步驟 2 建立的 `D:/proj/.claude/settings.json`（若該檔為驗證而臨時建立）。
