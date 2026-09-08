# Read-only `gh` CLI Auto-Allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking for read-only `gh` CLI research commands by fixing three interdependent false-ask root causes (out-of-project cwd, `?` in an endpoint treated as glob, `grep`/`jq` non-path leading positionals), while tightening several read-only gaps found during spec review.

**Architecture:** Every participating command gets **one** `CommandSpec` that declares each flag once (name, arity, whether the value is a path) plus how its positional operands are classified. A single parser reads that spec, and its result is **memoized per `RuleContext`** so `evaluate` and `cwdIndependent` provably consume the same parse. On top of that, `classify` gains a cwd exemption fenced by five guardrails, and `word.ts` gains a narrowly-scoped relaxed static value used **only** for the `gh api` endpoint and `curl` URL operand.

**Tech Stack:** Deno 2 + TypeScript, `npm:unbash@4.0.1` for Bash AST parsing, `@std/assert` for tests, `deno compile` to a single binary.

**Spec:** `docs/superpowers/specs/2026-09-03-readonly-gh-auto-allow-design.md`

---

## Conventions for every task

**No document references in source code.** Code comments must be self-contained: explain the
behavior, never cite `spec §x.y`. Plan prose may cite the spec freely; shipped comments may not.

**Test helpers already exist — use them, do not invent new ones:**

| Test file | Existing helper |
| --- | --- |
| `src/rules/commands/grep_test.ts` | `ctxOf(name, src)`; assert via `grepRule.evaluate(ctxOf(...)).kind` |
| `src/rules/commands/gh_test.ts` | `ctxOf(src)` + `v(src)` |
| `src/rules/commands/curl_test.ts` | `ctxOf(src)`; the fixture's allowed domain is **`api.example.com`**, not `example.com` |
| `src/rules/commands/coreutils_test.ts` | explicit `<rule>.evaluate(ctxOf(name, src))` calls — no `v` |
| `src/rules/commands/simple-flag_test.ts` | `v(rule, name, src)` |
| `src/engine/classify_test.ts` | `only(src)`, `onlyWith(src, rules)`, `rulesOf({...})` |

When a task below shows a test that needs a helper the file lacks, the task defines it explicitly.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/rules/command_spec.ts` | The single per-command flag/positional description and its one parser (`parseArgv`), memoized per `RuleContext` |
| `src/rules/command_spec_test.ts` | Tests for the parser |
| `src/rules/commands/jq.ts` | `jq` rule: filter is not a path; flag allowlist; path-valued flag values scope-checked |
| `src/rules/commands/jq_test.ts` | Tests for the above |

**Modify:** `src/engine/word.ts`, `src/types.ts`, `src/engine/cwd.ts`, `src/engine/scope.ts`,
`src/engine/classify.ts`, `src/engine/evaluate.ts`, `src/rules/types.ts`, `src/rules/factory.ts`,
`src/rules/commands/{grep,coreutils,simple-flag,positional-output,tail,sed,awk,gh,curl}.ts`,
`src/rules/allowlist.ts`, `src/engine/{cwd,walk,classify}_test.ts`, `CLAUDE.md`.

---

### Task 1: `word.ts` — glob metachar index + relaxed operand value

**Files:**
- Modify: `src/engine/word.ts`
- Test: `src/engine/word_test.ts`

**Backslash decision (resolves the spec's two statements):** `staticValue` already performs bash
quote removal on unquoted words, so unquoted `a\b` yields `"ab"` — it is *static*, and
`nonPathStaticValue` returns it unchanged via the early return. The spec's §7.1 line listing
`a\b → null` describes the *relaxed branch only* (a word that was not already static). Since a word
containing a backslash is never rejected by `staticValue` in the first place, the relaxed branch is
never reached for it. Both statements hold; the tests below assert the actual behavior.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/word_test.ts` (the file already imports `assertEquals`, `parse`, and `Command`):

```ts
import { firstGlobMetacharIndex, nonPathStaticValue } from "./word.ts";

function wordOf(src: string) {
  const cmd = parse(`x ${src}`).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("firstGlobMetacharIndex finds the first unescaped metachar", () => {
  assertEquals(firstGlobMetacharIndex("abc"), -1);
  assertEquals(firstGlobMetacharIndex("ab?c"), 2);
  assertEquals(firstGlobMetacharIndex("a*b?c"), 1);
  assertEquals(firstGlobMetacharIndex("a[bc]"), 1);
  assertEquals(firstGlobMetacharIndex("a\\*b?c"), 4);
  assertEquals(firstGlobMetacharIndex("?abc"), 0);
});

Deno.test("nonPathStaticValue tolerates a single-? query string", () => {
  assertEquals(nonPathStaticValue(wordOf("repos/o/r/tags?per_page=50")), "repos/o/r/tags?per_page=50");
  assertEquals(nonPathStaticValue(wordOf("https://h/p?q=1")), "https://h/p?q=1");
});

Deno.test("nonPathStaticValue passes already-static words straight through", () => {
  assertEquals(nonPathStaticValue(wordOf("plain/endpoint")), "plain/endpoint");
  assertEquals(nonPathStaticValue(wordOf("'a?b/c'")), "a?b/c");
  assertEquals(nonPathStaticValue(wordOf('"a*b"')), "a*b");
  // 未加引號的反斜線由 staticValue 做 quote removal，屬「已靜態」路徑，不進寬鬆分支
  assertEquals(nonPathStaticValue(wordOf("a\\b")), "ab");
});

Deno.test("nonPathStaticValue rejects everything outside the tolerated shape", () => {
  assertEquals(nonPathStaticValue(wordOf("a*b")), null);
  assertEquals(nonPathStaticValue(wordOf("a[bc]")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b?c")), null);
  assertEquals(nonPathStaticValue(wordOf("?abc")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b/c")), null);
  assertEquals(nonPathStaticValue(wordOf("$X")), null);
  assertEquals(nonPathStaticValue(wordOf("$(x)")), null);
  assertEquals(nonPathStaticValue(wordOf("a\\?b?c")), null); // 跳脫的 ? 不算，但仍有第二個 ?…此為 -> 單一 ?：見下
});

Deno.test("nonPathStaticValue handles an escaped metachar plus a real query ?", () => {
  // `a\?b?c`：`\?` 被 quote removal 變成字面 `?`，整個 word 因含反斜線而由 staticValue 處理
  assertEquals(nonPathStaticValue(wordOf("a\\?b?c")), null);
});
```

Remove the last assertion of the fourth test (the one with the trailing comment) — the fifth test
covers that case explicitly. The fourth test's remaining seven assertions stand.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: FAIL — `firstGlobMetacharIndex` / `nonPathStaticValue` are not exported.

- [ ] **Step 3: Implement in `src/engine/word.ts`**

Append at the end of the file:

```ts
/** 回傳第一個未跳脫 glob 元字元（`*` `?` `[`）的索引；無則回 -1。 */
export function firstGlobMetacharIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; } // 跳過被跳脫的字元
    if (c === "*" || c === "?" || c === "[") return i;
  }
  return -1;
}

/**
 * 「單一 `?` 查詢串」形態：三項全部成立才容忍。
 *  1. 未跳脫的 glob 元字元恰好一個，且該字元是 `?`（`*` / `[` 一律不容忍）；
 *  2. 該 `?` 不在索引 0 —— 字面前綴非空，故展開結果不可能以 `-` 開頭、不會變成旗標；
 *  3. 該 `?` 之後的子字串不含 `/` —— 等價於「`?` 位於最後一個 `/` 之後」，
 *     故所有前段路徑（URL 的 scheme://host、endpoint 的前段）皆落在字面前綴內。
 */
function isSingleQueryGlob(value: string): boolean {
  const first = firstGlobMetacharIndex(value);
  if (first <= 0) return false;
  if (value[first] !== "?") return false;
  const rest = value.slice(first + 1);
  if (firstGlobMetacharIndex(rest) !== -1) return false;
  return !rest.includes("/");
}

/**
 * 非路徑操作元（gh api 的 endpoint、curl 的 URL）的靜態取值。
 * 與 staticValue 的唯一差異：未加引號、且符合「單一 `?` 查詢串」形態的 token
 * 不再視為動態。`*` / `[` / 多重元字元 / `?` 後含 `/` 一律回 null。
 *
 * **只可用於「本工具的判定不讀其內容」的操作元**：gh api 的判定只看旗標，
 * curl 的判定只看 scheme 與 host（兩者皆由上述條件保證落在字面前綴內）。
 * 路徑、旗標、旗標值一律不得使用本函式。
 */
export function nonPathStaticValue(word: Word): string | null {
  const strict = staticValue(word);
  if (strict !== null) return strict;
  if (word.parts) {
    const relaxed = word.parts.every((p) => {
      if (DYNAMIC_PART_TYPES.has(p.type)) return false;
      if (p.type === "Literal") return !p.value.includes("\\");
      if (p.type === "DoubleQuoted" || p.type === "LocaleString") {
        return !p.parts.some(nestedPartIsDynamic);
      }
      return true;
    });
    if (!relaxed) return null;
    return isSingleQueryGlob(word.value) ? word.value : null;
  }
  if (word.value.includes("\\")) return null;
  return isSingleQueryGlob(word.value) ? word.value : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: PASS.

- [ ] **Step 5: Type check and lint**

Run: `deno task check && deno task lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/word.ts src/engine/word_test.ts
git commit -m "feat(engine): add firstGlobMetacharIndex + nonPathStaticValue"
```

---

### Task 2: `CwdState.origin` — mark chain-derived cwd (and fix the assertions it breaks)

**Files:**
- Modify: `src/types.ts:6-8`, `src/engine/cwd.ts:13-18`
- Test: `src/engine/cwd_test.ts`, `src/engine/walk_test.ts`

Stamping `origin` changes seven existing whole-object `assertEquals` results. They are updated
here, in the same task, so the suite stays green.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/walk_test.ts`:

```ts
Deno.test("in-chain cd stamps origin chain-cd; session cwd does not", () => {
  const invs = walk(parseCommand("cd /tmp && cat a").script, START, "/proj");
  const cd = invs.find((i) => i.name === "cd")!;
  const cat = invs.find((i) => i.name === "cat")!;
  assertEquals(cd.cwd, { kind: "known", path: "/proj" }); // cd 帶的是變更前的 session cwd
  assertEquals(cat.cwd, { kind: "known", path: "/tmp", origin: "chain-cd" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL — `cat.cwd` has no `origin`.

- [ ] **Step 3: Add the field in `src/types.ts`**

```ts
/** 指令執行時的有效工作目錄狀態。 */
export type CwdState =
  // origin 缺席 = 由 hook 傳入的 session cwd；"chain-cd" = 由本次指令鏈內的
  // cd / git -C 等推導而來。缺席時一律不給 cwd 豁免（fail-safe）。
  | { kind: "known"; path: string; origin?: "chain-cd" } // 已正規化的絕對 posix 路徑
  | { kind: "unknown" }; // 無法靜態確定
```

- [ ] **Step 4: Stamp it in `src/engine/cwd.ts`**

```ts
/** 把單一靜態路徑接到目前 cwd 上；動態 / cwd 未知 → unknown。 */
function applyPath(cwd: CwdState, value: string): CwdState {
  if (isAbsolute(value)) {
    return { kind: "known", path: normalizeAbsolute(value), origin: "chain-cd" };
  }
  if (cwd.kind === "unknown") return UNKNOWN;
  const base = cwd.path.endsWith("/") ? cwd.path : cwd.path + "/";
  return {
    kind: "known",
    path: normalizeAbsolute(base + value.replace(/\\/g, "/")),
    origin: "chain-cd",
  };
}
```

- [ ] **Step 5: Update the seven assertions this breaks**

In `src/engine/cwd_test.ts`, add `origin: "chain-cd"` to these expected objects:

| Line | Change |
| --- | --- |
| 17 | `assertEquals(next, { kind: "known", path: "/proj/src", origin: "chain-cd" });` |
| 22 | `assertEquals(next, { kind: "known", path: "/tmp", origin: "chain-cd" });` |
| 35 | `assertEquals(c, { kind: "known", path: "/proj/sub", origin: "chain-cd" });` |
| 43 | `assertEquals(c, { kind: "known", path: "/proj/sub/wt", origin: "chain-cd" });` |
| 51 | `assertEquals(c, { kind: "known", path: "/outside", origin: "chain-cd" });` |
| 57 | `{ kind: "known", path: "/outside/.git", origin: "chain-cd" },` |

Lines 26, 30, 63 (`{ kind: "unknown" }`) and line 71 (`git status` with no path option returns the
cwd unchanged, so no `origin`) stay as they are.

In `src/engine/walk_test.ts`, line 28:

```ts
  assertEquals(cat.cwd, { kind: "known", path: "/proj/src", origin: "chain-cd" });
```

Line 34 (`{ kind: "known", path: "/proj" }` — cwd unchanged inside a subshell) stays as it is.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/cwd.ts src/engine/cwd_test.ts src/engine/walk_test.ts
git commit -m "feat(engine): mark chain-derived cwd with origin: chain-cd"
```

---

### Task 3: `buildScopeConfig` — one ScopeConfig construction shared by evaluate and classify

**Files:**
- Modify: `src/engine/scope.ts` (append after the `ScopeConfig` interface, ~line 160), `src/engine/classify.ts:56-70`
- Test: `src/engine/scope_test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/engine/scope_test.ts`:

```ts
import { buildScopeConfig } from "./scope.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { EMPTY_READ_SCOPE, parsePathRule, type ReadScope } from "../permissions/path_scope.ts";
import { EMPTY_DOMAIN_SCOPE } from "../permissions/domain_scope.ts";

Deno.test("buildScopeConfig maps allow/deny/ask to distinct fields", () => {
  const scopeOf = (rule: string): ReadScope => {
    const s = { ...EMPTY_READ_SCOPE };
    parsePathRule(rule, s);
    return s;
  };
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: { allow: scopeOf("Read(//a/**)"), deny: scopeOf("Read(//d/**)"), ask: scopeOf("Read(//k/**)") },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
  const scope = buildScopeConfig("/proj", rules, "/home/u", ["/trusted"]);
  assertEquals(scope.root, "/proj");
  assertEquals(scope.home, "/home/u");
  assertEquals(scope.trusted, ["/trusted"]);
  assertEquals(scope.allow, rules.readScope.allow);
  assertEquals(scope.deny, rules.readScope.deny);
  assertEquals(scope.ask, rules.readScope.ask);
});
```

If `parsePathRule`'s signature differs, adapt the three scopes to whatever the existing
`path_scope_test.ts` uses — the point is that all three are **distinct and non-empty**, so a
swapped mapping fails the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL — `buildScopeConfig` is not exported.

- [ ] **Step 3: Implement in `src/engine/scope.ts`**

Append after the `ScopeConfig` interface:

```ts
/**
 * 由 root / rules / home / trusted 建構 ScopeConfig。
 * evaluate（計算 session cwd 是否在範圍內）與 classify（逐葉路徑判定）皆呼叫此函式，
 * 確保兩處使用完全相同的範圍定義，不會分歧。
 */
export function buildScopeConfig(
  root: string,
  rules: PermissionRules,
  home: string | null,
  trustedReadRoots: string[],
): ScopeConfig {
  return {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: trustedReadRoots,
  };
}
```

Add at the top of `src/engine/scope.ts` (type-only — no runtime cycle):

```ts
import type { PermissionRules } from "../permissions/settings.ts";
```

- [ ] **Step 4: Use it in `src/engine/classify.ts`**

Replace the inline `scope` construction with `const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots);`
and add `buildScopeConfig` to the existing `./scope.ts` import list.

- [ ] **Step 5: Run tests, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green (pure refactor).

- [ ] **Step 6: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts src/engine/classify.ts
git commit -m "refactor(engine): extract buildScopeConfig shared by evaluate and classify"
```

---

### Task 4: `command_spec.ts` — one flag table per command, one memoized parse

**Files:**
- Create: `src/rules/command_spec.ts`, `src/rules/command_spec_test.ts`

This is the structural answer to the review's central finding: the old plan described each flag
twice (once in `valueFlags` for operand classification, once in `knownFlags` for the exemption
check), and the two descriptions disagreed — `fold -w 80` treated `80` as a path, `grep --color`
consumed the pattern as a flag value. One table, one parser, one memoized result.

- [ ] **Step 1: Write the failing tests**

Create `src/rules/command_spec_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { type CommandSpec, parseArgv } from "./command_spec.ts";
import type { RuleContext } from "./types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

const FOLD: CommandSpec = {
  flags: [
    { name: "-b", takesValue: false, valueIsPath: false },
    { name: "-s", takesValue: false, valueIsPath: false },
    { name: "-w", takesValue: true, valueIsPath: false },
    { name: "--width", takesValue: true, valueIsPath: false },
  ],
  positionals: "paths",
};

Deno.test("a non-path flag value is not a path operand", () => {
  const r = parseArgv(ctxOf("fold", "fold -w 80"), FOLD);
  assertEquals(r.unknownFlag, null);
  assertEquals(r.pathOperands.length, 0);
  assertEquals(r.pathValues.length, 0);
});

Deno.test("attached and separated forms both consume the value", () => {
  assertEquals(parseArgv(ctxOf("fold", "fold -w80 a.txt"), FOLD).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("fold", "fold --width=80 a.txt"), FOLD).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("fold", "fold --width 80 a.txt"), FOLD).pathOperands.length, 1);
});

Deno.test("an unknown flag is reported, never silently skipped", () => {
  assertEquals(parseArgv(ctxOf("fold", "fold --nope"), FOLD).unknownFlag, "--nope");
  assertEquals(parseArgv(ctxOf("fold", "fold -1unknown"), FOLD).unknownFlag, "-1");
  assertEquals(parseArgv(ctxOf("fold", "fold -bZ"), FOLD).unknownFlag, "-Z"); // 群集內未知字母
});

Deno.test("numericShorthand is opt-in per command and must be the whole token", () => {
  const HEAD: CommandSpec = {
    flags: [{ name: "-n", takesValue: true, valueIsPath: false }],
    positionals: "paths",
    numericShorthand: true,
  };
  assertEquals(parseArgv(ctxOf("head", "head -100"), HEAD).unknownFlag, null);
  assertEquals(parseArgv(ctxOf("head", "head -100x"), HEAD).unknownFlag, "-100x");
  assertEquals(parseArgv(ctxOf("fold", "fold -100"), FOLD).unknownFlag, "-100");
});

Deno.test("positionals: none means no positional is a path", () => {
  const TR: CommandSpec = { flags: [{ name: "-d", takesValue: false, valueIsPath: false }], positionals: "none" };
  assertEquals(parseArgv(ctxOf("tr", "tr a b"), TR).pathOperands.length, 0);
});

Deno.test("positionals: pattern-then-paths drops only the first", () => {
  const GREP: CommandSpec = {
    flags: [{ name: "-E", takesValue: false, valueIsPath: false }],
    positionals: "pattern-then-paths",
  };
  const r = parseArgv(ctxOf("grep", "grep -E pat a.txt b.txt"), GREP);
  assertEquals(r.pathOperands.map((w) => w.value), ["a.txt", "b.txt"]);
});

Deno.test("a path-valued flag records its value", () => {
  const WC: CommandSpec = {
    flags: [{ name: "--files0-from", takesValue: true, valueIsPath: true }],
    positionals: "paths",
  };
  assertEquals(parseArgv(ctxOf("wc", "wc --files0-from=list"), WC).pathValues, ["list"]);
  assertEquals(parseArgv(ctxOf("wc", "wc --files0-from list"), WC).pathValues, ["list"]);
});

Deno.test("any dynamic token makes the whole parse dynamic", () => {
  assertEquals(parseArgv(ctxOf("fold", "fold -w $N"), FOLD).dynamic, true);
  assertEquals(parseArgv(ctxOf("fold", "fold $F"), FOLD).dynamic, true);
});

Deno.test("-- terminates option parsing", () => {
  const r = parseArgv(ctxOf("fold", "fold -- -w"), FOLD);
  assertEquals(r.unknownFlag, null);
  assertEquals(r.pathOperands.map((w) => w.value), ["-w"]);
});

Deno.test("parseArgv memoizes per RuleContext so both consumers share one result", () => {
  const ctx = ctxOf("fold", "fold -w 80 a.txt");
  assertEquals(parseArgv(ctx, FOLD) === parseArgv(ctx, FOLD), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/command_spec_test.ts`
Expected: FAIL — module `./command_spec.ts` not found.

- [ ] **Step 3: Create `src/rules/command_spec.ts`**

```ts
import type { Word } from "../deps.ts";
import type { RuleContext } from "./types.ts";
import { staticValue } from "../engine/word.ts";

/** 單一旗標的完整描述：一個旗標只在此描述一次。 */
export interface FlagSpec {
  /** 旗標 token（`-x` 或 `--long`）。短旗標與長旗標各自列一筆。 */
  name: string;
  /** 是否吃一個值（`--opt value` / `--opt=value` / `-xvalue` 三種寫法皆處理）。 */
  takesValue: boolean;
  /** 該值是否為會被讀取的路徑（需做範圍檢查）。takesValue 為 false 時忽略。 */
  valueIsPath: boolean;
}

/**
 * 位置參數的語義：
 *  - "paths"：全部是會被讀取的檔案路徑（cat / head / wc …）。
 *  - "none"：都不是路徑（tr 的 SET1/SET2、echo 的字串）。
 *  - "pattern-then-paths"：第一個是 pattern（不是路徑），其餘是路徑（grep）。
 */
export type PositionalKind = "paths" | "none" | "pattern-then-paths";

export interface CommandSpec {
  flags: FlagSpec[];
  positionals: PositionalKind;
  /**
   * 是否支援 legacy 數字短旗標（head -100 / tail -200）。
   * 僅在明確開啟時才接受，且整個 token 必須是 `-` 加數字；`-100x` 一律視為未知旗標。
   */
  numericShorthand?: boolean;
  /** 此次呼叫是否遞迴遍歷（由規則提供；用於危險根偵測與 cwd 豁免排除）。 */
  recursive?: (name: string, argv: Word[]) => boolean;
}

export interface ArgvParse {
  /** 需做 resolvePath 的位置參數（已依 positionals 語義扣除非路徑者）。 */
  pathOperands: Word[];
  /** 非路徑的位置參數（pattern、SET1/SET2 等），供規則自行運用。 */
  nonPathOperands: Word[];
  /** 吃路徑值的旗標所帶的值（字串），需做 resolvePathValue。 */
  pathValues: string[];
  /** 第一個未列入 spec 的旗標 token；全部已知時為 null。 */
  unknownFlag: string | null;
  /** argv 中是否有任何非靜態 token。 */
  dynamic: boolean;
  /** 此次呼叫是否遞迴遍歷。 */
  isRecursive: boolean;
}

/**
 * 每個 RuleContext 只解析一次。classify 對單一葉指令只建構一個 RuleContext，
 * 並把同一個物件傳給 evaluate 與 cwdIndependent，故兩者拿到的是**同一份**解析結果，
 * 不是各自重跑一次的兩份結果。
 */
const CACHE = new WeakMap<RuleContext, ArgvParse>();

export function parseArgv(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const result = doParse(ctx, spec);
  CACHE.set(ctx, result);
  return result;
}

function findFlag(spec: CommandSpec, name: string): FlagSpec | undefined {
  return spec.flags.find((f) => f.name === name);
}

function doParse(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const argv = ctx.argv;
  const positional: Word[] = [];
  const pathValues: string[] = [];
  let unknownFlag: string | null = null;
  let dynamic = false;
  let optionsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") {
      positional.push(argv[i]);
      continue;
    }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      const f = findFlag(spec, name);
      if (!f) { unknownFlag ??= name; continue; }
      if (!f.takesValue) { if (inline !== null) unknownFlag ??= name; continue; }
      let value = inline;
      if (value === null) {
        i++;
        if (i >= argv.length) { unknownFlag ??= name; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; continue; }
      }
      if (f.valueIsPath) pathValues.push(value);
      continue;
    }

    // legacy 數字短旗標：整個 token 必須是 `-` 加數字才接受
    if (spec.numericShorthand && /^-[0-9]+$/.test(t)) continue;

    // 短旗標群集：逐字母比對；吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      const f = findFlag(spec, short);
      if (!f) { unknownFlag ??= short; ate = true; break; }
      if (!f.takesValue) continue;
      const rest = t.slice(k + 1);
      let value: string | null = rest;
      if (rest === "") {
        i++;
        if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; ate = true; break; }
      }
      if (f.valueIsPath && value !== null) pathValues.push(value);
      ate = true;
      break;
    }
    if (ate) continue;
  }

  let pathOperands: Word[] = positional;
  let nonPathOperands: Word[] = [];
  if (spec.positionals === "none") {
    nonPathOperands = positional;
    pathOperands = [];
  } else if (spec.positionals === "pattern-then-paths" && positional.length > 0) {
    nonPathOperands = positional.slice(0, 1);
    pathOperands = positional.slice(1);
  }

  return {
    pathOperands,
    nonPathOperands,
    pathValues,
    unknownFlag,
    dynamic,
    isRecursive: spec.recursive?.(ctx.name, argv) ?? false,
  };
}
```

Note the `-1unknown` case: `numericShorthand` requires the *entire* token to match `^-[0-9]+$`, so
`-1unknown` falls through to the cluster scan, where `-1` is not in the table and is reported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/command_spec_test.ts`
Expected: PASS.

- [ ] **Step 5: Type check and lint**

Run: `deno task check && deno task lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/rules/command_spec.ts src/rules/command_spec_test.ts
git commit -m "feat(rules): add CommandSpec + memoized single-parse parseArgv"
```

---

### Task 5: rewire `flagGatedReader` onto `CommandSpec`

**Files:**
- Modify: `src/rules/factory.ts`
- Test: `src/rules/factory_test.ts` (create)

`flagGatedReader` keeps its existing `askFlags` / `recursive` / `askReason` behavior, but its
operand and flag-value classification now comes from `parseArgv`. A rule that supplies a `specs`
table gets the exemption predicate for free; a rule that does not keeps today's behavior exactly.

- [ ] **Step 1: Write the failing test**

Create `src/rules/factory_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { flagGatedReader } from "./factory.ts";
import type { CommandSpec } from "./command_spec.ts";
import type { RuleContext } from "./types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

const SPEC: CommandSpec = {
  flags: [
    { name: "-w", takesValue: true, valueIsPath: false },
    { name: "--from", takesValue: true, valueIsPath: true },
  ],
  positionals: "paths",
};

const rule = flagGatedReader({
  names: ["demo"],
  specs: { demo: SPEC },
  cwdIndependentWhenNoPaths: true,
});

Deno.test("path operands and path-valued flags are scope-checked", () => {
  assertEquals(rule.evaluate(ctxOf("demo", "demo a.txt")).kind, "allow");
  assertEquals(rule.evaluate(ctxOf("demo", "demo ../out.txt")).kind, "ask");
  assertEquals(rule.evaluate(ctxOf("demo", "demo --from ../out.txt")).kind, "ask");
});

Deno.test("a non-path flag value is not treated as a path", () => {
  assertEquals(rule.evaluate(ctxOf("demo", "demo -w 80")).kind, "allow");
  assertEquals(rule.cwdIndependent!(ctxOf("demo", "demo -w 80")), true);
});

Deno.test("unknown flags block the exemption and ask", () => {
  assertEquals(rule.evaluate(ctxOf("demo", "demo --nope")).kind, "ask");
  assertEquals(rule.cwdIndependent!(ctxOf("demo", "demo --nope")), false);
});

Deno.test("any path operand or path-valued flag blocks the exemption", () => {
  assertEquals(rule.cwdIndependent!(ctxOf("demo", "demo a.txt")), false);
  assertEquals(rule.cwdIndependent!(ctxOf("demo", "demo --from a.txt")), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env src/rules/factory_test.ts`
Expected: FAIL — `flagGatedReader` has no `specs` / `cwdIndependentWhenNoPaths` option.

- [ ] **Step 3: Rewrite `src/rules/factory.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "./types.ts";
import { allow, ask, deny, recursiveRootDenyReason } from "./types.ts";
import { type FlagMatcher, hasAnyFlag } from "./flags.ts";
import { type CommandSpec, parseArgv } from "./command_spec.ts";

export interface FlagGatedReaderOptions {
  names: string[];
  /** 每個指令名對應一份旗標 / 位置參數描述。缺該名的 spec → 該指令不參與 cwd 豁免。 */
  specs: Record<string, CommandSpec>;
  /** 命中任一即 ask（寫入 / 副作用 flag），先於 spec 解析。 */
  askFlags?: FlagMatcher[];
  /** ask 時的說明（含指令名）。 */
  askReason?: (name: string) => string;
  /** opt-in：無路徑操作元 / 路徑值、非遞迴、旗標全已知時視為 cwd 無關。 */
  cwdIndependentWhenNoPaths?: boolean;
  /** 上述 opt-in 的例外名單（隱含以 cwd 為操作對象者，如 ls）。 */
  cwdDependentNames?: string[];
}

/**
 * 通用唯讀規則。所有 argv 分類（位置參數是不是路徑、旗標吃不吃值、值是不是路徑、
 * 有沒有未知旗標）都來自 parseArgv 的單一結果；evaluate 與 cwdIndependent 讀的是
 * 同一個快取結果，不會各自重掃而漂移。
 */
export function flagGatedReader(opts: FlagGatedReaderOptions): CommandRule {
  const askFlags = opts.askFlags ?? [];
  return {
    names: opts.names,
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      const spec = opts.specs[ctx.name];
      if (!spec) return ask(`${ctx.name}：未提供旗標描述`);
      const p = parseArgv(ctx, spec);

      // 遞迴根 deny 必須先於任何路徑 ask，否則既有硬 deny 會被降級成 ask。
      // 危險根可能藏在被 value-flag 吃掉的位置，故掃描全部 argv token。
      if (p.isRecursive) {
        for (const w of ctx.argv) {
          if (ctx.isDangerousRoot(w)) {
            return deny(recursiveRootDenyReason(ctx.name, w.value));
          }
        }
      }
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
      return allow();
    },
    cwdIndependent: opts.cwdIndependentWhenNoPaths
      ? (ctx: RuleContext) => {
        if ((opts.cwdDependentNames ?? []).includes(ctx.name)) return false;
        const spec = opts.specs[ctx.name];
        if (!spec) return false;
        const p = parseArgv(ctx, spec); // 與 evaluate 同一快取結果
        return !p.isRecursive && !p.dynamic && p.unknownFlag === null &&
          p.pathOperands.length === 0 && p.pathValues.length === 0;
      }
      : undefined,
  };
}
```

Note the deliberate ordering: the recursive-root `deny` now runs **before** any path `ask`, so
adding path-value checks cannot downgrade an existing hard deny (e.g. `grep -r / --exclude-from=x`
stays `deny`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env src/rules/factory_test.ts`
Expected: PASS.

- [ ] **Step 5: Type check**

Run: `deno task check`
Expected: FAIL — every existing `flagGatedReader` caller still passes the old options. Tasks 6–8
convert them; do not run `deno task test` yet.

- [ ] **Step 6: Commit**

```bash
git add src/rules/factory.ts src/rules/factory_test.ts
git commit -m "refactor(rules): drive flagGatedReader from CommandSpec's single parse"
```

---

### Task 6: convert `grep` — PATTERN is not a path

**Files:**
- Modify: `src/rules/commands/grep.ts`
- Test: `src/rules/commands/grep_test.ts`

- [ ] **Step 1: Write the failing tests and fix the one that changes**

In `src/rules/commands/grep_test.ts`, the existing assertion at the "grep 非遞迴碰根 -> 非 deny"
test asserts `grep / file` → `ask`. With PATTERN excluded from path checks, `/` is the pattern and
`file` is in-project, so the correct new expectation is `allow`. Change that line:

```ts
Deno.test("grep 非遞迴碰根 -> 非 deny", () => {
  // `/` 是 PATTERN 不是路徑，`file` 在專案內 → allow（且確實不是 deny）
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep / file")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x /")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");
});
```

Then append:

```ts
Deno.test("grep PATTERN is not scope-checked", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep /etc/passwd a.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -E 'Retry|backoff'")).kind, "allow");
});

Deno.test("grep files are still scope-checked", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep pat a.txt b.txt")).kind, "allow");
});

Deno.test("with -e / -f every positional is a FILE again", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -e pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --regexp=pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -ie pat ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -f pats.txt ../outside.txt")).kind, "ask");
});

Deno.test("--color does not consume the pattern", () => {
  // --color 是選填值旗標；分開寫時不吃下一 token，故 pat 仍是 PATTERN、secret.txt 仍受檢
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color pat ../secret.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color=auto pat a.txt")).kind, "allow");
});

Deno.test("--exclude-from is scope-checked in both forms", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=ex.txt pat a.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=../out.txt pat")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from ../out.txt pat")).kind, "ask");
});

Deno.test("a recursive root deny still wins over a path-value ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -r x / --exclude-from=../out.txt")).kind, "deny");
});

Deno.test("unknown grep flags ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --totally-unknown pat")).kind, "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/rules/commands/grep.ts`**

```ts
import type { CommandRule } from "../types.ts";
import type { Word } from "../../deps.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, type FlagMatcher, hasAnyFlag } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";

/** 短旗標群集含 r/R（如 -rn、-Rl）：遞迴偵測；漏判退回 ask（安全方向）。 */
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

const isRecursive = (n: string, a: Word[]) =>
  n === "rg" ||
  hasAnyFlag(a, [
    exact("-r", "-R", "--recursive", "--dereference-recursive"),
    shortClusterHasR,
  ]);

/**
 * GNU grep 3.0：`grep [OPTION]... PATTERN [FILE]...`。
 * 給了 -e/--regexp 或 -f/--file 時 pattern 改由旗標提供，第一個位置參數變回 FILE。
 * `--color` / `--colour` 的值是選填的，分開寫時**不吃**下一個 token（GNU 語義），
 * 故列為 takesValue: false；`--color=auto` 的黏寫形式由 `=` 分支自然處理。
 */
const NO_VALUE: string[] = [
  "-E", "--extended-regexp", "-F", "--fixed-strings", "-G", "--basic-regexp",
  "-P", "--perl-regexp", "-i", "--ignore-case", "-y", "-v", "--invert-match",
  "-w", "--word-regexp", "-x", "--line-regexp", "-c", "--count",
  "-l", "--files-with-matches", "-L", "--files-without-match", "-o", "--only-matching",
  "-q", "--quiet", "--silent", "-s", "--no-messages", "-n", "--line-number",
  "-b", "--byte-offset", "-H", "--with-filename", "-h", "--no-filename",
  "-a", "--text", "-I", "-z", "--null-data", "-Z", "--null", "-U", "--binary",
  "--color", "--colour", "-r", "-R", "--recursive", "--dereference-recursive",
  "-h", "--help", "-V", "--version",
];
const NON_PATH_VALUE: string[] = [
  "-m", "--max-count", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-d", "--directories", "--binary-files", "--label",
  "-e", "--regexp", "--include", "--exclude", "--devices",
];
const PATH_VALUE: string[] = ["-f", "--file", "--exclude-from"];

const flags: FlagSpec[] = [
  ...NO_VALUE.map((name) => ({ name, takesValue: false, valueIsPath: false })),
  ...NON_PATH_VALUE.map((name) => ({ name, takesValue: true, valueIsPath: false })),
  ...PATH_VALUE.map((name) => ({ name, takesValue: true, valueIsPath: true })),
];

/**
 * pattern 是否由位置參數提供。回 false（pattern 由 -e / -f 旗標提供）時，
 * 全部位置參數都是 FILE。任一 token 動態時保守回 false（多做一次路徑檢查）。
 */
function patternIsLeadingPositional(argv: Word[]): boolean {
  for (const w of argv) {
    const t = staticValue(w);
    if (t === null) return false;
    if (!t.startsWith("-")) continue;
    if (t === "-e" || t === "--regexp" || t.startsWith("--regexp=")) return false;
    if (t === "-f" || t === "--file" || t.startsWith("--file=")) return false;
    if (t.startsWith("-e") && t.length > 2 && !t.startsWith("--")) return false;
    if (t.startsWith("-f") && t.length > 2 && !t.startsWith("--")) return false;
    if (/^-[A-Za-z]+$/.test(t) && /[ef]/.test(t.slice(1))) return false;
  }
  return true;
}

function specFor(patternPositional: boolean): CommandSpec {
  return {
    flags,
    positionals: patternPositional ? "pattern-then-paths" : "paths",
    recursive: isRecursive,
  };
}

/**
 * grep 的 positionals 語義依「pattern 是否由旗標提供」而變，故 spec 需依 argv 動態選擇。
 * 這仍是單一解析：parseArgv 對同一個 RuleContext 只跑一次並快取結果。
 */
function grepSpecs(argv: Word[]): Record<string, CommandSpec> {
  const spec = specFor(patternIsLeadingPositional(argv));
  return { grep: spec, egrep: spec, fgrep: spec, rg: spec };
}

const base = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  specs: {}, // 由下方 wrapper 依 argv 覆寫
  cwdIndependentWhenNoPaths: true,
});

export const grepRule: CommandRule = {
  names: base.names,
  evaluate: (ctx) =>
    flagGatedReader({
      names: base.names,
      specs: grepSpecs(ctx.argv),
      cwdIndependentWhenNoPaths: true,
    }).evaluate(ctx),
  cwdIndependent: (ctx) =>
    flagGatedReader({
      names: base.names,
      specs: grepSpecs(ctx.argv),
      cwdIndependentWhenNoPaths: true,
    }).cwdIndependent!(ctx),
};
```

> The two `flagGatedReader(...)` constructions build a fresh options object but both call
> `parseArgv(ctx, spec)`, which is memoized on `ctx` — so the actual parse still happens once per
> invocation and both consumers read the identical `ArgvParse`. `rg` is in `specs` so its evaluate
> works, but `isRecursive` is always true for it, which blocks the exemption.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: PASS.

- [ ] **Step 5: Type check**

Run: `deno task check`
Expected: still failing for the not-yet-converted callers (Tasks 7–8). `grep_test.ts` passing is
the gate for this task.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/grep.ts src/rules/commands/grep_test.ts
git commit -m "fix(rules): grep PATTERN is not a path; convert to CommandSpec"
```

---

### Task 7: convert `coreutils` + `simple-flag` + `positional-output` + `tail`

**Files:**
- Modify: `src/rules/commands/coreutils.ts`, `simple-flag.ts`, `positional-output.ts`, `tail.ts`
- Test: `src/rules/commands/coreutils_test.ts`, `simple-flag_test.ts`, `positional-output_test.ts`, `tail_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/coreutils_test.ts` (this file calls rules explicitly — follow that
style; `ctxOf(name, src)` is its existing helper):

```ts
Deno.test("wc --files0-from is scope-checked in both forms", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("wc", "wc --files0-from=list.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc", "wc --files0-from=../out/list.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc", "wc --files0-from ../out/list.txt")).kind, "ask");
});

Deno.test("realpath --relative-to / --relative-base are scope-checked", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath", "realpath --relative-to=sub a.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath", "realpath --relative-to=../out a.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath", "realpath --relative-base=../out a.txt")).kind, "ask");
});

Deno.test("tr operands are character sets, not paths", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("tr", "tr a b")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("tr", "tr -d /etc/passwd")).kind, "allow");
});

Deno.test("non-path flag values are not treated as paths", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("fold", "fold -w 80")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("head", "head -n 10")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("head", "head -100")).kind, "allow");
});

Deno.test("diff -X / -S are scope-checked in both forms", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff", "diff -X ex.txt a.txt b.txt")).kind, "allow");
  assertEquals(diffRule.evaluate(ctxOf("diff", "diff -X ../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff", "diff -X../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff", "diff --starting-file=../out a.txt b.txt")).kind, "ask");
});

Deno.test("unknown coreutils flags ask", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat", "cat --totally-unknown")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("cat", "cat -1unknown")).kind, "ask");
});
```

Append to `src/rules/commands/simple-flag_test.ts` (its helper is `v(rule, name, src)`):

```ts
Deno.test("sort --files0-from is scope-checked", () => {
  assertEquals(v(sortRule, "sort", "sort --files0-from=list.txt"), "allow");
  assertEquals(v(sortRule, "sort", "sort --files0-from=../out/list.txt"), "ask");
});

Deno.test("unknown sort / yq flags ask", () => {
  assertEquals(v(sortRule, "sort", "sort --totally-unknown"), "ask");
  assertEquals(v(yqRule, "yq", "yq --totally-unknown '.'"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts`
Expected: FAIL.

- [ ] **Step 3: Convert `src/rules/commands/coreutils.ts`**

```ts
import type { CommandRule } from "../types.ts";
import { allow } from "../types.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, hasAnyFlag } from "../flags.ts";

/** 建構 spec 的小工具：三類旗標各給一組名稱。 */
function spec(
  noValue: string[],
  nonPathValue: string[],
  opts: Partial<CommandSpec> = {},
): CommandSpec {
  const flags: FlagSpec[] = [
    ...noValue.map((name) => ({ name, takesValue: false, valueIsPath: false })),
    ...nonPathValue.map((name) => ({ name, takesValue: true, valueIsPath: false })),
    ...(opts.flags ?? []),
  ];
  return { flags, positionals: opts.positionals ?? "paths", ...opts, flags };
}

const pathFlag = (name: string): FlagSpec => ({ name, takesValue: true, valueIsPath: true });

const SPECS: Record<string, CommandSpec> = {
  cat: spec(["-A", "--show-all", "-b", "--number-nonblank", "-e", "-E", "--show-ends", "-n", "--number", "-s", "--squeeze-blank", "-t", "-T", "--show-tabs", "-u", "-v", "--show-nonprinting"], []),
  head: spec(["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"], ["-c", "--bytes", "-n", "--lines"], { numericShorthand: true }),
  wc: spec(["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"], [], { flags: [pathFlag("--files0-from")] }),
  // ls 無操作元時列出 cwd，故 cwdDependentNames 排除；-R 觸發遞迴偵測
  ls: spec(["-a", "--all", "-A", "-l", "-h", "--human-readable", "-1", "-R", "--recursive", "-r", "--reverse", "-S", "-t", "-d", "--directory", "-F", "--classify", "-i", "--inode", "-n", "--numeric-uid-gid", "-p"], ["--color", "--time-style", "--sort", "--format"]),
  stat: spec(["-L", "--dereference", "-t", "--terse", "-f", "--file-system"], ["-c", "--format", "--printf"]),
  cut: spec(["-s", "--only-delimited", "--complement", "-z", "--zero-terminated", "-n"], ["-b", "--bytes", "-c", "--characters", "-d", "--delimiter", "-f", "--fields", "--output-delimiter"]),
  // tr 的操作元是 SET1 / SET2，不是檔案；tr 只讀 stdin
  tr: spec(["-c", "-C", "--complement", "-d", "--delete", "-s", "--squeeze-repeats", "-t", "--truncate-set1"], [], { positionals: "none" }),
  column: spec(["-t", "-x", "-e"], ["-c", "-s", "-o"]),
  cmp: spec(["-b", "--print-bytes", "-l", "--verbose", "-s", "--silent", "--quiet"], ["-i", "--ignore-initial", "-n", "--bytes"]),
  comm: spec(["-1", "-2", "-3", "--total", "-z", "--zero-terminated", "--check-order", "--nocheck-order"], ["--output-delimiter"]),
  md5sum: spec(["-b", "--binary", "-t", "--text", "-z", "--zero", "--tag", "-c", "--check"], []),
  sha256sum: spec(["-b", "--binary", "-t", "--text", "-z", "--zero", "--tag", "-c", "--check"], []),
  hexdump: spec(["-b", "-c", "-C", "-d", "-o", "-x", "-v"], ["-e", "-n", "-s"]),
  nl: spec(["-p", "--no-renumber"], ["-b", "--body-numbering", "-d", "--section-delimiter", "-f", "--footer-numbering", "-h", "--header-numbering", "-i", "--line-increment", "-l", "--join-blank-lines", "-n", "--number-format", "-s", "--number-separator", "-v", "--starting-line-number", "-w", "--number-width"]),
  fold: spec(["-b", "--bytes", "-s", "--spaces"], ["-w", "--width"]),
  basename: spec(["-a", "--multiple", "-z", "--zero"], ["-s", "--suffix"]),
  dirname: spec(["-z", "--zero"], []),
  realpath: spec(["-e", "--canonicalize-existing", "-m", "--canonicalize-missing", "-L", "--logical", "-P", "--physical", "-q", "--quiet", "-s", "--strip", "--no-symlinks", "-z", "--zero"], [], { flags: [pathFlag("--relative-to"), pathFlag("--relative-base")] }),
  readlink: spec(["-f", "--canonicalize", "-e", "--canonicalize-existing", "-m", "--canonicalize-missing", "-n", "--no-newline", "-q", "--quiet", "-s", "--silent", "-v", "--verbose", "-z", "--zero"], []),
};

// ls -R 是唯一會遞迴的成員
for (const name of Object.keys(SPECS)) {
  SPECS[name].recursive = (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]);
}

export const fileReaderRule: CommandRule = flagGatedReader({
  names: Object.keys(SPECS),
  specs: SPECS,
  cwdIndependentWhenNoPaths: true,
  cwdDependentNames: ["ls"],
});

const DIFF_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--brief", "-s", "--report-identical-files", "-u", "-c", "-y", "--side-by-side", "-i", "--ignore-case", "-w", "--ignore-all-space", "-b", "--ignore-space-change", "-B", "--ignore-blank-lines", "-a", "--text", "-r", "--recursive", "-N", "--new-file", "-E", "-Z", "-t", "--expand-tabs"]
      .map((name) => ({ name, takesValue: false, valueIsPath: false })),
    ...["-U", "--unified", "-C", "--context", "-W", "--width", "--label", "-D", "--ifdef", "--color", "--tabsize"]
      .map((name) => ({ name, takesValue: true, valueIsPath: false })),
    pathFlag("--from-file"), pathFlag("--to-file"),
    pathFlag("-X"), pathFlag("--exclude-from"),
    pathFlag("-S"), pathFlag("--starting-file"),
  ],
  positionals: "paths",
  // diff -r 會遞迴比對目錄，故納入遞迴偵測（cwd 豁免因此自然排除）
  recursive: (_n, a) => hasAnyFlag(a, [exact("-r", "--recursive")]),
};

export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  specs: { diff: DIFF_SPEC },
  cwdIndependentWhenNoPaths: true,
});

/**
 * 不接受檔案路徑操作元、且無寫入能力的純工具：一律 allow。
 * cwd 無關宣告排除 `which`：它依 PATH 逐段搜尋，而 PATH 合法地可能含 `.` 或空字串段，
 * 兩者都相對於 cwd 解析 —— `cd /outside && which x` 等於探測 /outside/x 是否存在。
 * 執行期 PATH 無法靜態得知，故一律不豁免。
 */
export const pureUtilRule: CommandRule = {
  names: ["echo", "pwd", "whoami", "which"],
  evaluate: () => allow(),
  cwdIndependent: (ctx) => ctx.name !== "which",
};

/** cd 本身不寫檔（cwd 變動由 walk 處理）：一律 allow。 */
export const cdRule: CommandRule = {
  names: ["cd"],
  evaluate: () => allow(),
};
```

> `jq` is absent from `SPECS` — Task 9 gives it its own rule. Removing it here is what makes
> `allowlist.ts`'s duplicate-name check pass once `jqRule` is registered.

- [ ] **Step 4: Convert `src/rules/commands/simple-flag.ts`**

Replace `sortRule` / `yqRule` / `treeRule` / `fileCmdRule` / `dateRule`:

```ts
import type { CommandRule } from "../types.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, prefix } from "../flags.ts";

const noVal = (names: string[]): FlagSpec[] =>
  names.map((name) => ({ name, takesValue: false, valueIsPath: false }));
const val = (names: string[]): FlagSpec[] =>
  names.map((name) => ({ name, takesValue: true, valueIsPath: false }));
const pathVal = (names: string[]): FlagSpec[] =>
  names.map((name) => ({ name, takesValue: true, valueIsPath: true }));

const SORT_SPEC: CommandSpec = {
  flags: [
    ...noVal(["-b", "--ignore-leading-blanks", "-d", "--dictionary-order", "-f", "--ignore-case", "-g", "--general-numeric-sort", "-h", "--human-numeric-sort", "-i", "--ignore-nonprinting", "-M", "--month-sort", "-n", "--numeric-sort", "-r", "--reverse", "-R", "--random-sort", "-u", "--unique", "-V", "--version-sort", "-z", "--zero-terminated", "-c", "--check", "-C", "--check=quiet", "-s", "--stable", "-m", "--merge"]),
    ...val(["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "--parallel", "--compress-program", "--random-source"]),
    ...pathVal(["--files0-from"]),
    // -o / -T 會寫檔或指定暫存目錄，由 askFlags 先攔下；仍列入 spec 以免被當未知旗標
    ...val(["-o", "--output", "-T", "--temporary-directory"]),
  ],
  positionals: "paths",
};

export const sortRule: CommandRule = flagGatedReader({
  names: ["sort"],
  specs: { sort: SORT_SPEC },
  askFlags: [exact("-o", "--output", "-T", "--temporary-directory"), prefix("-o", "--output=", "-T", "--temporary-directory=")],
  askReason: () => "sort：-o / -T 會寫檔或指定暫存目錄",
  cwdIndependentWhenNoPaths: true,
});

const YQ_SPEC: CommandSpec = {
  flags: [
    ...noVal(["-r", "--raw-output", "-n", "--null-input", "-e", "--exit-status", "-N", "--no-colors", "-C", "--colors", "-M", "-P", "--prettyPrint", "-s", "--slurp", "-j", "--tojson", "-i", "--inplace", "--in-place"]),
    ...val(["-o", "--output-format", "-p", "--input-format", "-I", "--indent", "--expression"]),
  ],
  // yq 的第一個位置參數是表達式，不是路徑
  positionals: "pattern-then-paths",
};

export const yqRule: CommandRule = flagGatedReader({
  names: ["yq"],
  specs: { yq: YQ_SPEC },
  askFlags: [exact("-i", "--inplace", "--in-place")],
  askReason: () => "yq：-i / --inplace 會就地修改輸入檔",
  cwdIndependentWhenNoPaths: true,
});

const TREE_SPEC: CommandSpec = {
  flags: [
    ...noVal(["-a", "-d", "-f", "-i", "-l", "-n", "-C", "-p", "-s", "-h", "-u", "-g", "-D", "-r", "-t", "--dirsfirst", "--noreport", "-J", "-x", "-q"]),
    ...val(["-L", "-P", "-I", "--timefmt", "--charset"]),
    ...pathVal(["-o"]),
  ],
  positionals: "paths",
  recursive: () => true,
};

// 刻意不宣告 cwdIndependentWhenNoPaths：tree 無操作元時遞迴 cwd。
export const treeRule: CommandRule = flagGatedReader({
  names: ["tree"],
  specs: { tree: TREE_SPEC },
  askFlags: [exact("-o"), prefix("-o")],
  askReason: () => "tree：-o 會把輸出寫入檔案",
});

const FILE_SPEC: CommandSpec = {
  flags: [
    ...noVal(["-b", "--brief", "-i", "--mime", "-L", "--dereference", "-z", "--uncompress", "-k", "--keep-going", "-h", "--no-dereference", "-s", "--special-files", "-C", "--compile"]),
    ...pathVal(["-m", "--magic-file", "-f", "--files-from"]),
  ],
  positionals: "paths",
};

// 刻意不宣告 cwdIndependentWhenNoPaths：見 spec 的既有缺口說明（-m / -f 的值歷來未檢查）。
// 本次已把它們列為 pathValue，但仍不開放豁免，避免同時改動兩件事。
export const fileCmdRule: CommandRule = flagGatedReader({
  names: ["file"],
  specs: { file: FILE_SPEC },
  askFlags: [exact("-C", "--compile")],
  askReason: () => "file：-C / --compile 會寫出 magic.mgc",
});

const DATE_SPEC: CommandSpec = {
  flags: [
    ...noVal(["-u", "--utc", "--universal", "-R", "--rfc-email", "-s", "--set"]),
    ...val(["-d", "--date", "-I", "--iso-8601", "--rfc-3339"]),
    ...pathVal(["-r", "--reference", "-f", "--file"]),
  ],
  positionals: "none", // date 的位置參數是 +FORMAT，不是路徑
};

// 刻意不宣告 cwdIndependentWhenNoPaths：與 file 同理。
export const dateRule: CommandRule = flagGatedReader({
  names: ["date"],
  specs: { date: DATE_SPEC },
  askFlags: [exact("-s", "--set"), prefix("--set=", "-s")],
  askReason: () => "date：-s / --set 會修改系統時間",
});
```

- [ ] **Step 5: Convert `src/rules/commands/positional-output.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { type CommandSpec, parseArgv } from "../command_spec.ts";

const XXD_SPEC: CommandSpec = {
  flags: [
    ...["-a", "-b", "-C", "-E", "-e", "-i", "-t", "-u", "-r", "-p", "-ps", "-h"]
      .map((name) => ({ name, takesValue: false, valueIsPath: false })),
    ...["-c", "-g", "-l", "-n", "-o", "-s", "-seek"]
      .map((name) => ({ name, takesValue: true, valueIsPath: false })),
  ],
  positionals: "paths",
};

const UNIQ_SPEC: CommandSpec = {
  flags: [
    ...["-c", "--count", "-d", "--repeated", "-D", "--all-repeated", "-i", "--ignore-case", "-u", "--unique", "-z", "--zero-terminated"]
      .map((name) => ({ name, takesValue: false, valueIsPath: false })),
    ...["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars", "--group"]
      .map((name) => ({ name, takesValue: true, valueIsPath: false })),
  ],
  positionals: "paths",
};

/**
 * `cmd [INPUT [OUTPUT]]`：≥2 個位置參數代表有輸出檔 → ask；否則檢查輸入路徑。
 * 分類全部來自 parseArgv 的單一快取結果，evaluate 與 cwdIndependent 共用。
 */
function positionalOutputRule(names: string[], spec: CommandSpec): CommandRule {
  return {
    names,
    evaluate(ctx: RuleContext): RuleVerdict {
      const p = parseArgv(ctx, spec);
      if (p.dynamic) return ask(`${ctx.name}：含動態 token，無法靜態判定`);
      if (p.unknownFlag !== null) {
        return ask(`${ctx.name}：未列入安全集合的旗標 ${p.unknownFlag}`);
      }
      if (p.pathOperands.length >= 2) {
        return ask(`${ctx.name}：第二個位置參數為輸出檔（會寫檔）`);
      }
      if (p.pathOperands.length === 1 && ctx.resolvePath(p.pathOperands[0]) !== "in-project") {
        return ask(`${ctx.name}：輸入路徑超出專案範圍或無法解析（${p.pathOperands[0].value}）`);
      }
      return allow();
    },
    cwdIndependent(ctx: RuleContext): boolean {
      const p = parseArgv(ctx, spec);
      return !p.dynamic && p.unknownFlag === null && p.pathOperands.length === 0 &&
        p.pathValues.length === 0;
    },
  };
}

export const xxdRule = positionalOutputRule(["xxd"], XXD_SPEC);
export const uniqRule = positionalOutputRule(["uniq"], UNIQ_SPEC);
```

- [ ] **Step 6: Convert `src/rules/commands/tail.ts`**

```ts
import type { CommandRule } from "../types.ts";
import type { CommandSpec } from "../command_spec.ts";
import type { FlagMatcher } from "../flags.ts";
import { exact, prefix } from "../flags.ts";
import { flagGatedReader } from "../factory.ts";

/** 短旗標群集含 f / F（如 -fn、-Fq、-fn10），代表 follow 模式。 */
const shortClusterHasF: FlagMatcher = (t) =>
  /^-[A-Za-z0-9]+$/.test(t) && /[fF]/.test(t.slice(1));

const TAIL_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated", "-f", "-F", "--follow", "--retry"]
      .map((name) => ({ name, takesValue: false, valueIsPath: false })),
    ...["-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats"]
      .map((name) => ({ name, takesValue: true, valueIsPath: false })),
  ],
  positionals: "paths",
  numericShorthand: true,
};

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  specs: { tail: TAIL_SPEC },
  askFlags: [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF],
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
  cwdIndependentWhenNoPaths: true,
});
```

- [ ] **Step 7: Run the affected tests**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts src/rules/commands/positional-output_test.ts src/rules/commands/tail_test.ts`
Expected: PASS. If an existing assertion in these files now yields a different (and correct)
verdict — e.g. one that relied on `tr`'s operands being paths — update that assertion and note why
in the commit message.

- [ ] **Step 8: Type check**

Run: `deno task check`
Expected: still failing only for `sed` / `awk` / `gh` / `curl` (Tasks 8–11) if they touch the
changed factory signature; `sed`/`awk` do not use `flagGatedReader`, so the remaining errors should
be confined to imports removed from `flags.ts` usage. Fix any import that this task orphaned.

- [ ] **Step 9: Commit**

```bash
git add src/rules/commands/coreutils.ts src/rules/commands/simple-flag.ts src/rules/commands/positional-output.ts src/rules/commands/tail.ts src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts
git commit -m "refactor(rules): convert reader rules to CommandSpec; scope-check missed path flags"
```

---

### Task 8: `sed` / `awk` — known-flag enforcement + cwd-independence

**Files:**
- Modify: `src/rules/commands/sed.ts`, `src/rules/commands/awk.ts`
- Test: `src/rules/commands/sed_test.ts`, `src/rules/commands/awk_test.ts`

`sed` and `awk` keep their hand-written program scanning (their positional layout is
program-then-files, which `CommandSpec` does not model), but they must still enforce a known-flag
allowlist — otherwise `sed --unknown 'p'` would obtain the exemption.

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/sed_test.ts` (use its existing helper):

```ts
Deno.test("unknown sed flags ask", () => {
  assertEquals(v("sed --totally-unknown 'p'"), "ask");
  assertEquals(v("sed -Z 'p'"), "ask");
});

Deno.test("sed cwdIndependent requires zero input paths and known flags", () => {
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p' a.txt")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed --totally-unknown 'p'")), false);
});
```

Append to `src/rules/commands/awk_test.ts`:

```ts
Deno.test("unknown awk flags ask", () => {
  assertEquals(v("awk --totally-unknown '{print}'"), "ask");
});

Deno.test("awk cwdIndependent requires zero input paths and known flags", () => {
  assertEquals(awkRule.cwdIndependent!(ctxOf("awk '{print $1}'")), true);
  assertEquals(awkRule.cwdIndependent!(ctxOf("awk '{print $1}' a.txt")), false);
  assertEquals(awkRule.cwdIndependent!(ctxOf("awk --totally-unknown '{print}'")), false);
});
```

(If either test file does not export `ctxOf`, add `export` to it — the tests need to build a
context for the predicate.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/sed_test.ts src/rules/commands/awk_test.ts`
Expected: FAIL.

- [ ] **Step 3: Add flag enforcement to `src/rules/commands/sed.ts`**

Add above `sedRule`:

```ts
/** sed 的已知旗標。未列入者一律 ask（新版 sed 新增的旗標因此不會被誤放行）。 */
const SED_NO_VALUE = new Set([
  "-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate",
  "-u", "--unbuffered", "-z", "--null-data", "--posix", "--debug", "--sandbox",
  "--help", "--version",
]);
const SED_ONE_VALUE = new Set(["-e", "--expression", "-l", "-i", "--in-place", "-f", "--file"]);

/** 回傳第一個未知旗標；全部已知回 null。 */
function unknownSedFlag(ctx: RuleContext): string | null {
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) return null; // 動態由既有流程處理
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (SED_NO_VALUE.has(name)) { if (eq !== -1) return name; continue; }
      if (SED_ONE_VALUE.has(name)) { if (eq === -1) i++; continue; }
      return name;
    }
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (SED_NO_VALUE.has(short)) continue;
      if (SED_ONE_VALUE.has(short)) { if (t.slice(k + 1) === "") i++; break; }
      return short;
    }
  }
  return null;
}
```

Insert at the top of `sedRule.evaluate`, before the existing `ASK_FLAGS` check:

```ts
    const unknown = unknownSedFlag(ctx);
    if (unknown !== null) return ask(`sed：未列入安全集合的旗標 ${unknown}`);
```

Add the predicate to the exported object:

```ts
  /** 程式碼已與輸入路徑分離；無輸入路徑、旗標全已知時判定與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    if (unknownSedFlag(ctx) !== null) return false;
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) return false;
    const { text, explicitExpr } = collectProgram(ctx);
    if (text === null) return false;
    if (programHasSideEffect(text)) return false;
    return inputPaths(ctx, explicitExpr).length === 0;
  },
```

- [ ] **Step 4: Add the same to `src/rules/commands/awk.ts`**

```ts
/** awk / gawk / mawk 的已知旗標。未列入者一律 ask。 */
const AWK_NO_VALUE = new Set([
  "--posix", "--traditional", "--re-interval", "--csv", "--help", "--version",
  "-W", "--lint", "--sandbox", "-i", "--in-place",
]);
const AWK_ONE_VALUE = new Set(["-F", "--field-separator", "-v", "--assign", "-f", "--file", "-e", "--source"]);

function unknownAwkFlag(ctx: RuleContext): string | null {
  // 與 sed 版本結構相同，換成 AWK_* 兩張表
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) return null;
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (AWK_NO_VALUE.has(name)) { if (eq !== -1) return name; continue; }
      if (AWK_ONE_VALUE.has(name)) { if (eq === -1) i++; continue; }
      return name;
    }
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (AWK_NO_VALUE.has(short)) continue;
      if (AWK_ONE_VALUE.has(short)) { if (t.slice(k + 1) === "") i++; break; }
      return short;
    }
  }
  return null;
}
```

Insert at the top of `awkRule.evaluate`:

```ts
    const unknown = unknownAwkFlag(ctx);
    if (unknown !== null) return ask(`awk：未列入安全集合的旗標 ${unknown}`);
```

And add:

```ts
  /** 程式碼已與輸入路徑分離；無輸入路徑、旗標全已知時判定與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    if (unknownAwkFlag(ctx) !== null) return false;
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) return false;
    const { text, pos } = collectProgram(ctx);
    if (text === null) return false;
    if (programHasSideEffect(text)) return false;
    return pos.length === 0;
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/sed_test.ts src/rules/commands/awk_test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/sed.ts src/rules/commands/awk.ts src/rules/commands/sed_test.ts src/rules/commands/awk_test.ts
git commit -m "feat(rules): enforce known-flag allowlists for sed and awk; declare cwd-independence"
```

---

### Task 9: extract `jq` into its own rule

**Files:**
- Create: `src/rules/commands/jq.ts`, `src/rules/commands/jq_test.ts`
- Modify: `src/rules/allowlist.ts`

`jq`'s option grammar (two-value flags, `--args` switching the meaning of *subsequent* positionals,
`-fn` meaning `-f -n`) is not expressible in `CommandSpec`, so it gets a hand-written single `scan`
whose result both `evaluate` and `cwdIndependent` read.

**Verified jq 1.8.1 behavior driving three details the first draft got wrong:**
1. Every consumed value must still be static — `jq --arg n $V .` must ask.
2. `--args` affects only positionals **after** it; `jq . a.json --args x` still reads `a.json`.
3. `-fn` is `-f -n`, so the filename is the **next token**, not the cluster remainder.

- [ ] **Step 1: Write the failing tests**

Create `src/rules/commands/jq_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { jqRule } from "./jq.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

export function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "jq",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

const v = (src: string) => jqRule.evaluate(ctxOf(src)).kind;

Deno.test("jq filter is not treated as a path", () => {
  assertEquals(v("jq -r '.[] | select(.type==\"file\") | .name'"), "allow");
  assertEquals(v("jq ."), "allow");
  assertEquals(v("jq '/etc/passwd'"), "allow");
});

Deno.test("jq input files are scope-checked", () => {
  assertEquals(v("jq . data.json"), "allow");
  assertEquals(v("jq . ../outside.json"), "ask");
});

Deno.test("jq path-valued flags are scope-checked", () => {
  assertEquals(v("jq -f prog.jq data.json"), "allow");
  assertEquals(v("jq -f ../outside.jq"), "ask");
  assertEquals(v("jq --from-file=../outside.jq"), "ask");
  assertEquals(v("jq -L ../outside/mods ."), "ask");
  assertEquals(v("jq --rawfile n ../outside.txt ."), "ask");
  assertEquals(v("jq --slurpfile n ../outside.json ."), "ask");
});

Deno.test("-fn means -f -n: the filename is the next token", () => {
  assertEquals(v("jq -fn ../outside.jq"), "ask");
  assertEquals(v("jq -fn prog.jq"), "allow");
});

Deno.test("every consumed value must be static", () => {
  assertEquals(v("jq --arg n $V '.'"), "ask");
  assertEquals(v("jq --indent $N '.'"), "ask");
  assertEquals(v("jq --rawfile $N f.txt '.'"), "ask");
});

Deno.test("--args affects only subsequent positionals", () => {
  assertEquals(v("jq -n '$ARGS.positional' --args ../outside a"), "allow");
  // a.json 出現在 --args 之前 → 仍是輸入檔，仍受範圍檢查
  assertEquals(v("jq . ../outside.json --args x"), "ask");
});

Deno.test("jq unknown flags and dynamic tokens ask", () => {
  assertEquals(v("jq --totally-unknown ."), "ask");
  assertEquals(v("jq $FILTER"), "ask");
});

Deno.test("-- terminates option parsing", () => {
  assertEquals(v("jq -- . data.json"), "allow");
  assertEquals(v("jq -- . ../outside.json"), "ask");
});

Deno.test("jq cwdIndependent requires zero inputs and no path flag", () => {
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name'")), true);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name' a.json")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -f prog.jq")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -n '$ARGS.positional' --args a b")), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/jq_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/rules/commands/jq.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import type { Word } from "../../deps.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * jq 1.8.1：`jq [options] <jq filter> [file...]`。
 * jq 的 filter 語言沒有寫檔或執行外部程式的構造，故只需正確分辨哪些 token 是路徑。
 */
const NO_VALUE_LONG = new Set([
  "--null-input", "--raw-input", "--slurp", "--compact-output", "--raw-output",
  "--raw-output0", "--join-output", "--ascii-output", "--sort-keys", "--color-output",
  "--monochrome-output", "--tab", "--unbuffered", "--stream", "--stream-errors",
  "--seq", "--args", "--jsonargs", "--exit-status", "--binary", "--version",
  "--build-configuration", "--help",
]);
const NO_VALUE_SHORT = new Set(["n", "R", "s", "c", "r", "j", "a", "S", "C", "M", "e", "b", "V", "h"]);
const ONE_NON_PATH = new Set(["--indent"]);
const ONE_PATH = new Set(["-f", "--from-file", "-L", "--library-path"]);
const TWO_NON_PATH = new Set(["--arg", "--argjson"]);
const TWO_SECOND_PATH = new Set(["--slurpfile", "--rawfile"]);

interface JqScan {
  /** 需做範圍檢查的輸入檔（已扣除 filter 與 --args 之後的字串）。 */
  inputs: Word[];
  /** 吃路徑值的旗標帶的值。 */
  pathValues: string[];
  /** 是否用過任何吃路徑的旗標。 */
  pathFlagUsed: boolean;
  /** 第一個未知旗標；全部已知回 null。 */
  unknownFlag: string | null;
  /** 是否含動態 token（含被旗標消費的值）。 */
  dynamic: boolean;
}

const CACHE = new WeakMap<RuleContext, JqScan>();

/** 每個 RuleContext 只掃描一次；evaluate 與 cwdIndependent 讀同一份結果。 */
function scan(ctx: RuleContext): JqScan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doScan(ctx);
  CACHE.set(ctx, r);
  return r;
}

function doScan(ctx: RuleContext): JqScan {
  const argv = ctx.argv;
  const inputs: Word[] = [];
  const pathValues: string[] = [];
  let pathFlagUsed = false;
  let unknownFlag: string | null = null;
  let dynamic = false;
  let filterFromFile = false;
  let argsMode = false;
  let sawFilter = false;
  let optionsDone = false;

  /** 取得旗標的值：inline 優先，否則吃下一 token。 */
  const takeValue = (i: number, inline: string | null): { value: string | null; next: number } => {
    if (inline !== null) return { value: inline, next: i };
    const j = i + 1;
    if (j >= argv.length) return { value: null, next: i };
    return { value: staticValue(argv[j]), next: j };
  };

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") {
      // filter 是第一個位置參數（除非 -f 已提供）；--args 之後的位置參數是字串
      if (!filterFromFile && !sawFilter) { sawFilter = true; continue; }
      if (argsMode) continue;
      inputs.push(argv[i]);
      continue;
    }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (NO_VALUE_LONG.has(name)) {
        if (inline !== null) { unknownFlag ??= name; continue; }
        if (name === "--args" || name === "--jsonargs") argsMode = true;
        continue;
      }
      if (ONE_NON_PATH.has(name)) {
        const r = takeValue(i, inline);
        if (r.value === null) dynamic = true;
        i = r.next;
        continue;
      }
      if (ONE_PATH.has(name)) {
        const r = takeValue(i, inline);
        if (r.value === null) { dynamic = true; i = r.next; continue; }
        pathValues.push(r.value);
        pathFlagUsed = true;
        if (name === "--from-file") filterFromFile = true;
        i = r.next;
        continue;
      }
      if (TWO_NON_PATH.has(name)) {
        const a = takeValue(i, inline);
        if (a.value === null) dynamic = true;
        const b = takeValue(a.next, null);
        if (b.value === null) dynamic = true;
        i = b.next;
        continue;
      }
      if (TWO_SECOND_PATH.has(name)) {
        const a = takeValue(i, inline); // name（非路徑）
        if (a.value === null) dynamic = true;
        const b = takeValue(a.next, null); // file（路徑）
        if (b.value === null) dynamic = true;
        else { pathValues.push(b.value); pathFlagUsed = true; }
        i = b.next;
        continue;
      }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：jq 的 -f 不吃同 token 剩餘字元（`-fn` 等於 `-f -n`），
    // 故吃值的短旗標一律從下一個 token 取值。
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (NO_VALUE_SHORT.has(c)) continue;
      const short = `-${c}`;
      if (ONE_PATH.has(short)) {
        const r = takeValue(i, null);
        if (r.value === null) dynamic = true;
        else { pathValues.push(r.value); pathFlagUsed = true; if (c === "f") filterFromFile = true; }
        i = r.next;
        continue;
      }
      unknownFlag ??= short;
      break;
    }
  }

  return { inputs, pathValues, pathFlagUsed, unknownFlag, dynamic };
}

export const jqRule: CommandRule = {
  names: ["jq"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const r = scan(ctx);
    if (r.dynamic) return ask("jq：含動態 token，無法靜態判定");
    if (r.unknownFlag !== null) return ask(`jq：未列入安全集合的旗標 ${r.unknownFlag}`);
    for (const v of r.pathValues) {
      if (ctx.resolvePathValue(v) !== "in-project") {
        return ask(`jq：旗標的路徑值超出專案範圍或無法解析（${v}）`);
      }
    }
    for (const p of r.inputs) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`jq：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
  /** filter 不是路徑；無輸入檔且未用到吃路徑的旗標時，判定與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scan(ctx);
    return !r.dynamic && r.unknownFlag === null && r.inputs.length === 0 && !r.pathFlagUsed;
  },
};
```

- [ ] **Step 4: Register in `src/rules/allowlist.ts`**

Add `import { jqRule } from "./commands/jq.ts";` and put `jqRule,` in the `RULES` array after
`grepRule,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/jq_test.ts src/rules/allowlist_test.ts`
Expected: PASS. `allowlist.ts` throws on duplicate names, so a clean load also proves Task 7
removed `jq` from `fileReaderRule`.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/jq.ts src/rules/commands/jq_test.ts src/rules/allowlist.ts
git commit -m "feat(rules): extract jq into its own rule; filter is not a path"
```

---

### Task 10: `gh` — flag-aware parse, flag allowlist, local side effects, endpoint operand

**Files:**
- Modify: `src/rules/commands/gh.ts`
- Test: `src/rules/commands/gh_test.ts`

One `parseGh` produces the subcommand, the **flag-aware** operand positions, the unknown flag, and
the single rescued operand index. `evaluate`, the mutation check, the placeholder check, and both
predicates all read that one result — no separate `find((t) => !t.startsWith("-"))` scans that
mistake a flag value for the endpoint.

**Placeholder behavior (corrected):** an endpoint containing `{owner}` / `{repo}` / `{branch}`
only withholds the **cwd exemption**. An ordinary in-project `gh api 'repos/{owner}/...'` keeps its
existing `allow`.

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/gh_test.ts`:

```ts
Deno.test("gh local side-effect flags ask", () => {
  assertEquals(v("gh search code x --web"), "ask");
  assertEquals(v("gh repo view -w"), "ask");
  assertEquals(v("gh pr diff --web"), "ask");
  assertEquals(v("gh api repos/o/r/tags --cache 1h"), "ask");
  assertEquals(v("gh api repos/o/r/tags --cache=1h"), "ask");
});

Deno.test("gh unknown flags ask", () => {
  assertEquals(v("gh api repos/o/r --totally-unknown"), "ask");
  assertEquals(v("gh search code x --good-first-issues"), "ask");
});

Deno.test("gh known safe flags still allow", () => {
  assertEquals(v("gh api repos/o/r -H 'Accept: application/vnd.github.raw'"), "allow");
  assertEquals(v("gh api repos/o/r --paginate --jq '.[].name'"), "allow");
  assertEquals(v("gh api repos/o/r -X GET"), "allow");
  assertEquals(v("gh search code x --language go --limit 10"), "allow");
  assertEquals(v("gh issue list --repo o/r --state open"), "allow");
});

Deno.test("clustered non-GET methods still ask", () => {
  assertEquals(v("gh api repos/o/r -X POST"), "ask");
  assertEquals(v("gh api repos/o/r -XPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iXPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iX DELETE"), "ask");
  assertEquals(v("gh api repos/o/r -f a=b"), "ask");
  assertEquals(v("gh api repos/o/r --input body.json"), "ask");
});

Deno.test("gh api tolerates a single-? query string in the endpoint", () => {
  assertEquals(v("gh api repos/o/r/tags?per_page=50"), "allow");
  assertEquals(v("gh api repos/o/r/contents/pkg/x.go?ref=v1.18.0"), "allow");
  assertEquals(v("gh api -X GET repos/o/r/tags?per_page=50"), "allow"); // 旗標值不被誤認為 endpoint
});

Deno.test("gh api rejects other glob shapes in the endpoint", () => {
  assertEquals(v("gh api repos/o/*/x"), "ask");
  assertEquals(v("gh api rep?s/o/r/x"), "ask");
  assertEquals(v("gh api ?x"), "ask");
  assertEquals(v("gh api a?b c?d"), "ask");
});

Deno.test("the tolerance never applies to a flag value", () => {
  assertEquals(v("gh api x -H Accept:a?b"), "ask");
  assertEquals(v("gh api -H Accept:a/b?c repos/o/r"), "ask");
  assertEquals(v("gh issue list --repo o/r?x"), "ask");
});

Deno.test("placeholder endpoints keep their ordinary in-project verdict", () => {
  // 佔位符只取消 cwd 豁免，不改變一般判定
  assertEquals(v("gh api 'repos/{owner}/{repo}/issues'"), "allow");
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api 'repos/{owner}/{repo}/issues'")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api -X GET 'repos/{owner}/{repo}/issues'")), false);
});

Deno.test("only api and search are cwd-independent", () => {
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api repos/o/r/tags?per_page=50")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh search code x")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh pr diff")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh repo view")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh issue list --repo o/r")), false);
});
```

`gh_test.ts` already has `ctxOf(src)` and `v(src)`; add `export` to `ctxOf` if it is not exported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/rules/commands/gh.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { firstGlobMetacharIndex, nonPathStaticValue, staticValue } from "../../engine/word.ts";

/** 各 gh 指令的唯讀子指令。`gh repo clone` / `gh release download` 會寫本地檔 → 不在此列。 */
const READ_SUBS: Record<string, Set<string>> = {
  repo: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  release: new Set(["view", "list"]),
};

/** 開啟本機瀏覽器 / 寫入本機快取：對所有子指令一律 ask。 */
const LOCAL_SIDE_EFFECT_LONG = new Set(["--web", "--cache"]);
const LOCAL_SIDE_EFFECT_SHORT = new Set(["w"]);

/** 送出 request body 或非 GET 方法 → 寫入請求。 */
const MUTATING_LONG = new Set(["--method", "--field", "--raw-field", "--input"]);
const MUTATING_SHORT = new Set(["X", "f", "F"]);

/** 全部子指令共用的安全旗標。 */
const COMMON_NO_VALUE = ["-h", "--help"];
const COMMON_ONE_VALUE = ["--json", "-q", "--jq", "-t", "--template"];

const API_NO_VALUE = ["--paginate", "--silent", "--slurp", "-i", "--include", "--verbose"];
const API_ONE_VALUE = ["-H", "--header", "--hostname", "-p", "--preview", "-X", "--method", "--cache", "--input", "-f", "--raw-field", "-F", "--field"];

const SEARCH_NO_VALUE = ["--archived", "-w", "--web"];
const SEARCH_ONE_VALUE = [
  "-L", "--limit", "-R", "--repo", "--owner", "--language", "--match", "--sort",
  "--order", "--state", "--filename", "--extension", "--size", "--label",
  "--author", "--assignee", "--created", "--updated", "--visibility", "--include-forks",
];

const READ_NO_VALUE = ["--patch", "--name-only", "-w", "--web"];
const READ_ONE_VALUE = [
  "-R", "--repo", "-L", "--limit", "-s", "--state", "--label", "--author",
  "--assignee", "--search", "--color", "-e", "--exclude",
];

interface GhTables { noValue: Set<string>; oneValue: Set<string> }

function tablesFor(command: string): GhTables {
  if (command === "api") {
    return { noValue: new Set([...COMMON_NO_VALUE, ...API_NO_VALUE]), oneValue: new Set([...COMMON_ONE_VALUE, ...API_ONE_VALUE]) };
  }
  if (command === "search") {
    return { noValue: new Set([...COMMON_NO_VALUE, ...SEARCH_NO_VALUE]), oneValue: new Set([...COMMON_ONE_VALUE, ...SEARCH_ONE_VALUE]) };
  }
  return { noValue: new Set([...COMMON_NO_VALUE, ...READ_NO_VALUE]), oneValue: new Set([...COMMON_ONE_VALUE, ...READ_ONE_VALUE]) };
}

interface GhParse {
  /** 解析階段就能決定的否決理由；非 null 時其餘欄位不可信。 */
  reject: string | null;
  command: string;
  /** 子指令之後的位置操作元（已排除所有旗標與旗標值）。 */
  operands: string[];
  /** 被寬鬆取值救回的操作元索引（在 argv 中的位置）；無則 -1。 */
  relaxedIdx: number;
  /** 命中本機副作用旗標。 */
  localSideEffect: boolean;
  /** 命中寫入旗標（非 GET 方法或帶 body）。 */
  mutating: boolean;
  /** 第一個未知旗標；全部已知回 null。 */
  unknownFlag: string | null;
}

const CACHE = new WeakMap<RuleContext, GhParse>();

/** 每個 RuleContext 只解析一次；evaluate 與兩個述詞讀同一份結果。 */
function parseGh(ctx: RuleContext): GhParse {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doParseGh(ctx);
  CACHE.set(ctx, r);
  return r;
}

const REJECT = (reason: string): GhParse => ({
  reject: reason, command: "", operands: [], relaxedIdx: -1,
  localSideEffect: false, mutating: false, unknownFlag: null,
});

function doParseGh(ctx: RuleContext): GhParse {
  const argv = ctx.argv;
  const toks: (string | null)[] = argv.map((w) => staticValue(w));
  const nullIdxs = toks.map((t, i) => (t === null ? i : -1)).filter((i) => i >= 0);
  if (nullIdxs.length > 1) return REJECT("gh：含一個以上動態 token，無法靜態判定");

  const cmdIdx = toks.findIndex((t) => t !== null && !t.startsWith("-"));
  if (cmdIdx === -1) return REJECT("gh：未指定指令或指令為動態");
  const command = toks[cmdIdx]!;
  const tables = tablesFor(command);

  // 第一遍：flag-aware 掃描，確定每個 token 的角色
  const operandIdxs: number[] = [];
  let localSideEffect = false;
  let mutating = false;
  let unknownFlag: string | null = null;
  let optionsDone = false;

  for (let i = cmdIdx + 1; i < argv.length; i++) {
    const t = toks[i];
    if (t === null) { operandIdxs.push(i); continue; } // 唯一的 null：只可能是操作元
    if (optionsDone || !t.startsWith("-") || t === "-") { operandIdxs.push(i); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (LOCAL_SIDE_EFFECT_LONG.has(name)) localSideEffect = true;
      if (MUTATING_LONG.has(name)) {
        const val = inline ?? (i + 1 < argv.length ? toks[i + 1] : null);
        if (name === "--method") { if ((val ?? "").toUpperCase() !== "GET") mutating = true; }
        else mutating = true;
      }
      if (tables.noValue.has(name)) { if (inline !== null) unknownFlag ??= name; continue; }
      if (tables.oneValue.has(name)) { if (inline === null) i++; continue; }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：逐字母；吃值字母吃掉剩餘字元，剩餘為空則吃下一 token
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      const short = `-${c}`;
      if (LOCAL_SIDE_EFFECT_SHORT.has(c)) localSideEffect = true;
      if (MUTATING_SHORT.has(c)) {
        if (c === "X") {
          const rest = t.slice(k + 1);
          const val = rest !== "" ? rest : (i + 1 < argv.length ? toks[i + 1] : null);
          if ((val ?? "").toUpperCase() !== "GET") mutating = true;
        } else mutating = true;
      }
      if (tables.noValue.has(short)) continue;
      if (tables.oneValue.has(short)) { if (t.slice(k + 1) === "") i++; ate = true; break; }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 第二遍：若有唯一的 null token，它必須就是第一個位置操作元，且只有 gh api 可救
  let relaxedIdx = -1;
  const operands: string[] = [];
  for (const idx of operandIdxs) {
    const t = toks[idx];
    if (t !== null) { operands.push(t); continue; }
    if (command !== "api" || idx !== operandIdxs[0]) {
      return REJECT("gh：動態 token 不在 endpoint 位置");
    }
    const relaxed = nonPathStaticValue(argv[idx]);
    if (relaxed === null || relaxed.startsWith("-")) {
      return REJECT("gh：含動態 token，無法靜態判定");
    }
    // endpoint 的萬用字元必須落在第一個 `/` 之後，確保第一段（repos/orgs/…）為字面
    const g = firstGlobMetacharIndex(relaxed);
    const slash = relaxed.indexOf("/");
    if (g !== -1 && (slash === -1 || g <= slash)) {
      return REJECT(`gh api：endpoint 的萬用字元位置不安全（${relaxed}）`);
    }
    relaxedIdx = idx;
    operands.push(relaxed);
  }
  if (nullIdxs.length === 1 && relaxedIdx === -1) {
    return REJECT("gh：含動態 token，無法靜態判定");
  }

  return { reject: null, command, operands, relaxedIdx, localSideEffect, mutating, unknownFlag };
}

/** endpoint 含由 cwd 的 git repo 填值的佔位符。 */
function hasCwdPlaceholder(endpoint: string): boolean {
  return endpoint.includes("{owner}") || endpoint.includes("{repo}") ||
    endpoint.includes("{branch}");
}

export const ghRule: CommandRule = {
  names: ["gh"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const p = parseGh(ctx);
    if (p.reject !== null) return ask(p.reject);
    if (p.localSideEffect) {
      return ask("gh：-w/--web 會開啟本機瀏覽器、--cache 會寫入本機快取");
    }
    if (p.unknownFlag !== null) {
      return ask(`gh ${p.command}：未列入安全集合的旗標 ${p.unknownFlag}`);
    }
    if (p.command === "search") return allow();
    if (p.command === "api") {
      return p.mutating ? ask("gh api：非 GET（寫入）請求") : allow();
    }
    const readSubs = READ_SUBS[p.command];
    if (!readSubs) return ask(`gh ${p.command}：未列入唯讀 allowlist`);
    const sub = p.operands[0];
    if (sub === undefined) return ask(`gh ${p.command}：未指定子指令`);
    return readSubs.has(sub) ? allow() : ask(`gh ${p.command} ${sub}：非唯讀操作`);
  },

  /**
   * 只有 api 與 search 的目標由 endpoint / query 決定，不看 cwd。
   * repo view / issue list / pr diff… 未給 --repo 時會以 cwd 所在的 git repository
   * 推斷目標倉庫；api 的 endpoint 含 {owner}/{repo}/{branch} 時同樣由 cwd 的 repo 填值。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const p = parseGh(ctx);
    if (p.reject !== null || p.localSideEffect || p.unknownFlag !== null) return false;
    if (p.command !== "api" && p.command !== "search") return false;
    if (p.command === "api") {
      if (p.mutating) return false;
      const endpoint = p.operands[0];
      if (endpoint !== undefined && hasCwdPlaceholder(endpoint)) return false;
    }
    return true;
  },

  /** 唯一容忍的非靜態 token 是 api 的 endpoint 操作元。 */
  toleratesNonStaticOperand(ctx: RuleContext): boolean {
    const p = parseGh(ctx);
    return p.reject === null && p.command === "api" && p.relaxedIdx >= 0;
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: PASS.

- [ ] **Step 5: Type check and lint**

Run: `deno task check && deno task lint`
Expected: no errors (note there is no `Word` import — `gh.ts` does not need it).

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/gh.ts src/rules/commands/gh_test.ts
git commit -m "feat(rules): flag-aware gh parse, flag allowlist, local side-effect asks"
```

---

### Task 11: `curl` — URL operand tolerance + authority guard

**Files:**
- Modify: `src/rules/commands/curl.ts`
- Test: `src/rules/commands/curl_test.ts`

**The allowed domain in `curl_test.ts`'s fixture is `api.example.com`** — use it, not
`example.com`. If the file has no single-line helper, add one next to its existing `ctxOf`:

```ts
const v = (src: string) => curlRule.evaluate(ctxOf(src)).kind;
```

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("curl tolerates an unquoted single-? query string in the URL path", () => {
  assertEquals(v("curl -s https://api.example.com/p?q=1"), "allow");
});

Deno.test("curl asks for a URL with no path segment", () => {
  // `https://host?q=1` 展開時 `?` 是 host 的一個字元 -> https://hostXq=1，主機會變
  assertEquals(v("curl -s https://api.example.com?q=1"), "ask");
  assertEquals(v("curl -s https://ex?mple.com/p"), "ask");
  assertEquals(v("curl -s http?://api.example.com/p"), "ask");
});

Deno.test("curl never tolerates metachars in flags or flag values", () => {
  assertEquals(v("curl -H Accept:a?b https://api.example.com/p"), "ask");
  assertEquals(v("curl --max-time 1?0 https://api.example.com/p"), "ask");
});

Deno.test("curl still rejects * and [ in the URL", () => {
  assertEquals(v("curl -s https://api.example.com/a*b"), "ask");
  assertEquals(v("curl -s 'https://api.example.com/a[1-3]b'"), "ask");
});

Deno.test("curl verdict is identical for every single-character expansion", () => {
  const base = v("curl -s https://api.example.com/p?q=1");
  assertEquals(base, "allow");
  for (const ch of ["X", "-", ".", "1", "_"]) {
    assertEquals(v(`curl -s https://api.example.com/p${ch}q=1`), base, ch);
  }
});

Deno.test("curl verdict is unchanged when an expansion yields multiple URLs", () => {
  assertEquals(
    v("curl -s https://api.example.com/pXq=1 https://api.example.com/pYq=1"),
    "allow",
  );
});

Deno.test("curl cwdIndependent tracks the evaluate verdict", () => {
  assertEquals(curlRule.cwdIndependent!(ctxOf("curl -s https://api.example.com/p?q=1")), true);
  assertEquals(curlRule.cwdIndependent!(ctxOf("curl -s https://not-allowed.test/p")), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/rules/commands/curl.ts`**

Add to the imports:

```ts
import { firstGlobMetacharIndex, nonPathStaticValue, staticValue } from "../../engine/word.ts";
```

Add after the flag sets:

```ts
/**
 * URL 的 glob 元字元必須落在「終結 authority 的那個 `/`」之後。
 * 只有真正的 `/` 能終結 authority：`https://host?q=1` 的 `?` 展開時會被當成 host
 * 尾端的一個字元（變成 https://hostXq=1），主機因此會改變，故無路徑段的 URL 一律不容忍。
 * 這保證 scheme 與 host 完全落在字面前綴內，展開結果不可能換到別的主機。
 */
function metacharAfterAuthority(url: string): boolean {
  const g = firstGlobMetacharIndex(url);
  if (g === -1) return true;
  const schemeEnd = url.indexOf("://");
  const from = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const slash = url.indexOf("/", from);
  if (slash === -1) return false; // 無路徑段
  return g > slash;
}
```

In `evaluate`, compute the single rescuable index up front and use `staticValue` everywhere else:

```ts
    const argv = ctx.argv;
    const urls: string[] = [];
    const nullIdxs = argv.map((w, i) => (staticValue(w) === null ? i : -1)).filter((i) => i >= 0);
    if (nullIdxs.length > 1) return ask("curl：含一個以上動態參數，無法判定");
    const relaxIdx = nullIdxs.length === 1 ? nullIdxs[0] : -1;

    for (let i = 0; i < argv.length; i++) {
      let t = staticValue(argv[i]);
      if (t === null) {
        // 只有位置參數（URL 候選）可救；旗標與旗標值永不套用寬鬆取值。
        // 走到這裡代表 i 尚未被任何旗標分支消費，故它就是位置參數。
        const relaxed = i === relaxIdx ? nonPathStaticValue(argv[i]) : null;
        if (relaxed === null || relaxed.startsWith("-")) {
          return ask("curl：動態參數無法判定");
        }
        t = relaxed;
      }
```

Leave every *flag value* read as `staticValue(argv[i])` with its existing `null → ask` — a dynamic
flag value must never be rescued. Then before the domain check:

```ts
    if (urls.length === 0) return ask("curl：未發現 URL");
    for (const u of urls) {
      if (!metacharAfterAuthority(u)) {
        return ask(`curl：URL 的萬用字元位置不安全（${u}）`);
      }
      if (ctx.resolveUrl(u) !== "allowed") {
        return ask(`curl：URL 不在允許網域或形式不安全（${u}）`);
      }
    }
    return allow();
```

Add the two predicates to the exported object:

```ts
  /** allow 形式只走網路；-H @file 已由 resolvePathValue 以真實 cwd 檢查。 */
  cwdIndependent(ctx: RuleContext): boolean {
    return curlRule.evaluate(ctx).kind === "allow";
  },
  /** 唯一容忍的非靜態 token 是 URL 操作元；旗標與旗標值永不容忍。 */
  toleratesNonStaticOperand(ctx: RuleContext): boolean {
    return curlRule.evaluate(ctx).kind === "allow";
  },
```

`curlRule.evaluate` is a pure function of `ctx`, so re-entering it yields the identical verdict;
`classify` only consults the predicates when `evaluate` already returned `allow`, so neither
predicate can widen the exemption.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green — this is the first point where every rule has been converted.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/curl.ts src/rules/commands/curl_test.ts
git commit -m "feat(rules): tolerate single-? query strings in the curl URL operand"
```

---

### Task 12: wire the cwd exemption into `classify` / `evaluate`

**Files:**
- Modify: `src/rules/types.ts`, `src/engine/classify.ts`, `src/engine/evaluate.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts` (its existing helpers are `only`, `onlyWith`, `rulesOf`):

```ts
import { walk } from "./walk.ts";

/** 整條指令鏈的最終決策（session cwd 預設為專案內）。 */
function decide(src: string, start: CwdState = START) {
  return evaluate(src, ROOT, start);
}

/** 單一葉指令的判定，可指定 sessionCwdInScope，用於直接檢驗護欄 2。 */
function leaf(src: string, name: string, sessionInScope: boolean, start: CwdState = START) {
  const invs = walk(parseCommand(src).script, start, ROOT);
  const inv = invs.find((i) => i.name === name)!;
  return classify(inv, ROOT, undefined, null, [], sessionInScope);
}

Deno.test("chain cd out of project no longer asks for cwd-independent commands", () => {
  assertEquals(decide("cd /tmp && echo hi").verdict, "allow");
  assertEquals(decide("cd /tmp && pwd").verdict, "allow");
  assertEquals(decide("cd /tmp && whoami").verdict, "allow");
});

Deno.test("guardrail 2 blocks the leaf itself, not just the chain", () => {
  // 直接檢驗葉指令：sessionCwdInScope=false 時即使 origin 是 chain-cd 也不豁免
  assertEquals(leaf("cd . && echo hi", "echo", false, { kind: "known", path: "/outside" }).kind, "ask");
  assertEquals(leaf("cd /tmp && echo hi", "echo", false, { kind: "known", path: "/outside" }).kind, "ask");
  // 起點可信時同一個葉指令才豁免
  assertEquals(leaf("cd /tmp && echo hi", "echo", true).kind, "allow");
});

Deno.test("guardrail 1: a settings.allow upgrade never grants the exemption", () => {
  // ls 的規則自身判 ask（無操作元時作用於 cwd）；即使 permissions.allow 命中也不得豁免
  const rules = rulesOf({ allow: ["Bash(ls *)"] });
  const invs = walk(parseCommand("cd /tmp && ls").script, ROOT === "" ? "/" : ROOT);
  assertEquals(onlyWith("cd /tmp && ls", rules).kind, "ask");
});

Deno.test("guardrail 3: path operands are still resolved against the real cwd", () => {
  assertEquals(decide("cd /tmp && cat a.txt").verdict, "ask");
});

Deno.test("guardrail 4: a non-static token blocks the exemption", () => {
  assertEquals(decide("cd /tmp && echo *").verdict, "ask");
  assertEquals(decide("cd /tmp && grep *").verdict, "ask");
  assertEquals(decide("cd /tmp && head -100 *.log").verdict, "ask");
});

Deno.test("guardrail: which is never cwd-independent (PATH may contain .)", () => {
  assertEquals(decide("cd /tmp && which some-name").verdict, "ask");
});

Deno.test("the other central preflight rules still fire under the exemption", () => {
  assertEquals(decide("cd /tmp && echo hi > out.txt").verdict, "ask"); // 寫入重導向
  assertEquals(decide("cd /tmp && FOO=1 echo hi").verdict, "ask"); // 賦值前綴
  assertEquals(decide("cd /tmp && echo hi < ../outside.txt").verdict, "ask"); // 範圍外 <
});

Deno.test("commands that implicitly act on cwd still ask", () => {
  assertEquals(decide("cd /tmp && ls").verdict, "ask");
  assertEquals(decide("cd /tmp && tree").verdict, "ask");
  assertEquals(decide("cd /tmp && file x").verdict, "ask");
  assertEquals(decide("cd /tmp && date -r x").verdict, "ask");
  assertEquals(decide("cd /tmp && rg pat").verdict, "ask");
  assertEquals(decide("cd /tmp && git status").verdict, "ask");
  assertEquals(decide("cd /tmp && deno test").verdict, "ask");
});

Deno.test("find keeps its hard deny under the exemption path", () => {
  assertEquals(decide("cd /tmp && find . -name x").verdict, "deny");
  assertEquals(decide("cd /tmp && find -name x").verdict, "ask");
});
```

Delete the unused `invs` line from the guardrail-1 test — `onlyWith` already builds what it needs.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL.

- [ ] **Step 3: Declare the predicates in `src/rules/types.ts`**

```ts
export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
  /**
   * 此次呼叫的安全判定是否與 cwd 無關，需同時滿足：
   *  (a) 不以 cwd 相對路徑讀取檔案；
   *  (b) 不隱含以 cwd 為操作對象（如 ls / find 無操作元時作用於 cwd）；
   *  (c) 安全判定所依據的資訊不取決於 shell 對 cwd 的 glob 展開結果。
   * (c) 是「判定不依賴展開結果」，不是「不含 glob 元字元」。
   * 未宣告 = 否（default-deny）。必須為純函式、不得有副作用。
   */
  cwdIndependent?(ctx: RuleContext): boolean;
  /**
   * 此次呼叫是否僅含「本工具的判定不讀其內容」的 endpoint / URL 操作元這一種非靜態 token
   * （其餘 token 皆靜態）。只有 gh / curl 宣告；必須為純函式。
   */
  toleratesNonStaticOperand?(ctx: RuleContext): boolean;
}
```

- [ ] **Step 4: Wire it in `src/engine/classify.ts`**

Change `centralPreflightAsk` to take `skipCwdCheck` and guard only rule 1:

```ts
function centralPreflightAsk(
  inv: CommandInvocation,
  scope: ScopeConfig,
  skipCwdCheck: boolean,
): RuleVerdict | null {
  // 一：cwd 範圍。skipCwdCheck 由 classify 依五道護欄算出；規則二/三/四不受影響。
  if (
    !skipCwdCheck && inv.cwd.kind === "known" &&
    !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)
  ) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // …規則二/三/四原封不動…
```

In `classify`, hoist the `RuleContext` into a named const and compute the exemption:

```ts
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
  // 缺省 false = 起點不可信 → 永不豁免（fail-safe；既有呼叫端行為不變）
  sessionCwdInScope = false,
): RuleVerdict {
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots);

  if (inv.name === null) return ask("動態指令名，無法判定");

  const rule = lookupRule(inv.name);
  const ctx: RuleContext = {
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
    resolveUrl: (v) => resolveUrl(v, rules.webFetch),
    isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
  };
  const ruleVerdict: RuleVerdict | null = rule ? rule.evaluate(ctx) : null;
  if (ruleVerdict?.kind === "deny") return ruleVerdict;

  // 護欄 4：argv 必須全為靜態 token。唯一例外是規則自身以 toleratesNonStaticOperand
  // 認定的 endpoint / URL 操作元（本工具的判定不讀其內容）。
  const allArgvStatic = inv.argv.every((w) => staticValue(w) !== null);
  const cwdExempt = ruleVerdict?.kind === "allow" && // 護欄 1
    sessionCwdInScope && // 護欄 2（起點可信）
    inv.cwd.kind === "known" &&
    inv.cwd.origin === "chain-cd" && // 護欄 2（鏈內 cd）
    (allArgvStatic || (rule?.toleratesNonStaticOperand?.(ctx) ?? false)) && // 護欄 4
    (rule?.cwdIndependent?.(ctx) ?? false);

  const central = centralPreflightAsk(inv, scope, cwdExempt);
  if (central) return central;

  // …步驟 4、5 原封不動…
```

Add to `classify.ts`'s imports: `import type { RuleContext } from "../rules/types.ts";` and
`import { staticValue } from "./word.ts";`.

- [ ] **Step 5: Compute `sessionCwdInScope` in `src/engine/evaluate.ts`**

```ts
    const scope = buildScopeConfig(root, rules, home, trustedReadRoots);
    const sessionCwdInScope = initialCwd.kind === "known" &&
      isReadScoped(normalizeAbsolute(initialCwd.path), scope);
    return combine(
      invocations.map((inv) =>
        classify(inv, root, rules, home, trustedReadRoots, sessionCwdInScope)
      ),
    );
```

Add: `import { buildScopeConfig, isReadScoped, normalizeAbsolute } from "./scope.ts";`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/rules/types.ts src/engine/classify.ts src/engine/evaluate.ts src/engine/classify_test.ts
git commit -m "feat(engine): cwd-independent exemption for central preflight rule 1"
```

---

### Task 13: end-to-end acceptance pairs for every declaring rule

**Files:**
- Test: `src/engine/classify_test.ts`

Spec §7.1 requires a stdin-only **allow** and a path-operand **ask** for every conditionally
declaring rule. Task 12 covered the guardrails; this task covers the matrix.

- [ ] **Step 1: Write the tests**

```ts
Deno.test("stdin-only filters are cwd-independent after chain cd", () => {
  const cases = [
    "cat", "head -100", "wc -l", "cut -c1", "tr a b", "nl", "fold -w 80",
    "column -t", "sort", "uniq", "xxd", "tail -200", "yq '.'", "diff",
    "grep -E 'Retry'", "sed -n '600,750p'", "awk '{print $1}'", "jq -r '.name'",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "allow", c);
  }
});

Deno.test("the same commands with a path operand still ask", () => {
  const cases = [
    "cat a.txt", "head -100 a.txt", "wc -l a.txt", "cut -c1 a.txt", "nl a.txt",
    "fold -w 80 a.txt", "column -t a.txt", "sort a.txt", "uniq a.txt", "xxd a.txt",
    "tail -200 a.txt", "yq '.' a.yaml", "diff a.txt b.txt", "grep pat a.txt",
    "sed -n '1p' a.txt", "awk '{print}' a.txt", "jq -r '.name' a.json",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "ask", c);
  }
});

Deno.test("guardrail 5: a path-valued or unknown flag blocks the exemption", () => {
  assertEquals(decide("cd /tmp && wc --files0-from=list").verdict, "ask");
  assertEquals(decide("cd /tmp && sort --files0-from=list").verdict, "ask");
  assertEquals(decide("cd /tmp && grep --exclude-from=f pat").verdict, "ask");
  assertEquals(decide("cd /tmp && realpath --relative-to=d x").verdict, "ask");
  assertEquals(decide("cd /tmp && diff -X ex.txt a.txt b.txt").verdict, "ask");
  assertEquals(decide("cd /tmp && jq -f prog.jq").verdict, "ask");
  assertEquals(decide("cd /tmp && wc --some-unknown-flag").verdict, "ask");
  assertEquals(decide("cd /tmp && sed --some-unknown-flag 'p'").verdict, "ask");
  assertEquals(decide("cd /tmp && awk --some-unknown-flag '{print}'").verdict, "ask");
});

Deno.test("gh api / search become cwd-independent after chain cd", () => {
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50").verdict, "allow");
  assertEquals(decide("cd /tmp && gh search code x --language go").verdict, "allow");
});

Deno.test("repo-scoped gh subcommands and placeholders are never exempt", () => {
  assertEquals(decide("cd /tmp && gh pr diff").verdict, "ask");
  assertEquals(decide("cd /tmp && gh repo view").verdict, "ask");
  assertEquals(decide("cd /tmp && gh issue list --repo o/r").verdict, "ask");
  assertEquals(decide("cd /tmp && gh api 'repos/{owner}/{repo}/issues'").verdict, "ask");
  assertEquals(decide("cd /tmp && gh search code x --web").verdict, "ask");
  assertEquals(decide("cd /tmp && gh api x --cache 1h").verdict, "ask");
});

Deno.test("the baseline pipeline shapes now allow end to end", () => {
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/contents/pkg?ref=v1 | jq -r '.[].name'").verdict,
    "allow",
  );
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/x -H 'Accept: application/vnd.github.raw' 2>&1 | grep -A 10 -B 2 -E 'Retry|backoff'").verdict,
    "allow",
  );
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | wc -l").verdict, "allow");
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | sed -n '600,750p'").verdict, "allow");
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50 | head -100").verdict, "allow");
});
```

- [ ] **Step 2: Run them**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS. Any failure here is a real gap in Tasks 5–12 — fix the rule, never the assertion.

- [ ] **Step 3: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/engine/classify_test.ts
git commit -m "test(engine): full stdin-only allow / path-operand ask matrix for the exemption"
```

---

### Task 14: filesystem-state independence fixtures

**Files:**
- Test: `src/rules/commands/gh_test.ts`, `src/rules/commands/curl_test.ts`

The verdict must depend only on the literal token, never on what exists in the cwd. The fixture
must therefore build the rule context **with the temp directory as its cwd**, and compare the same
context before and after creating a matching file.

- [ ] **Step 1: Write the tests**

Append to `src/rules/commands/gh_test.ts`:

```ts
/** 以指定目錄為 cwd/root 建立 RuleContext（fixture 用）。 */
function ctxIn(dir: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: dir } as const;
  return {
    name: "gh",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope(dir)),
    resolvePathValue: (x) => resolvePathValue(x, cwd, rootScope(dir)),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("gh api verdict does not depend on cwd filesystem contents", async () => {
  const dir = (await Deno.makeTempDir()).replace(/\\/g, "/");
  const src = "gh api repos/o/r/tags?per_page=50";
  try {
    const before = ghRule.evaluate(ctxIn(dir, src)).kind;
    // 建立一個「把 ? 換成單一字元」後可匹配的檔案
    await Deno.mkdir(`${dir}/repos/o/r`, { recursive: true });
    await Deno.writeTextFile(`${dir}/repos/o/r/tagsXper_page=50`, "");
    const after = ghRule.evaluate(ctxIn(dir, src)).kind;
    assertEquals(before, after);
    assertEquals(after, "allow");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every single-character expansion of the endpoint yields the same verdict", () => {
  const base = v("gh api repos/o/r/tags?per_page=50");
  assertEquals(base, "allow");
  for (const ch of ["X", "-", ".", "1", "_"]) {
    assertEquals(v(`gh api repos/o/r/tags${ch}per_page=50`), base, ch);
  }
});

Deno.test("multiple expanded endpoints are a gh usage error, never a write", () => {
  // 兩個位置操作元：gh 自己會報錯；本工具的判定仍是 allow（GET、無寫入旗標）
  assertEquals(v("gh api repos/o/r/tagsXq=1 repos/o/r/tagsYq=1"), "allow");
});
```

The curl invariance tests were already added in Task 11 Step 1.

- [ ] **Step 2: Run them**

Run: `deno task test`
Expected: PASS. `deno.json`'s test task already grants
`--allow-run --allow-env --allow-read --allow-write --allow-sys=uid`, so no config change is
needed.

- [ ] **Step 3: Commit**

```bash
git add src/rules/commands/gh_test.ts
git commit -m "test(rules): lock verdict independence from cwd filesystem state"
```

---

### Task 15: sync `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

Three places currently contradict the new behavior and must be updated together, or a future
maintainer will "fix" the exemption back out.

- [ ] **Step 1: Update the central preflight rule 1 description**

In "四條中央前置規則（於 classify.ts…）", replace item 1:

```markdown
1. **cwd 範圍**：`cwd.kind === "known"` 但落在「專案 ∪ 使用者以 `Read()/Edit()/Write()` 放寬的外部
   唯讀範圍 ∪ 當前 session 的 trusted read roots」之外 → ask（判定由 `scope.ts` 的 `isReadScoped`
   統一負責）。**唯一例外**：五道護欄全部成立時跳過本條（且只跳過本條）——
   (1) 指令規則自身回 `allow`（`permissions.allow` 升級的 ask 永不豁免）；
   (2) hook 傳入的 session cwd 本身在範圍內 **且** 當前 cwd 由鏈內 `cd` 產生（`origin === "chain-cd"`）；
   (3) 相對路徑仍以真實 cwd 解析；
   (4) argv 全為靜態 token（唯一例外是 gh api endpoint / curl URL 操作元，由規則以
       `toleratesNonStaticOperand` 認定）；
   (5) 每個旗標都命中該規則的已知旗標表。
   宣告方式為 `CommandRule.cwdIndependent`，未宣告 = 不豁免（default-deny）。
```

- [ ] **Step 2: Fix the contradicting statement about out-of-scope cwd being a regression**

The line stating that a binary returning `allow` for an out-of-scope cwd is a regression must be
qualified. Replace that clause with:

```markdown
若 binary 對帶**寫入重導向／賦值前綴／範圍外 `<`** 的指令回 `allow`，那**是 regression**——這三條
中央前置 ask 對所有指令通用且不可由 `permissions.allow` 升級。**cwd 超範圍**則有一個受控例外：
符合上述五道護欄的純唯讀、與 cwd 無關的指令（如 `cd /outside && gh api …`）會 `allow`，這是設計
行為而非 regression；不符合任一護欄者仍必須 `ask`。
```

- [ ] **Step 3: Fix the contradicting statement in 「新增 / 修改指令規則」**

Replace the sentence saying rule behavior cannot affect any of the four preflight outcomes with:

```markdown
**不要重複處理**中央前置規則已涵蓋的事（cwd 範圍、寫入重導向、賦值前綴、範圍外 `<`）。規則雖**先於**
中央前置評估，但其 allow/ask 會被中央前置 ask 覆寫；能越過的只有 rule deny，以及規則明確宣告
`cwdIndependent` 且五道護欄全部成立時的**規則一**。規則二/三/四永遠不受規則行為影響。
```

- [ ] **Step 4: Update the architecture bullets**

`classify.ts` bullet — append:

```markdown
  另計算 cwd 豁免旗標（`cwdIndependent` / `toleratesNonStaticOperand` 兩個可選述詞 + 五道護欄），
  以 `skipCwdCheck` 傳給 `centralPreflightAsk`，**僅**跳過規則一。
```

`scope.ts` bullet — append:

```markdown
  另提供 `buildScopeConfig`，供 `evaluate`（計算 `sessionCwdInScope`）與 `classify` 共用同一份範圍定義。
```

`rules/` bullet — replace the file list line with:

```markdown
`rules/`：`types.ts`（`CommandRule`/`RuleContext`/`RuleVerdict` + `allow()`/`ask()`/`deny()`，
另含 `cwdIndependent` / `toleratesNonStaticOperand` 兩個可選述詞）、
`command_spec.ts`（**每個指令一份 `CommandSpec`**：每個旗標只描述一次——名稱、是否吃值、值是否為路徑；
外加位置參數語義 `paths` / `none` / `pattern-then-paths`。`parseArgv` 對每個 `RuleContext` 只解析一次
並快取，`evaluate` 與 `cwdIndependent` 因此讀到**同一份**結果，不會各自重掃而漂移）、
`flags.ts`、`factory.ts`（`flagGatedReader`，改由 `CommandSpec` 驅動）、`allowlist.ts`、
`commands/*.ts`（每類指令一檔；本次新增 `commands/jq.ts`，`jq` 已自 `fileReaderRule` 移出）。
```

- [ ] **Step 5: Add the `word.ts` note**

Append to the `word.ts` section:

```markdown
- **`nonPathStaticValue`**：只容忍「單一 `?` 查詢串」形態（恰一個未跳脫 `?`、不在索引 0、其後不含 `/`）
  的未加引號 token，且**只可用於 `gh api` 的 endpoint 與 `curl` 的 URL 操作元**。旗標、旗標值、任何
  路徑一律沿用 `staticValue`。安全性由「本工具的判定不讀該 token 內容」保證：`gh api` 的判定只看旗標，
  `curl` 的 scheme/host 由「元字元必須落在終結 authority 的 `/` 之後」保證落在字面前綴內
  （故 `https://host?q=1` 這種無路徑段的 URL 一律 ask——展開會改變主機）。
```

- [ ] **Step 6: Update the gh notes**

In 「安全誤放（auto-allow 不該 allow）」, replace the gh part of the git/gh bullet with:

```markdown
- **gh 已改為旗標 allowlist**：未知旗標一律 ask（同時免疫 gh 版本漂移）。本機副作用旗標
  `-w`/`--web`（開瀏覽器）與 `--cache`（寫本機快取）對所有子指令一律 ask。非 GET 方法的偵測
  以**旗標感知解析**進行，群集寫法（`-iXPOST`）同樣會被攔下。`gh api` 的 endpoint 含
  `{owner}`/`{repo}`/`{branch}` 時目標由 cwd 的 git repo 決定 → 不得享有 cwd 豁免（一般判定不變）。
```

- [ ] **Step 7: Verify and commit**

Run: `deno task check && deno task lint && deno task test`
Expected: all green (no code changed).

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md with the cwd exemption, CommandSpec, gh allowlist and jq rule"
```

---

### Task 16: build + operational verification against the real baseline set

**Files:**
- No source changes. Produces `dist/permission-checker(.exe)` (gitignored).

**The acceptance criterion is fixed: 63 allow / 4 ask over the 67-command baseline.** A shortfall
is an unmet criterion to diagnose, not a number to rewrite. Do **not** edit the spec's target.

- [ ] **Step 1: Build**

Run: `deno task build`
Expected: `dist/permission-checker.exe` written, exit 0.

- [ ] **Step 2: Create an isolated settings environment**

Spec §7.3 requires verifying builtin classification without any `permissions.allow` interference.
The binary reads project `.claude/settings.json`, `.claude/settings.local.json`, and the user
settings under `CLAUDE_CONFIG_DIR ?? <home>/.claude`. Isolate all three:

```bash
VERIFY_ROOT="$(mktemp -d)"
VERIFY_CFG="$(mktemp -d)"
mkdir -p "$VERIFY_ROOT/.claude"
printf '{}' > "$VERIFY_ROOT/.claude/settings.json"
printf '{}' > "$VERIFY_ROOT/.claude/settings.local.json"
printf '{}' > "$VERIFY_CFG/settings.json"
echo "root=$VERIFY_ROOT cfg=$VERIFY_CFG"
```

Every invocation below must pass **both** `CLAUDE_PROJECT_DIR="$VERIFY_ROOT"` and
`CLAUDE_CONFIG_DIR="$VERIFY_CFG"`. Confirm the isolation works before trusting any result:

```bash
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"rm -rf x"},"cwd":"'"$VERIFY_ROOT"'"}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask`. If this prints `allow`, the isolation failed — stop and fix it.

- [ ] **Step 3: Build the 67-command baseline fixture**

The baseline is the Bash tool calls of one research subagent transcript. Extract them with:

```bash
TRANSCRIPT="<path to the subagent .jsonl>"
jq -c 'select(.message.content) | .message.content[]?
       | select(.type=="tool_use" and .name=="Bash")
       | {tool_name:"Bash", tool_input:{command:.input.command}, cwd:"'"$VERIFY_ROOT"'"}' \
  "$TRANSCRIPT" > baseline.jsonl
wc -l baseline.jsonl   # 期望 67
```

If that transcript is not available on the machine running this task, **stop and ask the user for
it**. Do not substitute a reconstructed set — the acceptance count is defined over the real one.

- [ ] **Step 4: Replay and tally**

```bash
: > baseline_results.txt
n=$(wc -l < baseline.jsonl); i=1
while [ "$i" -le "$n" ]; do
  sed -n "${i}p" baseline.jsonl \
    | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
    | jq -r '.hookSpecificOutput.permissionDecision + "\t" + (.hookSpecificOutput.permissionDecisionReason // "")' \
    >> baseline_results.txt
  i=$((i+1))
done
cut -f1 baseline_results.txt | sort | uniq -c
```

Expected: **63 allow, 4 ask**. The four asks must be the two `for f in …; do gh api …${f}… ; done`
loops (variable expansion), the one `xargs -I {} sh -c …` line, and the one heredoc-write line.
Confirm by pairing `baseline.jsonl` with `baseline_results.txt` line by line.

**If the count is short:** for each unexpected `ask`, read its reason, identify which guardrail or
flag table rejected it, and fix the rule — most likely a missing safe flag in a `CommandSpec` or
in gh's tables. Adding a genuinely safe, side-effect-free flag to a table is the correct fix.
Relaxing a guardrail, or editing the spec's target, is not.

- [ ] **Step 5: Verify the guardrails end-to-end**

```bash
for c in "cd /d && ls" "cd /d && cat x.txt" "cd /d && echo *" "cd /d && grep *" \
         "cd /d && gh pr diff" "cd /d && gh api repos/o/r/x > out.txt" \
         "cd /d && gh search code x --web" "cd /d && wc --files0-from=list" \
         "cd /d && which some-name" "cd /d && curl -s https://api.github.com?q=1" ; do
  printf '%s -> ' "$c"
  jq -nc --arg c "$c" --arg d "$VERIFY_ROOT" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
    | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
    | jq -r '.hookSpecificOutput.permissionDecision'
done
printf 'find -> '
jq -nc --arg c "cd /d && find . -name x" --arg d "$VERIFY_ROOT" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask` for all ten loop entries; `deny` for the `find` line. **No line may print `allow`.**

- [ ] **Step 6: Clean up**

```bash
rm -rf "$VERIFY_ROOT" "$VERIFY_CFG" baseline.jsonl baseline_results.txt
```

- [ ] **Step 7: Report**

Report the measured tally and the reason string for each of the four expected asks. If any
guardrail line printed `allow`, or the tally is not 63/4, the task is **not** complete — diagnose
and fix the rule, then re-run from Step 1.
