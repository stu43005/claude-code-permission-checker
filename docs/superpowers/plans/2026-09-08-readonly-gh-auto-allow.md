# Read-only `gh` CLI Auto-Allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking for read-only `gh` CLI research commands by fixing three interdependent false-ask root causes (out-of-project cwd, `?` in a `gh api` endpoint treated as glob, `grep`/`jq` non-path leading positionals), while closing several read-only gaps found during review.

**Architecture:** `classify` gains a cwd exemption that skips **only** central preflight rule 1, fenced by five guardrails and opted into per rule. **Eight** commands opt in: `gh`, `head`, `jq`, `grep`, `wc`, `tail`, `sed` — every filter the baseline set actually uses — plus `curl` (allow forms only, **without** any relaxed parsing); and `echo`/`pwd`/`whoami`, which take no path operands. The four that go through `flagGatedReader` (`grep`, `head`, `wc`, `tail`) get a small `CommandSpec` declaring each flag once, parsed once and memoized per `RuleContext` so `evaluate` and the predicate provably read the same parse. `gh`, `jq`, and `sed` keep hand-written parsers with the same memoization. `gh api`'s endpoint operand gets a narrowly-scoped relaxed static value; `curl` does not.

**Tech Stack:** Deno 2 + TypeScript, `npm:unbash@4.0.1` for Bash AST parsing, `@std/assert` for tests, `deno compile` to a single binary.

**Spec:** `docs/superpowers/specs/2026-09-03-readonly-gh-auto-allow-design.md`

---

## Conventions for every task

**No document references in shipped code.** Code comments explain the behavior; they never cite
`spec §x.y`. Plan prose may cite the spec freely.

**Use the test helper each file already has — verified signatures:**

| Test file | Existing helper |
| --- | --- |
| `src/rules/commands/grep_test.ts` | `ctxOf(name, src)`; assert `grepRule.evaluate(ctxOf(...)).kind` |
| `src/rules/commands/coreutils_test.ts` | `ctxOf(src, cwd?)` — **one** command string, optional cwd |
| `src/rules/commands/simple-flag_test.ts` | `v(rule, name, src)` |
| `src/rules/commands/gh_test.ts` | `ctxOf(src)` + `v(src)` |
| `src/rules/commands/curl_test.ts` | `ctxOf(src)`; the fixture's allowed domain is **`api.example.com`** |
| `src/engine/classify_test.ts` | `only(src)`, `onlyWith(src, rules)`, `rulesOf({...})`; already imports `walk` |

**Verified third-party behavior this plan depends on** (each confirmed by running the tool locally):

| Fact | Evidence |
| --- | --- |
| `jq -f/--from-file` is a **boolean**; the program file is the **first positional**, regardless of flag position | `jq prog.jq -f data.json` → `1` (program `prog.jq` = `.a`, input `data.json` = `{"a":1}`). Had `-f` consumed `data.json`, the input would be the non-JSON `prog.jq` and jq would error. |
| `jq -L` accepts an **attached** value | `jq -Ln '.' data.json` → `{"a":1}`. If `-Ln` were `-L -n` (null input) the output would be `null`. |
| `grep --color` / `--colour` do **not** consume the next token (optional, attached-only) | `grep --color pat f.txt` prints the match; the pattern is not swallowed. |
| `head -100` / `tail -200` numeric shorthand is valid | Both run and print. |
| `gh api`'s HTTP method comes from flags only (`GET` default, `POST` when parameters are added, `--method` overrides) — never from the endpoint | `gh api --help`, gh 2.93.0 |
| `gh api` fills `{owner}` / `{repo}` / `{branch}` from the repository of the current directory | `gh api --help`, gh 2.93.0 |
| `dangerousRoot` denies only a filesystem root or the home root | built binary: `cd /tmp && find . -name x` → **ask**; `cd /d && find . -name x` and `cd /tmp && find / -name x` → **deny** |
| `resolveUrl` compares **path prefixes** for 38 preapproved entries, not just the host | `permissions/domain_scope.ts`: `matchesPreapproved(host, pathname)` |

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/rules/command_spec.ts` | `CommandSpec` (each flag declared once) + `parseArgv`, memoized per `RuleContext`. Four commands use it: `grep`/`egrep`/`fgrep`, `head`, `wc`, `tail`. **`rg` deliberately does not** — it never opts into the exemption, so its flag grammar is left untouched on the legacy path |
| `src/rules/command_spec_test.ts` | Parser tests |
| `src/rules/commands/jq.ts` | `jq` rule: filter is not a path; `-f` is boolean; `-L` takes an attached value |
| `src/rules/commands/jq_test.ts` | Tests for the above |

**Modify:** `src/engine/word.ts`, `src/types.ts`, `src/engine/cwd.ts`, `src/engine/scope.ts`,
`src/engine/classify.ts`, `src/engine/evaluate.ts`, `src/rules/types.ts`, `src/rules/factory.ts`,
`src/rules/commands/{grep,coreutils,simple-flag,tail,sed,gh,curl}.ts`, `src/rules/allowlist.ts`,
`src/engine/{cwd,walk,classify}_test.ts`, `CLAUDE.md`.

**Deliberately untouched:** `src/rules/commands/{awk,positional-output,find,deno,git}.ts`, and
`rg`'s flag handling inside `grep.ts`.
`awk`, `uniq`, `xxd`, `yq`, `sort`'s exemption, `diff`, `tree`, `file`, `date` — none of them opt
in, so none of their flag grammars need modelling. `curl` is touched only to add its predicate
(Task 12); its value parsing is deliberately left alone.

---

### Task 1: declare the two optional predicates on `CommandRule`

**Files:**
- Modify: `src/rules/types.ts`

This lands **first** so every later task's focused `deno test` type-checks. It is a pure type
addition — both properties are optional, so no existing rule changes.

- [ ] **Step 1: Add the declarations**

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
   * 此次呼叫是否僅含一種非靜態 token：本工具的判定完全不讀其內容的操作元
   * （目前只有 gh api 的 endpoint）。其餘 token 必須皆為靜態。必須為純函式。
   */
  toleratesNonStaticOperand?(ctx: RuleContext): boolean;
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `deno task check && deno task lint && deno task test`
Expected: all green — optional properties on an interface break no existing implementation.

- [ ] **Step 3: Commit**

```bash
git add src/rules/types.ts
git commit -m "feat(rules): declare optional cwdIndependent / toleratesNonStaticOperand predicates"
```

---

### Task 2: `word.ts` — glob metachar index + relaxed operand value

**Files:**
- Modify: `src/engine/word.ts`
- Test: `src/engine/word_test.ts`

**Two parsing decisions this task locks in:**

1. **The relaxed branch applies only to words with no `parts`** (a wholly unquoted literal).
   A word that has `parts` and still failed `staticValue` is rejected outright. Reason: `word.value`
   is the *quote-removed* concatenation, so a backslash that came from inside quotes is
   indistinguishable from a shell escape — scanning it with escape semantics would let
   `'a\'*b?c` hide the active `*`. Rejecting mixed-quoting words costs only an extra prompt for an
   unusual form (`gh api "repos/o"/r/x?q=1`).
2. **Backslashes in an unquoted word use escape-aware scanning, then quote removal.** `a\b` never
   reaches the relaxed branch — it has no *unescaped* metachar, so `staticValue` already returns
   `"ab"`. `a\b?c` does reach it: `firstGlobMetacharIndex` skips `\b` and finds the active `?`;
   the returned value is the quote-removed `"ab?c"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/word_test.ts` (it already imports `assertEquals`, `parse`, `Command`):

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
  const r = nonPathStaticValue(wordOf("repos/o/r/tags?per_page=50"))!;
  assertEquals(r.value, "repos/o/r/tags?per_page=50");
  assertEquals(r.globIndex, "repos/o/r/tags".length);
  assertEquals(r.raw, "repos/o/r/tags?per_page=50");
});

Deno.test("globIndex is measured on the raw string, so escapes survive", () => {
  // `a\?b`：`\` 是被跳脫的反斜線，`?` 是活躍 glob（索引 3）
  const active = nonPathStaticValue(wordOf("a" + "\\\\" + "?b"))!;
  assertEquals(active.globIndex, 3);
  assertEquals(active.value, "a" + "\\" + "?b"); // quote removal 後仍留一個反斜線
  // 對 value 重跑 firstGlobMetacharIndex 會得到 -1 —— 正是不可這樣做的原因
  assertEquals(firstGlobMetacharIndex(active.value), -1);
});

Deno.test("nonPathStaticValue passes already-static words straight through", () => {
  // 本就靜態者 globIndex 為 -1：無活躍元字元，呼叫端不需做位置判定
  const cases: Array<[string, string]> = [
    ["plain/endpoint", "plain/endpoint"],
    ["'a?b/c'", "a?b/c"],
    ['"a*b"', "a*b"],
    ["a\\b", "ab"], // 無未跳脫元字元 → staticValue 已回字面值
  ];
  for (const [src, expected] of cases) {
    const r = nonPathStaticValue(wordOf(src))!;
    assertEquals(r.value, expected, src);
    assertEquals(r.globIndex, -1, src);
  }
});

Deno.test("an unquoted backslash plus an active ? goes through quote removal", () => {
  const r = nonPathStaticValue(wordOf("a\\b?c"))!;
  assertEquals(r.value, "ab?c");
  assertEquals(r.globIndex, 3); // 原字串 `a\b?c` 中 `?` 的索引
});

Deno.test("a word with parts is never relaxed (quote provenance is unrecoverable)", () => {
  // 引號內的反斜線在 word.value 中與 shell 跳脫無法區分，逐字掃描會誤放後面的 `*`
  assertEquals(nonPathStaticValue(wordOf("'a\\'*b?c")), null);
  assertEquals(nonPathStaticValue(wordOf('"a"?b')), null);
});

Deno.test("nonPathStaticValue rejects everything outside the tolerated shape", () => {
  assertEquals(nonPathStaticValue(wordOf("a*b")), null);
  assertEquals(nonPathStaticValue(wordOf("a[bc]")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b?c")), null);
  assertEquals(nonPathStaticValue(wordOf("?abc")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b/c")), null);
  assertEquals(nonPathStaticValue(wordOf("$X")), null);
  assertEquals(nonPathStaticValue(wordOf("$(x)")), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: FAIL — neither function is exported.

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
 *     故所有前段路徑都落在字面前綴內。
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
 * 「本工具的判定完全不讀其內容」的操作元專用靜態取值。
 * 與 staticValue 的唯一差異：未加引號、且符合「單一 `?` 查詢串」形態的 token
 * 不再視為動態。`*` / `[` / 多重元字元 / `?` 後含 `/` 一律回 null。
 *
 * **目前唯一合法用途是 `gh api` 的 endpoint 操作元**——gh api 的判定只掃描旗標、
 * 完全不讀 endpoint 路徑，故展開結果不影響判定。路徑、旗標、旗標值，以及 curl 的
 * 任何 token（其判定會比對 preapproved 的 path 前綴）一律不得使用本函式。
 */
export interface RelaxedOperand {
  /** bash quote removal 後的值 —— 這是要拿去做語義判定（子指令、佔位符…）的字串。 */
  value: string;
  /**
   * 被容忍的 `?` 在**原始未展開字串**中的索引；該 token 本就靜態（無活躍元字元）時為 -1。
   * 呼叫端要判斷「元字元位置」時**必須**用這個索引搭配 `raw`，
   * 不可對 `value` 重跑 `firstGlobMetacharIndex` —— quote removal 已抹除跳脫資訊，
   * 重掃會把 `a\?b`（活躍 `?`）誤判成無元字元，也會把 `a\?b`（字面 `?`）誤判成活躍。
   */
  globIndex: number;
  /** 原始字串（未做 quote removal），供呼叫端與 globIndex 搭配做位置判定。 */
  raw: string;
}

export function nonPathStaticValue(word: Word): RelaxedOperand | null {
  const strict = staticValue(word);
  if (strict !== null) return { value: strict, globIndex: -1, raw: word.value };
  // 有 parts（含任何引號片段）→ 一律拒絕。word.value 是 quote-removed 的串接，
  // 引號內的反斜線與 shell 跳脫已無法區分，逐字掃描會誤判哪些元字元是活的。
  if (word.parts) return null;
  // 無 parts = 整個 word 皆為未加引號字面值：firstGlobMetacharIndex 本身處理跳脫，
  // 故在原字串上判形態並記下位置，再回傳 bash quote removal 後的值。
  const raw = word.value;
  if (!isSingleQueryGlob(raw)) return null;
  return { value: removeBackslashEscapes(raw), globIndex: firstGlobMetacharIndex(raw), raw };
}
```

- [ ] **Step 4: Run the tests, type check and lint**

Run: `deno test --allow-env src/engine/word_test.ts && deno task check && deno task lint`
Expected: PASS / no errors.

- [ ] **Step 5: Commit**

```bash
git add src/engine/word.ts src/engine/word_test.ts
git commit -m "feat(engine): add firstGlobMetacharIndex + nonPathStaticValue"
```

---

### Task 3: `CwdState.origin` — mark chain-derived cwd (and fix the eight assertions it breaks)

**Files:**
- Modify: `src/types.ts:6-8`, `src/engine/cwd.ts:13-18`
- Test: `src/engine/cwd_test.ts`, `src/engine/walk_test.ts`

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

- [ ] **Step 2: Run it to verify it fails**

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

- [ ] **Step 5: Update the eight assertions this breaks**

In `src/engine/cwd_test.ts`, every expected object that came out of `applyPath` gains the field.
Apply these six exact replacements (each `old` line appears once in the file):

```ts
// 1.
assertEquals(next, { kind: "known", path: "/proj/src" });
// →
assertEquals(next, { kind: "known", path: "/proj/src", origin: "chain-cd" });

// 2.
assertEquals(next, { kind: "known", path: "/tmp" });
// →
assertEquals(next, { kind: "known", path: "/tmp", origin: "chain-cd" });

// 3.
assertEquals(c, { kind: "known", path: "/proj/sub" });
// →
assertEquals(c, { kind: "known", path: "/proj/sub", origin: "chain-cd" });

// 4.
assertEquals(c, { kind: "known", path: "/proj/sub/wt" });
// →
assertEquals(c, { kind: "known", path: "/proj/sub/wt", origin: "chain-cd" });

// 5.
assertEquals(c, { kind: "known", path: "/outside" });
// →
assertEquals(c, { kind: "known", path: "/outside", origin: "chain-cd" });

// 6.
    { kind: "known", path: "/outside/.git" },
// →
    { kind: "known", path: "/outside/.git", origin: "chain-cd" },
```

**Unchanged in `cwd_test.ts`**: the three `{ kind: "unknown" }` expectations, and the
`gitEffectiveCwd(cmdOf("git status"), …)` case that expects `{ kind: "known", path: "/proj" }` —
with no path option, `gitEffectiveCwd` returns the incoming cwd object without calling `applyPath`.

In `src/engine/walk_test.ts`, two replacements:

```ts
// 1. 在 "cd 在 && 後持久" 一類的測試中
assertEquals(cat.cwd, { kind: "known", path: "/proj/src" });
// →
assertEquals(cat.cwd, { kind: "known", path: "/proj/src", origin: "chain-cd" });

// 2. 在 "git -C sets per-command cwd without leaking" 中，git 葉指令的 cwd
//    由 gitEffectiveCwd 經 applyPath 推導而來
assertEquals(git.cwd, { kind: "known", path: "/proj/sub" });
// →
assertEquals(git.cwd, { kind: "known", path: "/proj/sub", origin: "chain-cd" });
```

**Unchanged in `walk_test.ts`**: `assertEquals(cat.cwd, { kind: "known", path: "/proj" });` —
that cwd never went through `applyPath` (it is the unchanged session cwd).

If the variable name in replacement 2 differs from `git`, use whatever the test binds that leaf to;
the identifying feature is that it is the `git` invocation inside that test, and its expected path
is `/proj/sub`.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/cwd.ts src/engine/cwd_test.ts src/engine/walk_test.ts
git commit -m "feat(engine): mark chain-derived cwd with origin: chain-cd"
```

---

### Task 4: `buildScopeConfig` — one ScopeConfig construction shared by evaluate and classify

**Files:**
- Modify: `src/engine/scope.ts` (append after the `ScopeConfig` interface), `src/engine/classify.ts`
- Test: `src/engine/scope_test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/engine/scope_test.ts`. `ReadScope` is `{ roots: string[]; files: string[] }`
(verified in `src/permissions/path_scope.ts:4-9`), so build three distinct scopes as literals —
do **not** call `parsePathRule`, whose real signature is
`parsePathRule(rule: string, home: string | null): PathScopeEntry | null`:

```ts
import { buildScopeConfig } from "./scope.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { EMPTY_DOMAIN_SCOPE } from "../permissions/domain_scope.ts";

Deno.test("buildScopeConfig maps allow/deny/ask to distinct fields", () => {
  const rules: PermissionRules = {
    bash: { allow: [], deny: [], ask: [] },
    readScope: {
      allow: { roots: ["/allowed"], files: [] },
      deny: { roots: ["/denied"], files: [] },
      ask: { roots: ["/asked"], files: [] },
    },
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
  };
  const scope = buildScopeConfig("/proj", rules, "/home/u", ["/trusted"]);
  assertEquals(scope.root, "/proj");
  assertEquals(scope.home, "/home/u");
  assertEquals(scope.trusted, ["/trusted"]);
  assertEquals(scope.allow.roots, ["/allowed"]);
  assertEquals(scope.deny.roots, ["/denied"]);
  assertEquals(scope.ask.roots, ["/asked"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

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

Replace the inline `scope` construction inside `classify` with:

```ts
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots);
```

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

### Task 5: close the existing unchecked path-value gaps

**Files:**
- Modify: `src/rules/factory.ts`（遞迴根 deny 提前）、`src/rules/commands/coreutils.ts`（`fileReaderRule`、`diffRule`）、`src/rules/commands/simple-flag.ts`（`sortRule`）
- Test: `src/rules/commands/coreutils_test.ts`, `src/rules/commands/simple-flag_test.ts`

These flags read a file but their values were never scope-checked. This is a standalone security
fix using the **existing** `flagGatedReader` options — independent of the exemption work.

Verified from `--help`: `wc --files0-from=F`, `sort --files0-from=F`, `grep --exclude-from=FILE`,
`diff -X/--exclude-from=FILE` and `-S/--starting-file=FILE`, `realpath --relative-to=DIR` and
`--relative-base=DIR`.

**Deliberately excluded:** `file -m/-f` and `date -r/-f`. Spec §2.2 and §8.3 explicitly keep those
existing gaps out of scope for this change; adding them here would alter two rules the plan
otherwise does not touch.

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/coreutils_test.ts` — its helper is `ctxOf(src, cwd?)`, taking **one**
command string:

```ts
Deno.test("realpath flags are scope-checked in the separate-value form too", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to ../out a.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-base ../out a.txt")).kind, "ask");
});

Deno.test("wc --files0-from is scope-checked in both forms", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from=list.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from=../out/list.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc --files0-from ../out/list.txt")).kind, "ask");
});

Deno.test("realpath --relative-to / --relative-base are scope-checked", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to=sub a.txt")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-to=../out a.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath --relative-base=../out a.txt")).kind, "ask");
});

Deno.test("diff -X / -S are scope-checked in both forms", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff -X ex.txt a.txt b.txt")).kind, "allow");
  assertEquals(diffRule.evaluate(ctxOf("diff -X ../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -X../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff --starting-file=../out a.txt b.txt")).kind, "ask");
  // 群集寫法無法可靠取值 → 保守 ask（含數字短選項的群集）
  assertEquals(diffRule.evaluate(ctxOf("diff -qX../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -qS../out a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -u0X../out.txt a.txt b.txt")).kind, "ask");
  assertEquals(diffRule.evaluate(ctxOf("diff -S ../out a.txt b.txt")).kind, "ask");
});
```

Append to `src/rules/commands/simple-flag_test.ts` — its helper is `v(rule, name, src)`:

```ts
Deno.test("sort --files0-from is scope-checked in both forms", () => {
  assertEquals(v(sortRule, "sort", "sort --files0-from=list.txt"), "allow");
  assertEquals(v(sortRule, "sort", "sort --files0-from=../out/list.txt"), "ask");
  assertEquals(v(sortRule, "sort", "sort --files0-from ../out/list.txt"), "ask");
});

Deno.test("sort's program / random-source flags ask in both forms", () => {
  assertEquals(v(sortRule, "sort", "sort --compress-program gzip f.txt"), "ask");
  assertEquals(v(sortRule, "sort", "sort --compress-program=gzip f.txt"), "ask");
  assertEquals(v(sortRule, "sort", "sort -R --random-source=../secret f.txt"), "ask");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts`
Expected: FAIL — the out-of-project variants currently allow, because the values are skipped.

- [ ] **Step 3: Move the recursive-root deny ahead of the path-value check in `src/rules/factory.ts`**

`flagGatedReader`'s legacy path currently runs `checkPathValueFlags` **before** the dangerous-root
scan. Adding path-valued flags to `fileReaderRule` therefore downgrades an existing hard deny:
`ls -R -I --relative-to=../out /` would return `ask` (the out-of-scope `--relative-to` value) instead
of `deny` (recursing from the filesystem root). Reorder so the deny always wins:

The complete replacement for `flagGatedReader`'s `evaluate` — the only change is that the
recursive-deny block moved above `checkPathValueFlags`. Keep using the existing
`const valueFlags = opts.valueFlags ?? [];` binding declared just above the returned object;
re-deriving it inline would leave that declaration unused and fail `deno task lint`:

```ts
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      // 遞迴根 deny 必須先於任何路徑 ask，否則新增路徑值檢查會把既有硬 deny 降級成 ask。
      // 危險根可能藏在被 value-flag 吃掉的 token 位置，故掃描全部 argv、不限 positionals。
      const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;
      if (isRecursive) {
        for (const w of ctx.argv) {
          if (ctx.isDangerousRoot(w)) {
            return deny(recursiveRootDenyReason(ctx.name, w.value));
          }
        }
      }
      const pathFlagVerdict = checkPathValueFlags(ctx, opts.pathValueFlags ?? []);
      if (pathFlagVerdict) return pathFlagVerdict;
      for (const arg of positionals(ctx.argv, valueFlags)) {
        const scope = ctx.resolvePath(arg);
        if (scope !== "in-project") {
          return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
        }
      }
      return allow();
    },
```

Task 7 later inserts the spec-backed branch between the `askFlags` check and this body; the
ordering shown here is what it preserves.

Task 7 keeps this ordering when it adds the spec-backed branch — `evaluateWithSpec` already runs
the deny scan first.

Add this regression test to `src/rules/commands/coreutils_test.ts`:

```ts
Deno.test("a recursive root deny outranks a path-value ask", () => {
  assertEquals(
    fileReaderRule.evaluate(ctxOf("ls -R -I x --relative-to=../out /")).kind,
    "deny",
  );
});
```

- [ ] **Step 4: Add the flags to `fileReaderRule` in `src/rules/commands/coreutils.ts`**

```ts
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // 這些旗標的值是會被讀取的路徑，過去被當一般 flag 跳過而未檢查：
  //   wc       --files0-from=F      從 F 讀 NUL 分隔的檔名清單
  //   realpath --relative-to=DIR / --relative-base=DIR
  valueFlags: [exact("--files0-from", "--relative-to", "--relative-base")],
  pathValueFlags: ["--files0-from", "--relative-to", "--relative-base"],
  // 這些指令無「會寫檔」的 flag；故 askFlags 留空。
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
});
```

> **`jq` stays in this `names` list.** Task 8 removes it in the same commit that registers
> `jqRule`, so `jq` is never left without a rule.

- [ ] **Step 5: Add the flags to `diffRule`**

```ts
/**
 * diff：位置參數做範圍檢查，且吃路徑值的旗標也需範圍檢查。
 * `pathValueFlags` 的比對只涵蓋 `-X val` / `-Xval` / `--exclude-from=val` 三種形式；
 * 群集寫法（`-qX../out.txt`）不在其中，值會被整個跳過而未檢查。
 * 群集形式罕見且難以在此 factory 內正確拆解，故直接列入 askFlags 保守處理。
 */
// GNU diff 也接受數字短選項（`-u0`、`-U3` 的簡寫形式），故群集字元類必須含數字：
// `-u0X../out.txt` 若只比對 [A-Za-z]{2,} 會整個漏掉，其 -X 的值便不會被檢查。
const diffClusterHasPathFlag: FlagMatcher = (t) =>
  !t.startsWith("--") && /^-[A-Za-z0-9]{2,}/.test(t) && /[XS]/.test(t.slice(1));

export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  askFlags: [diffClusterHasPathFlag],
  askReason: () => "diff：-X / -S 的群集寫法無法可靠取得其路徑值",
  valueFlags: [exact("--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file")],
  pathValueFlags: ["--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file"],
});
```

Add `FlagMatcher` to `coreutils.ts`'s `../flags.ts` import.

- [ ] **Step 6: Add the flag to `sortRule` in `src/rules/commands/simple-flag.ts`**

```ts
export const sortRule: CommandRule = flagGatedReader({
  names: ["sort"],
  askFlags: [
    exact("-o", "--output", "-T", "--temporary-directory", "--compress-program", "--random-source"),
    prefix("-o", "--output=", "-T", "--temporary-directory=", "--compress-program=", "--random-source="),
  ],
  valueFlags: [exact(
    "-o", "-T", "-S", "-k", "-t", "--output", "--temporary-directory", "--buffer-size",
    "--key", "--field-separator", "--files0-from", "--compress-program", "--random-source",
  )],
  pathValueFlags: ["--files0-from"],
  askReason: () =>
    "sort：-o / -T 會寫檔或指定暫存目錄；--compress-program 會執行外部程式；--random-source 會讀檔",
});
```

> `--compress-program` executes an external program and `--random-source` reads a file, so both
> join `askFlags` rather than being modelled as safe value flags.

- [ ] **Step 7: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/coreutils.ts src/rules/commands/simple-flag.ts src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts
git commit -m "fix(rules): scope-check --files0-from, --relative-to/-base, diff -X/-S; ask on sort's program/random-source flags"
```

---

### Task 6: `command_spec.ts` — one flag table, one memoized parse

**Files:**
- Create: `src/rules/command_spec.ts`, `src/rules/command_spec_test.ts`

Only four commands use this: `grep`/`egrep`/`fgrep`, `head`, `wc`, `tail`. The value of declaring
each flag once is that operand classification and the known-flag check cannot disagree — the
failure mode where `--color` swallowed grep's pattern.

Two flag forms the four commands genuinely need:

- `"required"` — consumes a value (`-n 10`, `-n10`, `--lines=10`).
- `"attached-only"` — an **optional** value that is only accepted glued with `=`; a bare
  `--color` consumes nothing. Verified: `grep --color pat f.txt` matches without swallowing `pat`.

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

const DEMO: CommandSpec = {
  flags: [
    { name: "-b", value: "none" },
    { name: "-w", value: "required" },
    { name: "--width", value: "required" },
    { name: "--color", value: "attached-only" },
    { name: "--from", value: "required", valueIsPath: true },
  ],
  positionals: "paths",
};

Deno.test("a required value is consumed in all three forms", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w 80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo -w80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo --width=80 a.txt"), DEMO).pathOperands.length, 1);
  assertEquals(parseArgv(ctxOf("demo", "demo --width 80 a.txt"), DEMO).pathOperands.length, 1);
});

Deno.test("attached-only accepts =value and consumes nothing when bare", () => {
  const bare = parseArgv(ctxOf("demo", "demo --color pat a.txt"), DEMO);
  assertEquals(bare.unknownFlag, null);
  assertEquals(bare.pathOperands.map((w) => w.value), ["pat", "a.txt"]);
  const glued = parseArgv(ctxOf("demo", "demo --color=auto a.txt"), DEMO);
  assertEquals(glued.unknownFlag, null);
  assertEquals(glued.pathOperands.map((w) => w.value), ["a.txt"]);
});

Deno.test("an unknown flag is reported, never silently skipped", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo --nope"), DEMO).unknownFlag, "--nope");
  assertEquals(parseArgv(ctxOf("demo", "demo -bZ"), DEMO).unknownFlag, "-Z");
  assertEquals(parseArgv(ctxOf("demo", "demo -b=1"), DEMO).unknownFlag, "-b");
});

Deno.test("numericShorthand is opt-in and must be the entire token", () => {
  const HEAD: CommandSpec = {
    flags: [{ name: "-n", value: "required" }],
    positionals: "paths",
    numericShorthand: true,
  };
  // 整個 token 是 `-` 加數字 → 接受
  assertEquals(parseArgv(ctxOf("head", "head -100"), HEAD).unknownFlag, null);
  // 形式不符 → 落入群集掃描，回報第一個未知字母旗標（不是整個 token）
  assertEquals(parseArgv(ctxOf("head", "head -100x"), HEAD).unknownFlag, "-1");
  // 未開啟 numericShorthand 的指令：數字同樣落入群集掃描
  assertEquals(parseArgv(ctxOf("demo", "demo -100"), DEMO).unknownFlag, "-1");
});

Deno.test("positionals: pattern-then-paths drops only the first", () => {
  const GREP: CommandSpec = { flags: [{ name: "-E", value: "none" }], positionals: "pattern-then-paths" };
  const r = parseArgv(ctxOf("grep", "grep -E pat a.txt b.txt"), GREP);
  assertEquals(r.pathOperands.map((w) => w.value), ["a.txt", "b.txt"]);
  assertEquals(r.nonPathOperands.map((w) => w.value), ["pat"]);
});

Deno.test("a path-valued flag records its value in both forms", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo --from=list"), DEMO).pathValues, ["list"]);
  assertEquals(parseArgv(ctxOf("demo", "demo --from list"), DEMO).pathValues, ["list"]);
});

Deno.test("any dynamic token makes the whole parse dynamic", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w $N"), DEMO).dynamic, true);
  assertEquals(parseArgv(ctxOf("demo", "demo $F"), DEMO).dynamic, true);
});

Deno.test("-- terminates option parsing", () => {
  const r = parseArgv(ctxOf("demo", "demo -- -w"), DEMO);
  assertEquals(r.unknownFlag, null);
  assertEquals(r.pathOperands.map((w) => w.value), ["-w"]);
});

Deno.test("a missing required value is reported, not silently accepted", () => {
  assertEquals(parseArgv(ctxOf("demo", "demo -w"), DEMO).unknownFlag, "-w");
});

Deno.test("seenFlags records every occurrence, in order", () => {
  const r = parseArgv(ctxOf("demo", "demo -b -w 80 --color=auto"), DEMO);
  assertEquals(r.seenFlags.get("-b"), [null]);
  assertEquals(r.seenFlags.get("-w"), ["80"]);
  assertEquals(r.seenFlags.get("--color"), ["auto"]);
  assertEquals(r.seenFlags.has("--width"), false);
  // 重複出現時全部保留，順序即命令列順序
  const rep2 = parseArgv(ctxOf("demo", "demo -w 1 -w 2"), DEMO);
  assertEquals(rep2.seenFlags.get("-w"), ["1", "2"]);
});

Deno.test("an unknown cluster letter does not hide the rest of the cluster", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-r", value: "none" }],
    positionals: "paths",
  };
  const r = parseArgv(ctxOf("demo", "demo -Tr x"), SPEC);
  assertEquals(r.unknownFlag, "-T");       // 仍回報未知旗標
  assertEquals(r.seenFlags.has("-r"), true); // 但 -r 仍被記下，遞迴偵測不會漏
});

Deno.test("the LAST occurrence wins where the command says so", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-d", value: "required" }],
    positionals: "paths",
    recursive: (_n, seen) => (seen.get("-d") ?? []).at(-1) === "recurse",
  };
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip -d recurse x"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -d recurse -d skip x"), SPEC).isRecursive, false);
});

Deno.test("positionals can be derived from seenFlags in the same parse", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-e", value: "required" }, { name: "-i", value: "none" }],
    // 有 -e 時第一個位置參數不是 pattern
    positionals: (seen) => (seen.has("-e") ? "paths" : "pattern-then-paths"),
  };
  assertEquals(
    parseArgv(ctxOf("demo", "demo pat a.txt"), SPEC).pathOperands.map((w) => w.value),
    ["a.txt"],
  );
  assertEquals(
    parseArgv(ctxOf("demo", "demo -e pat a.txt"), SPEC).pathOperands.map((w) => w.value),
    ["a.txt"],
  );
  assertEquals(
    parseArgv(ctxOf("demo", "demo -e pat"), SPEC).pathOperands.length,
    0,
  );
});

Deno.test("recursive is derived from seenFlags, including value-bearing forms", () => {
  const SPEC: CommandSpec = {
    flags: [{ name: "-d", value: "required" }, { name: "--directories", value: "required" }],
    positionals: "paths",
    recursive: (_n, seen) =>
      (seen.get("-d") ?? []).at(-1) === "recurse" ||
      (seen.get("--directories") ?? []).at(-1) === "recurse",
  };
  assertEquals(parseArgv(ctxOf("demo", "demo -d recurse"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo --directories=recurse"), SPEC).isRecursive, true);
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip"), SPEC).isRecursive, false);
  // 重複出現：以最後一次為準
  assertEquals(parseArgv(ctxOf("demo", "demo -d skip -d recurse"), SPEC).isRecursive, true);
});

Deno.test("parseArgv memoizes per RuleContext so both consumers share one result", () => {
  const ctx = ctxOf("demo", "demo -w 80 a.txt");
  assertEquals(parseArgv(ctx, DEMO) === parseArgv(ctx, DEMO), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/command_spec_test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/rules/command_spec.ts`**

```ts
import type { Word } from "../deps.ts";
import type { RuleContext } from "./types.ts";
import { staticValue } from "../engine/word.ts";

/**
 * 旗標吃值的方式：
 *  - "none"：不吃值；帶 `=value` 視為未知形式（保守）。
 *  - "required"：一定吃一個值。支援 `--opt value` / `--opt=value` / `-xvalue`。
 *  - "attached-only"：值為選填，且**只接受黏在 `=` 後面**；裸寫時不吃下一個 token
 *    （GNU grep 的 `--color` 即此形態：`grep --color pat f.txt` 不會吃掉 pat）。
 */
export type FlagValueKind = "none" | "required" | "attached-only";

/** 單一旗標的完整描述：一個旗標只在此描述一次。 */
export interface FlagSpec {
  /** 旗標 token（`-x` 或 `--long`）。短旗標與長旗標各自列一筆。 */
  name: string;
  value: FlagValueKind;
  /** 該值是否為會被讀取的路徑（需做範圍檢查）。僅對 "required" 有意義。 */
  valueIsPath?: boolean;
}

/**
 * 位置參數語義：
 *  - "paths"：全部是會被讀取的檔案路徑。
 *  - "pattern-then-paths"：第一個是 pattern（不是路徑），其餘是路徑。
 */
export type PositionalKind = "paths" | "pattern-then-paths";

/**
 * 旗標名 → 其**所有**出現的值（無值旗標記 null）。
 * 保留全部出現而非只留第一個，因為部分指令以**最後一次**為準
 * （`grep -d skip -d recurse` 實際生效的是 recurse）。
 */
export type SeenFlags = Map<string, (string | null)[]>;

export interface CommandSpec {
  flags: FlagSpec[];
  /**
   * 位置參數語義。可為函式，依**已解析的旗標**動態決定
   * （grep：給了 -e / -f 時第一個位置參數從 PATTERN 變回 FILE）。
   * 傳入的 seenFlags 來自同一次解析，故不會與旗標分類漂移。
   */
  positionals: PositionalKind | ((seenFlags: SeenFlags) => PositionalKind);
  /**
   * 是否支援 legacy 數字短旗標（head -100 / tail -200）。
   * 僅在明確開啟時接受，且**整個 token** 必須是 `-` 加數字；`-100x` 視為未知旗標。
   */
  numericShorthand?: boolean;
  /**
   * 此次呼叫是否遞迴遍歷（用於危險根偵測與 cwd 豁免排除）。
   * 傳入同一次解析的 seenFlags，故 `--directories=recurse`、`-d recurse` 等
   * 「靠旗標值才成立」的遞迴形式也能正確判定。
   */
  recursive?: (name: string, seenFlags: SeenFlags) => boolean;
}

export interface ArgvParse {
  /** 需做 resolvePath 的位置參數。 */
  pathOperands: Word[];
  /** 非路徑的位置參數（pattern 等）。 */
  nonPathOperands: Word[];
  /** 吃路徑值的旗標所帶的值，需做 resolvePathValue。 */
  pathValues: string[];
  /** 第一個未列入 spec、或形式不符的旗標 token；全部正常時為 null。 */
  unknownFlag: string | null;
  /** argv 中是否有任何非靜態 token。 */
  dynamic: boolean;
  /** 此次呼叫是否遞迴遍歷（由 spec 的 recursive 依「已解析的旗標與值」判定）。 */
  isRecursive: boolean;
  /** 已解析到的旗標：name → 其所有出現的值（無值旗標為 null）。供規則做語義判斷。 */
  seenFlags: SeenFlags;
}

/**
 * 每個 RuleContext 只解析一次。classify 對單一葉指令只建構一個 RuleContext，
 * 並把同一個物件傳給 evaluate 與 cwdIndependent，故兩者拿到的是**同一份**解析結果。
 */
const CACHE = new WeakMap<RuleContext, ArgvParse>();

export function parseArgv(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const result = doParse(ctx, spec);
  CACHE.set(ctx, result);
  return result;
}

function doParse(ctx: RuleContext, spec: CommandSpec): ArgvParse {
  const find = (name: string) => spec.flags.find((f) => f.name === name);
  const argv = ctx.argv;
  const positional: Word[] = [];
  const pathValues: string[] = [];
  /**
   * 已解析到的旗標 → 其**所有**出現的值（無值旗標記一個 null）。
   * 必須保留全部而非只留第一個：`grep -d skip -d recurse` 中生效的是**後者**，
   * 只留第一個會漏判遞迴、進而錯誤豁免。
   */
  const seenFlags = new Map<string, (string | null)[]>();
  const see = (name: string, value: string | null) => {
    const arr = seenFlags.get(name);
    if (arr) arr.push(value);
    else seenFlags.set(name, [value]);
  };
  let unknownFlag: string | null = null;
  let dynamic = false;
  let optionsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") { positional.push(argv[i]); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      const f = find(name);
      if (!f) { unknownFlag ??= name; continue; }
      if (f.value === "none") {
        if (inline !== null) unknownFlag ??= name;
        else see(name, null);
        continue;
      }
      if (f.value === "attached-only") { see(name, inline); continue; } // 裸寫不吃下一 token
      let value = inline;
      if (value === null) {
        i++;
        if (i >= argv.length) { unknownFlag ??= name; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; continue; }
      }
      see(name, value);
      if (f.valueIsPath) pathValues.push(value);
      continue;
    }

    // legacy 數字短旗標：整個 token 必須是 `-` 加數字
    if (spec.numericShorthand && /^-[0-9]+$/.test(t)) continue;

    // 短旗標群集：逐字母；吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      const f = find(short);
      if (!f) {
        unknownFlag ??= short;
        // 未知字母不中止遞迴偵測：把群集剩餘的每個字母都記進 seenFlags，
        // 否則 `grep -Tr x /`（-T 未列入）會漏掉 -r，使既有的硬 deny 降級成 ask。
        for (let m = k; m < t.length; m++) see(`-${t[m]}`, null);
        ate = true;
        break;
      }
      if (f.value === "none") {
        // `-b=1` 這種形式不合法，保守視為未知
        if (t[k + 1] === "=") { unknownFlag ??= short; ate = true; break; }
        see(short, null);
        continue;
      }
      if (f.value === "attached-only") { see(short, null); continue; }
      const rest = t.slice(k + 1);
      let value: string | null = rest;
      if (rest === "") {
        i++;
        if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
        value = staticValue(argv[i]);
        if (value === null) { dynamic = true; ate = true; break; }
      }
      see(short, value);
      if (f.valueIsPath && value !== null) pathValues.push(value);
      ate = true;
      break;
    }
    if (ate) continue;
  }

  const kind = typeof spec.positionals === "function"
    ? spec.positionals(seenFlags)
    : spec.positionals;
  let pathOperands = positional;
  let nonPathOperands: Word[] = [];
  if (kind === "pattern-then-paths" && positional.length > 0) {
    nonPathOperands = positional.slice(0, 1);
    pathOperands = positional.slice(1);
  }

  return {
    pathOperands,
    nonPathOperands,
    pathValues,
    unknownFlag,
    dynamic,
    isRecursive: spec.recursive?.(ctx.name, seenFlags) ?? false,
    seenFlags,
  };
}
```

- [ ] **Step 4: Run the tests, type check and lint**

Run: `deno test --allow-env src/rules/command_spec_test.ts && deno task check && deno task lint`
Expected: PASS / no errors. Nothing consumes `CommandSpec` yet, so the full suite is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/rules/command_spec.ts src/rules/command_spec_test.ts
git commit -m "feat(rules): add CommandSpec + memoized single-parse parseArgv"
```

---

### Task 7: `grep` — PATTERN is not a path, on top of `CommandSpec`

**Files:**
- Modify: `src/rules/factory.ts`, `src/rules/commands/grep.ts`, `src/rules/allowlist.ts`
- Test: `src/rules/commands/grep_test.ts`

`flagGatedReader` gains **optional** `spec` support: a rule that supplies `spec` gets
`CommandSpec`-driven classification plus the exemption predicate; a rule that does not keeps
today's `valueFlags` / `pathValueFlags` path exactly. Only `grep` uses it in this task.

- [ ] **Step 1: Write the failing tests, and fix the one existing assertion that changes**

In `src/rules/commands/grep_test.ts`, the test `"grep 非遞迴碰根 -> 非 deny"` asserts
`grep / file` → `ask`. With PATTERN excluded from path checks, `/` is the pattern and `file` is
in-project, so the correct expectation becomes `allow` (still not `deny`, which is what that test
is about). Update that line and add a comment:

```ts
Deno.test("grep 非遞迴碰根 -> 非 deny", () => {
  // `/` 是 PATTERN 不是路徑；`file` 在專案內 → allow（重點是「不是 deny」）
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep / file")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep x /")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");
});
```

**Migrate the existing `rg` assertions to `rgRule`.** `grepRule.names` no longer contains `"rg"`,
so any assertion of the form `grepRule.evaluate(ctxOf("rg", …))` now tests the wrong rule, and an
alias assertion listing `"rg"` under `grepRule.names` fails. In `grep_test.ts`:

```ts
import { grepRule, rgRule } from "./grep.ts";

// 既有 "grep 非遞迴碰根 -> 非 deny" 中的 rg 斷言
assertEquals(rgRule.evaluate(ctxOf("rg", "rg foo ./src")).kind, "allow");

// 既有遞迴 deny 測試中的 rg 斷言
assertEquals(rgRule.evaluate(ctxOf("rg", "rg x ~")).kind, "deny");

// grep_test.ts:34 的 "rg -A value skipped, in-project allows" 斷言
assertEquals(rgRule.evaluate(ctxOf("rg", "rg -A 3 pattern src")).kind, "allow");
```

If the exact command at line 34 differs, keep it verbatim and only swap `grepRule` for `rgRule`.

`grep_test.ts:39` asserts `grepRule.names.includes("rg") === true`. Replace that line:

```ts
// before
  assertEquals(grepRule.names.includes("rg"), true);
// after
  assertEquals(grepRule.names.includes("rg"), false);
  assertEquals(rgRule.names.includes("rg"), true);
```

Line 38's `grepRule.names.includes("egrep")` assertion stays as it is.

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
  // 群集內的 -e 帶黏寫值（含標點 / 數字）也必須算「pattern 由旗標提供」
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -rex.y ../outside.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -ie1 ../outside.txt")).kind, "ask");
});

Deno.test("--color does not consume the pattern", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color pat ../secret.txt")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --color=auto pat a.txt")).kind, "allow");
});

Deno.test("--exclude-from is scope-checked in both forms", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=ex.txt pat a.txt")).kind, "allow");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from=../out.txt pat")).kind, "ask");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --exclude-from ../out.txt pat")).kind, "ask");
});

Deno.test("a recursive root deny still wins over a path-value ask", () => {
  assertEquals(
    grepRule.evaluate(ctxOf("grep", "grep -r x / --exclude-from=../out.txt")).kind,
    "deny",
  );
});

Deno.test("unknown grep flags ask", () => {
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --totally-unknown pat")).kind, "ask");
});

Deno.test("value-bearing recursive forms are detected", () => {
  // --directories=recurse / -d recurse 讓 grep 在無操作元時搜尋 cwd
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep --directories=recurse x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d recurse x ~")).kind, "deny");
  // 重複出現以最後一次為準
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d skip -d recurse x /")).kind, "deny");
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -d recurse -d skip x /")).kind, "ask");
});

Deno.test("an unknown cluster letter does not lose a recursion flag", () => {
  // -T 未列入旗標表，但 -r 仍須被偵測到，否則既有硬 deny 會降級成 ask
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -Tr x /")).kind, "deny");
});

Deno.test("a recursion flag consumed as a flag value still counts (union with raw scan)", () => {
  // `-r` 在此是 `-e` 的 pattern 值，旗標感知解析不會把它記進 seenFlags；
  // 既有實作靠 raw 掃描判定為遞迴並 deny `/`，此行為必須保留
  assertEquals(grepRule.evaluate(ctxOf("grep", "grep -e -r /")).kind, "deny");
});

Deno.test("the pattern flag is detected from the same parse, not a separate scan", () => {
  // `--label -- -e pat` 中的 `--` 是 --label 的值；-e pat 之後 /etc/passwd 仍是 FILE
  assertEquals(
    grepRule.evaluate(ctxOf("grep", "grep --label -- -e pat /etc/passwd")).kind,
    "ask",
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: FAIL.

- [ ] **Step 3: Add optional `spec` support to `src/rules/factory.ts`**

Add to `FlagGatedReaderOptions`:

```ts
  /**
   * 選填：改由 CommandSpec 驅動 argv 分類（每個旗標只描述一次）。
   * 提供 spec 時，valueFlags / pathValueFlags 不再使用，並可 opt-in cwd 豁免述詞。
   * 未提供時，行為與既有完全相同。
   */
  spec?: (name: string, argv: Word[]) => CommandSpec | undefined;
  /** opt-in：spec 解析後無路徑操作元 / 路徑值、非遞迴、旗標全已知時視為 cwd 無關。 */
  cwdIndependentWhenNoPaths?: boolean;
  /** 上述 opt-in 的例外名單（隱含以 cwd 為操作對象者，如 ls）。 */
  cwdDependentNames?: string[];
```

Add the spec-driven evaluation path inside `flagGatedReader`, keeping the legacy path untouched:

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
}
```

and in the returned object:

```ts
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      const spec = opts.spec?.(ctx.name, ctx.argv);
      if (spec) return evaluateWithSpec(ctx, spec);
      // …既有的 legacy 路徑完全不動…
    },
    cwdIndependent: opts.cwdIndependentWhenNoPaths
      ? (ctx: RuleContext) => {
        if ((opts.cwdDependentNames ?? []).includes(ctx.name)) return false;
        const spec = opts.spec?.(ctx.name, ctx.argv);
        if (!spec) return false; // 無 spec → 不豁免（default-deny）
        const p = parseArgv(ctx, spec); // 與 evaluate 同一份快取結果
        return !p.isRecursive && !p.dynamic && p.unknownFlag === null &&
          p.pathOperands.length === 0 && p.pathValues.length === 0;
      }
      : undefined,
```

Add the imports: `import { type CommandSpec, parseArgv } from "./command_spec.ts";` and
`import type { Word } from "../deps.ts";` (if not already present).

- [ ] **Step 4: Rewrite `src/rules/commands/grep.ts`**

Both the recursion decision and the pattern-position decision are derived from the **same**
`seenFlags` map the parser produced — nothing rescans argv.

```ts
import type { CommandRule } from "../types.ts";
import type { Word } from "../../deps.ts";
import type { CommandSpec, FlagSpec, SeenFlags } from "../command_spec.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, type FlagMatcher, hasAnyFlag } from "../flags.ts";

/** 既有常數，原樣保留：短旗標群集含 r/R（如 -rn、-Rl）代表遞迴。 */
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

/** 既有常數，原樣保留：rgRule 仍使用。 */
const VALUE_FLAGS = [
  exact(
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-d", "--directories", "--color", "--colour",
    "-r", "--replace", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-M",
  ),
];

/**
 * GNU grep 3.0 的旗標。`--color` / `--colour` 的值是選填且只接受黏寫（`--color=auto`），
 * 裸寫時不吃下一個 token —— 若誤設為吃值，`grep --color pat file` 會把 pat 當成它的值、
 * 讓真正的輸入檔被當成 PATTERN 而跳過範圍檢查。
 */
const NO_VALUE = [
  "-E", "--extended-regexp", "-F", "--fixed-strings", "-G", "--basic-regexp",
  "-P", "--perl-regexp", "-i", "--ignore-case", "-y", "-v", "--invert-match",
  "-w", "--word-regexp", "-x", "--line-regexp", "-c", "--count",
  "-l", "--files-with-matches", "-L", "--files-without-match", "-o", "--only-matching",
  "-q", "--quiet", "--silent", "-s", "--no-messages", "-n", "--line-number",
  "-b", "--byte-offset", "-H", "--with-filename", "-h", "--no-filename",
  "-a", "--text", "-I", "-z", "--null-data", "-Z", "--null", "-U", "--binary",
  "-r", "-R", "--recursive", "--dereference-recursive", "--help", "-V", "--version",
];
const ATTACHED_ONLY = ["--color", "--colour"];
const NON_PATH_VALUE = [
  "-m", "--max-count", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-d", "--directories", "--binary-files", "--label",
  "-e", "--regexp", "--include", "--exclude", "--devices",
];
const PATH_VALUE = ["-f", "--file", "--exclude-from"];

const flags: FlagSpec[] = [
  ...NO_VALUE.map((name): FlagSpec => ({ name, value: "none" })),
  ...ATTACHED_ONLY.map((name): FlagSpec => ({ name, value: "attached-only" })),
  ...NON_PATH_VALUE.map((name): FlagSpec => ({ name, value: "required" })),
  ...PATH_VALUE.map((name): FlagSpec => ({ name, value: "required", valueIsPath: true })),
];

/** 由 -e / --regexp / -f / --file 是否出現決定第一個位置參數是 PATTERN 還是 FILE。 */
function positionalsFor(seen: SeenFlags): "paths" | "pattern-then-paths" {
  const byFlag = seen.has("-e") || seen.has("--regexp") ||
    seen.has("-f") || seen.has("--file");
  return byFlag ? "paths" : "pattern-then-paths";
}

/**
 * 遞迴偵測。三種來源都要算進去：
 *  - 旗標本身（`-r` / `-R` / `--recursive` / `--dereference-recursive`，群集寫法由
 *    parser 逐字母展開後也會出現在 seenFlags）；
 *  - `-d recurse` / `--directories=recurse` —— 靠**值**才成立的遞迴；
 *  - `rg` 恆為遞迴。
 * 無操作元時 grep 在遞迴模式下會搜尋 cwd，故此判定同時用於危險根 deny 與 cwd 豁免排除。
 */
function recursiveFor(name: string, seen: SeenFlags, argv: Word[]): boolean {
  if (name === "rg") return true;
  for (const f of ["-r", "-R", "--recursive", "--dereference-recursive"]) {
    if (seen.has(f)) return true;
  }
  // -d / --directories 以**最後一次**出現為準（`grep -d skip -d recurse` 會遞迴）
  if ((seen.get("-d") ?? []).at(-1) === "recurse") return true;
  if ((seen.get("--directories") ?? []).at(-1) === "recurse") return true;
  // 保留既有的 raw-token 掃描作為**聯集**，不可省略。
  // 旗標感知解析會把某些 token 當成前一個旗標的值而不計入 seenFlags —— 例如
  // `grep -e -r /` 的 `-r` 是 `-e` 的 pattern 值。既有實作以 raw 掃描判定為遞迴、
  // 進而對 `/` 回硬 deny；若只依 seenFlags，該硬 deny 會降級成 ask。
  // 兩者取聯集 → 只會多判遞迴（更嚴），不會少判。
  return hasAnyFlag(argv, [
    exact("-r", "-R", "--recursive", "--dereference-recursive"),
    shortClusterHasR,
  ]);
}

function specFor(_name: string, argv: Word[]): CommandSpec {
  return {
    flags,
    positionals: positionalsFor,
    recursive: (name, seen) => recursiveFor(name, seen, argv),
  };
}

export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep"],
  spec: specFor,
  cwdIndependentWhenNoPaths: true,
});
```

> **`rg` keeps the legacy path.** It is intentionally absent from `names` above; register it
> separately with the existing `flagGatedReader` options so its flag handling is unchanged:
>
> ```ts
> export const rgRule: CommandRule = flagGatedReader({
>   names: ["rg"],
>   valueFlags: VALUE_FLAGS,          // 既有常數，原樣保留
>   pathValueFlags: ["-f", "--file"], // 既有設定，原樣保留
>   recursive: () => true,
> });
> ```
>
> Register `rgRule` in `allowlist.ts` next to `grepRule`. `rg` never opts into the exemption
> (always recursive), and this keeps the change from touching ripgrep's flag grammar at all —
> modelling it was never required, since it is not one of the declaring commands.

- [ ] **Step 5: Register `rgRule` in `src/rules/allowlist.ts`**

This must happen **before** the full-suite run: Step 4 removed `"rg"` from `grepRule.names`, and
`allowlist_test.ts` requires `lookupRule("rg")` to resolve.

```ts
import { grepRule, rgRule } from "./commands/grep.ts";

const RULES: CommandRule[] = [
  // …
  grepRule,
  rgRule,
  // …
];
```

`allowlist.ts` throws on duplicate names, so a clean load proves `rg` left `grepRule.names`.

- [ ] **Step 6: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/grep.ts src/rules/commands/grep_test.ts src/rules/allowlist.ts
git commit -m "fix(rules): grep PATTERN is not a path; --color takes no separate value; rg keeps legacy handling"
```

---

### Task 8: extract `jq` into its own rule

**Files:**
- Create: `src/rules/commands/jq.ts`, `src/rules/commands/jq_test.ts`
- Modify: `src/rules/commands/coreutils.ts` (drop `"jq"` from `fileReaderRule` names), `src/rules/allowlist.ts`

**Three verified jq facts the parser must honor** (see the Conventions table):
`-f`/`--from-file` is **boolean** and makes the **first positional** the program file regardless of
where the flag appears; `-L` accepts an **attached** value; every consumed value must still be
static.

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
/** 取 ask 的理由字串，用來驗證「哪個 token 被當成什麼」。 */
const why = (src: string) => {
  const r = jqRule.evaluate(ctxOf(src));
  return r.kind === "ask" ? r.reason : "";
};

Deno.test("jq filter is not treated as a path", () => {
  assertEquals(v("jq -r '.[] | select(.type==\"file\") | .name'"), "allow");
  assertEquals(v("jq ."), "allow");
  assertEquals(v("jq '/etc/passwd'"), "allow");
});

Deno.test("jq input files are scope-checked", () => {
  assertEquals(v("jq . data.json"), "allow");
  assertEquals(v("jq . ../outside.json"), "ask");
});

Deno.test("-f makes the FIRST POSITIONAL the program file, wherever -f appears", () => {
  // 路徑檢查先行，故理由字串能證明「哪個 token 被當成 program 檔」。
  // 專案外的 program 檔 → 理由是路徑超範圍，且必須指名該 token
  assertEquals(v("jq -f ../outside.jq data.json"), "ask");
  assertEquals(why("jq -f ../outside.jq data.json").includes("../outside.jq"), true);
  // 旗標寫在位置參數之後也一樣：第一個位置參數才是 program 檔
  assertEquals(why("jq ../outside.jq -f data.json").includes("../outside.jq"), true);
  // -fn 是 -f -n：program 檔仍是第一個位置參數
  assertEquals(why("jq -fn ../outside.jq").includes("../outside.jq"), true);

  // 路徑落在專案內 → 通過路徑檢查，改因「內容不可檢查」而 ask（fail-closed）
  assertEquals(v("jq -f prog.jq data.json"), "ask");
  assertEquals(why("jq -f prog.jq data.json").includes("內容無法檢查"), true);
  assertEquals(v("jq prog.jq --from-file data.json"), "ask");
  assertEquals(v("jq -fn prog.jq"), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -f prog.jq")), false);
});

Deno.test("with -f, the remaining positionals are still checked as input files", () => {
  // data.json 之後的 ../outside.json 是輸入檔，其路徑必須先於 -f 的 fail-closed ask 被回報
  assertEquals(why("jq -f prog.jq ../outside.json").includes("../outside.json"), true);
});

Deno.test("-L accepts an attached value", () => {
  assertEquals(v("jq -L mods '.' data.json"), "allow");
  assertEquals(v("jq -Lmods '.' data.json"), "allow");
  assertEquals(v("jq -L ../outside/mods '.'"), "ask");
  assertEquals(v("jq -L../outside/mods '.'"), "ask");
  // -Ln '.' data.json：`n` 是 -L 的值，`.` 是 filter，data.json 是輸入
  assertEquals(v("jq -Ln '.' data.json"), "allow");
  assertEquals(v("jq -Ln '.' ../outside.json"), "ask");
});

Deno.test("two-value flags scope-check only the file half", () => {
  assertEquals(v("jq --rawfile n data.txt '.'"), "allow");
  assertEquals(v("jq --rawfile n ../outside.txt '.'"), "ask");
  assertEquals(v("jq --slurpfile n ../outside.json '.'"), "ask");
  assertEquals(v("jq --arg name ../outside '.'"), "allow");
  assertEquals(v("jq --argjson n 1 '.'"), "allow");
});

Deno.test("every consumed value must be static", () => {
  assertEquals(v("jq --arg n $V '.'"), "ask");
  assertEquals(v("jq --indent $N '.'"), "ask");
  assertEquals(v("jq --rawfile $N f.txt '.'"), "ask");
  assertEquals(v("jq -L $D '.'"), "ask");
});

Deno.test("--args affects only subsequent positionals", () => {
  assertEquals(v("jq -n '$ARGS.positional' --args ../outside a"), "allow");
  assertEquals(v("jq . ../outside.json --args x"), "ask");
  // 重複 --args：保留第一次的邊界，之後的值仍是資料
  assertEquals(v("jq -n '.' --args ../outside --args x"), "allow");
});

Deno.test("--args cannot hide the -f program file", () => {
  // jq 仍把第一個位置參數當 program 檔讀取，即使 --args 先出現。
  // 理由字串證明它確實被當成路徑檢查，而不是被當成資料字串跳過。
  assertEquals(why("jq --args -f ../outside.jq").includes("../outside.jq"), true);
  assertEquals(v("jq --args -f prog.jq"), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq --args -f prog.jq")), false);
});

Deno.test("jq unknown flags and dynamic tokens ask", () => {
  assertEquals(v("jq --totally-unknown ."), "ask");
  assertEquals(v("jq $FILTER"), "ask");
});

Deno.test("-- terminates option parsing", () => {
  assertEquals(v("jq -- . data.json"), "allow");
  assertEquals(v("jq -- . ../outside.json"), "ask");
});

Deno.test("a filter that loads modules reads files relative to cwd", () => {
  // 實測：jq -n 'include "secret" {search:"."}; s' 會讀出 ./secret.jq 的內容
  assertEquals(v(`jq -n 'include "m" {search:"."}; s'`), "ask");
  assertEquals(v(`jq -n 'import "m" as $x {search:"."}; $x::s'`), "ask");
  assertEquals(jqRule.cwdIndependent!(ctxOf(`jq -n 'include "m" {search:"."}; s'`)), false);
  // 一般 filter 不受影響
  assertEquals(v("jq -r '.name'"), "allow");
});

Deno.test("jq cwdIndependent requires zero inputs and no path flag", () => {
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name'")), true);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -r '.name' a.json")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -f prog.jq")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -L mods '.'")), false);
  assertEquals(jqRule.cwdIndependent!(ctxOf("jq -n '$ARGS.positional' --args a b")), true);
});
```

- [ ] **Step 2: Run them to verify they fail**

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
  // --from-file 是布林：它不吃檔名，只把「第一個位置參數」的語義改成 program 檔路徑
  "--from-file",
]);
const NO_VALUE_SHORT = new Set([
  "n", "R", "s", "c", "r", "j", "a", "S", "C", "M", "e", "b", "V", "h",
  "f", // -f 同 --from-file：布林
]);
const ONE_NON_PATH = new Set(["--indent"]);
/** 吃一個路徑值；短形式接受黏寫（`-Lmods` 等於 `-L mods`）。 */
const ONE_PATH = new Set(["-L", "--library-path"]);
const TWO_NON_PATH = new Set(["--arg", "--argjson"]);
/** 吃兩個值，第二個是路徑。 */
const TWO_SECOND_PATH = new Set(["--slurpfile", "--rawfile"]);

interface JqScan {
  /** 需做範圍檢查的路徑：program 檔（-f 時的第一個位置參數）＋ 輸入檔。 */
  paths: Word[];
  /** filter 字串（未由 -f 提供時）；無法靜態取得或由 -f 提供時為 null。 */
  filter: string | null;
  /** program 是否由 -f / --from-file 從檔案載入（其內容本工具讀不到）。 */
  programFromFile: boolean;
  /** 吃路徑值的旗標帶的值（字串）。 */
  pathValues: string[];
  /** 是否用過任何吃路徑的旗標，或 -f（program 檔本身就是路徑）。 */
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
  const positional: Word[] = [];
  const pathValues: string[] = [];
  let pathFlagUsed = false;
  let unknownFlag: string | null = null;
  let dynamic = false;
  let fromFile = false;
  /** --args / --jsonargs 出現之後才生效，故記下它出現時已有幾個位置參數。 */
  let argsModeFrom = -1;
  let optionsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") { positional.push(argv[i]); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (NO_VALUE_LONG.has(name)) {
        if (inline !== null) { unknownFlag ??= name; continue; }
        if (name === "--from-file") fromFile = true;
        // 重複出現時保留**第一次**的邊界；之後的值一律是資料，不會變回檔案
        if ((name === "--args" || name === "--jsonargs") && argsModeFrom < 0) {
          argsModeFrom = positional.length;
        }
        continue;
      }
      if (ONE_NON_PATH.has(name) || ONE_PATH.has(name)) {
        let value = inline;
        if (value === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; continue; }
        }
        if (ONE_PATH.has(name)) { pathValues.push(value); pathFlagUsed = true; }
        continue;
      }
      if (TWO_NON_PATH.has(name) || TWO_SECOND_PATH.has(name)) {
        // 第一個值：inline 或下一 token
        let first = inline;
        if (first === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          first = staticValue(argv[i]);
          if (first === null) dynamic = true;
        }
        // 第二個值：一定是下一 token
        i++;
        if (i >= argv.length) { unknownFlag ??= name; break; }
        const second = staticValue(argv[i]);
        if (second === null) dynamic = true;
        else if (TWO_SECOND_PATH.has(name)) { pathValues.push(second); pathFlagUsed = true; }
        continue;
      }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：`-f` 是布林；`-L` 吃值且接受黏寫（-Lmods）
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (NO_VALUE_SHORT.has(c)) { if (c === "f") fromFile = true; continue; }
      const short = `-${c}`;
      if (ONE_PATH.has(short)) {
        const rest = t.slice(k + 1);
        let value: string | null = rest;
        if (rest === "") {
          i++;
          if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; ate = true; break; }
        }
        if (value !== null) { pathValues.push(value); pathFlagUsed = true; }
        ate = true;
        break;
      }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 位置參數語義：
  //  - 無 -f：第一個是 filter（不是路徑），其餘是輸入檔；
  //  - 有 -f：第一個是 program **檔案路徑**，其餘是輸入檔；
  //  - --args / --jsonargs 之後出現的位置參數是字串，不是檔案。
  //
  // 關鍵：program 檔的判定**不受 argsMode 影響**。`jq --args -f prog.jq` 中 --args 先出現，
  // 但 jq 仍把第一個位置參數當 program 檔讀取，故它必須無條件納入路徑檢查。
  // filter 僅在「未給 -f」時才是第一個位置參數的內容
  const filter = !fromFile && positional.length > 0 ? staticValue(positional[0]) : null;

  const paths: Word[] = [];
  if (fromFile) {
    if (positional.length > 0) { paths.push(positional[0]); pathFlagUsed = true; }
    // -f 本身即代表「要讀一個 program 檔」，即使該位置參數缺席也標記
    pathFlagUsed = true;
  }
  // 輸入檔：跳過第一個位置參數（filter 或 program 檔），並止於 argsMode 生效處
  const inputStart = 1;
  const inputEnd = argsModeFrom >= 0 ? Math.max(argsModeFrom, inputStart) : positional.length;
  for (let k = inputStart; k < inputEnd; k++) paths.push(positional[k]);

  return { paths, filter, programFromFile: fromFile, pathValues, pathFlagUsed, unknownFlag, dynamic };
}

/**
 * filter 是否含會讀檔的模組構造。
 * `include "m" {search:"."};` 與 `import "m" as $x {search:"."};` 會以 cwd（或 search
 * 指定的目錄）為基準載入 `m.jq` —— 實測 `jq -n 'include "secret" {search:"."}; s'`
 * 確實讀到並輸出了 ./secret.jq 的內容。本工具無法靜態確認其目標落在專案內，故一律 ask。
 * 採保守詞法比對，寧可誤 ask。
 */
function filterReadsModules(filter: string): boolean {
  return /\b(include|import)\b/.test(filter);
}

export const jqRule: CommandRule = {
  names: ["jq"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const r = scan(ctx);
    if (r.dynamic) return ask("jq：含動態 token，無法靜態判定");
    if (r.unknownFlag !== null) return ask(`jq：未列入安全集合的旗標 ${r.unknownFlag}`);
    if (r.filter !== null && filterReadsModules(r.filter)) {
      return ask("jq：filter 含 include / import，會以 cwd 為基準載入 .jq 模組檔");
    }
    // 路徑檢查先行，使理由字串能區分「路徑超範圍」與「路徑合法但內容不可檢查」，
    // 也讓「哪個位置參數被當成 program 檔」可由理由驗證。
    for (const v of r.pathValues) {
      if (ctx.resolvePathValue(v) !== "in-project") {
        return ask(`jq：旗標的路徑值超出專案範圍或無法解析（${v}）`);
      }
    }
    for (const p of r.paths) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`jq：路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    // -f 由檔案載入 program，本工具讀不到其內容，無法執行上面的 include / import 掃描。
    // 落在專案內的 prog.jq 仍可 include 專案外的模組 → fail-closed。
    if (r.programFromFile) {
      return ask("jq：-f 的 program 檔內容無法檢查是否含 include / import");
    }
    return allow();
  },
  /**
   * filter 不是路徑；無任何路徑（含 program 檔）、未用到吃路徑的旗標、
   * 且 filter 不含會讀檔的 include / import 時，與 cwd 無關。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scan(ctx);
    if (r.dynamic || r.unknownFlag !== null || r.programFromFile) return false;
    if (r.filter !== null && filterReadsModules(r.filter)) return false;
    return r.paths.length === 0 && !r.pathFlagUsed;
  },
};
```

- [ ] **Step 4: Remove `jq` from `fileReaderRule` and register the new rule**

Both edits land in this task's single commit, so `jq` is never without a rule. The earlier task
that touched `fileReaderRule` deliberately left `"jq"` in place for exactly this reason.

In `src/rules/commands/coreutils.ts`:

```ts
// before
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
// after — "jq" removed
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
```

In `src/rules/allowlist.ts`:

Keep the existing `rgRule` entry — the array below shows it so it is not dropped by accident.

```ts
// add next to the other command imports
import { jqRule } from "./commands/jq.ts";

// add to the RULES array, after grepRule / rgRule
const RULES: CommandRule[] = [
  // …
  grepRule,
  rgRule,
  jqRule,
  gitRule,
  // …
];
```

- [ ] **Step 5: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green. `allowlist.ts` throws on duplicate names, so a clean load also proves `jq`
left `fileReaderRule`.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/jq.ts src/rules/commands/jq_test.ts src/rules/commands/coreutils.ts src/rules/allowlist.ts
git commit -m "feat(rules): extract jq into its own rule; -f is boolean, -L takes an attached value"
```

---

### Task 9: `head` / `wc` / `tail` specs + `pureUtilRule` declaration

**Files:**
- Modify: `src/rules/factory.ts`（新增 `cwdIndependentExtraGuard` 選項）、`src/rules/commands/coreutils.ts`、`src/rules/commands/tail.ts`
- Test: `src/rules/commands/coreutils_test.ts`, `src/rules/commands/tail_test.ts`

Only `head`, `wc`, and `tail` get a `CommandSpec` — every other `fileReaderRule` member keeps the
legacy path and never opts in, so their flag grammars need no modelling.

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/coreutils_test.ts`:

```ts
Deno.test("head / wc non-path flag values are not treated as paths", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head -n 10")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("head -100")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -l")).kind, "allow");
});

Deno.test("head / wc still scope-check their file operands", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head -100 ../out.txt")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -l ../out.txt")).kind, "ask");
});

Deno.test("unknown head / wc flags ask; other members keep legacy behavior", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("head --totally-unknown")).kind, "ask");
  assertEquals(fileReaderRule.evaluate(ctxOf("wc -1unknown")).kind, "ask");
  // cat 沒有 spec，走既有路徑：未知旗標照舊被當一般 flag 跳過
  assertEquals(fileReaderRule.evaluate(ctxOf("cat --totally-unknown a.txt")).kind, "allow");
});

Deno.test("which is never cwd-independent; the other pure utils are", () => {
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("which x")), false);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("echo hi")), true);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("pwd")), true);
  assertEquals(pureUtilRule.cwdIndependent!(ctxOf("whoami")), true);
});

Deno.test("head / wc declare cwd-independence only with no operands", () => {
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("head -100")), true);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("wc -l")), true);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("head -100 a.txt")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("wc --files0-from=list")), false);
  // 未宣告的成員一律 false
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("cat")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("ls")), false);
  assertEquals(fileReaderRule.cwdIndependent!(ctxOf("tr a b")), false);
});
```

`tail_test.ts`'s existing helper is `ctxOf(name: string, src: string)` — the same shape as
`grep_test.ts`. Use both arguments:

```ts
Deno.test("tail numeric shorthand and -n value are not paths", () => {
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -200")).kind, "allow");
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -n 200")).kind, "allow");
});

Deno.test("tail declares cwd-independence only with no operands", () => {
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -200")), true);
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -200 a.txt")), false);
  // -f 時 evaluate 判 ask，護欄 1 因此不會讓它豁免；述詞本身也應回 false
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -f")), false);
});

Deno.test("tail -f still asks", () => {
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -f a.txt")).kind, "ask");
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -f")).kind, "ask");
});
```

If `tail_test.ts` uses a different helper name, keep its convention — the requirement is that the
context is built with `name: "tail"` and the full command string.

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/tail_test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the three specs to `src/rules/commands/coreutils.ts`**

```ts
import type { CommandSpec, FlagSpec } from "../command_spec.ts";

/** head / wc 的旗標表。只有這兩個成員參與 cwd 豁免，故只為它們建模。 */
const HEAD_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-c", "--bytes", "-n", "--lines"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
  numericShorthand: true, // head -100
};

const WC_SPEC: CommandSpec = {
  flags: [
    ...["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    { name: "--files0-from", value: "required", valueIsPath: true },
  ],
  positionals: "paths",
};

const SPECS: Record<string, CommandSpec> = { head: HEAD_SPEC, wc: WC_SPEC };
```

Update `fileReaderRule` (keeping the Task 5 legacy flags for the other members):

```ts
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // head / wc 走 CommandSpec；其餘成員沿用下方 legacy 設定，且一律不參與 cwd 豁免。
  spec: (name) => SPECS[name],
  valueFlags: [exact("--files0-from", "--relative-to", "--relative-base")],
  pathValueFlags: ["--files0-from", "--relative-to", "--relative-base"],
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
  cwdIndependentWhenNoPaths: true,
  // ls 無操作元時列出 cwd。其餘未提供 spec 的成員由「無 spec → 不豁免」自動排除。
  cwdDependentNames: ["ls"],
});
```

Also declare `pureUtilRule`:

```ts
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
```

- [ ] **Step 4: Add the spec to `src/rules/commands/tail.ts`**

Add the type import at the top of `src/rules/commands/tail.ts`:

```ts
import type { CommandSpec, FlagSpec } from "../command_spec.ts";
```

Then:

```ts
const TAIL_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated", "-f", "-F", "--follow", "--retry"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
  numericShorthand: true, // tail -200
};

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  spec: () => TAIL_SPEC,
  askFlags: [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF],
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
  cwdIndependentWhenNoPaths: true,
});
```

`askFlags` runs before the spec path, so `tail -f` asks before any spec parsing. Because
`cwdIndependent` does **not** consult `askFlags`, add an explicit guard so the predicate is
correct on its own rather than relying only on guardrail 1:

```ts
/** follow 模式（-f / -F / --follow / --retry，含群集）一律不豁免。 */
const followFlags = [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF];

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  spec: () => TAIL_SPEC,
  askFlags: followFlags,
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
  cwdIndependentWhenNoPaths: true,
  // 述詞的額外前置條件：從**同一份解析結果**讀 follow 旗標，不另外掃 argv
  cwdIndependentExtraGuard: (p) =>
    !["-f", "-F", "--follow", "--retry"].some((f) => p.seenFlags.has(f)),
});
```

`flagGatedReader` therefore needs one more optional option. Note its parameter is the **parse
result**, not the context — that is what keeps evaluation and the predicate on one parse:

```ts
  /**
   * 述詞的額外前置條件；回 false 即不豁免。供有 askFlags 的規則補上同一條件。
   * 參數是 parseArgv 的結果（與 evaluate 同一份快取），**不是** RuleContext —— 傳 ctx 會
   * 誘使實作重掃 argv，正是單一解析契約要避免的。
   */
  cwdIndependentExtraGuard?: (parse: ArgvParse) => boolean;
```

wired into the predicate after the parse is obtained:

```ts
      ? (ctx: RuleContext) => {
        if ((opts.cwdDependentNames ?? []).includes(ctx.name)) return false;
        const spec = opts.spec?.(ctx.name, ctx.argv);
        if (!spec) return false;
        const p = parseArgv(ctx, spec); // 與 evaluate 同一份快取結果
        if (opts.cwdIndependentExtraGuard && !opts.cwdIndependentExtraGuard(p)) return false;
        return !p.isRecursive && !p.dynamic && p.unknownFlag === null &&
          p.pathOperands.length === 0 && p.pathValues.length === 0;
      }
```

Import `ArgvParse` alongside `CommandSpec` in `factory.ts`. `tail.ts` does **not** need
`hasAnyFlag` for the guard.

- [ ] **Step 5: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/coreutils.ts src/rules/commands/tail.ts src/rules/commands/coreutils_test.ts src/rules/commands/tail_test.ts
git commit -m "feat(rules): CommandSpec for head/wc/tail; declare pureUtilRule cwd-independence"
```

---

### Task 10: `sed` — known-flag allowlist + cwd-independence

**Files:**
- Modify: `src/rules/commands/sed.ts`
- Test: `src/rules/commands/sed_test.ts`

`sed` keeps its hand-written program scanner (its layout is program-then-files, which
`CommandSpec` does not model), but must enforce a known-flag allowlist and, critically, catch
`-f` in **every** form — including clustered and attached (`-nfprog.sed`), which the existing
`ASK_FLAGS` matcher misses.

- [ ] **Step 1: Write the failing tests**

`sed_test.ts` has `ctxOf(src)` but no one-line verdict helper. Add one next to it (and export
`ctxOf` if it is not already exported):

```ts
const v = (src: string) => sedRule.evaluate(ctxOf(src)).kind;
```

Then append:

```ts
Deno.test("unknown sed flags ask", () => {
  assertEquals(v("sed --totally-unknown 'p'"), "ask");
  assertEquals(v("sed -Z 'p'"), "ask");
});

Deno.test("sed -f is caught in every form", () => {
  assertEquals(v("sed -f prog.sed a.txt"), "ask");
  assertEquals(v("sed -fprog.sed a.txt"), "ask");
  assertEquals(v("sed -nfprog.sed a.txt"), "ask"); // 群集 + 黏寫
  assertEquals(v("sed --file=prog.sed a.txt"), "ask");
});

Deno.test("multiple -e expressions are all scanned for side effects", () => {
  assertEquals(v("sed -e 'p' -e 'w out.txt' f.txt"), "ask"); // 第二段寫檔
  assertEquals(v("sed -e 'p' -e '1d' f.txt"), "allow");
});

Deno.test("a separate-value flag does not swallow the program", () => {
  // --line-length 80 之後才是程式碼；若旗標表不一致，80 會被當程式、'w out' 被當輸入檔
  assertEquals(v("sed --line-length 80 'w out' f.txt"), "ask"); // 程式含 w → 寫檔
  assertEquals(v("sed --line-length 80 'p' f.txt"), "allow");
  assertEquals(v("sed -l 80 'p'"), "allow");
});

Deno.test("sed cwdIndependent requires zero input paths and known flags", () => {
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '600,750p'")), true); // 基準集用法
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/g'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p' a.txt")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed --totally-unknown 'p'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -nfprog.sed p")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -i 's/a/b/'")), false);
});

Deno.test("a substitution cannot smuggle a second command past the allowlist", () => {
  // 正則版會因回溯跨越未跳脫的 `/` 而把整段當成一個 s///；逐字掃描不會。
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/;1,2w out.txt'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed 's/a/b/;/x/r secret.txt'`)), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/;s/c/d/'")), false); // 兩條替換也不在白名單
  // 合法的單一替換仍豁免，含非 `/` 分隔符與跳脫的分隔符
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's|a|b|g'")), true);
  // String.raw 才能讓反斜線原樣送進 shell 字串；模板字面值的 `\/` 會退化成 `/`
  assertEquals(sedRule.cwdIndependent!(ctxOf(String.raw`sed 's/a\/b/c/'`)), true);
});

Deno.test("addressed read / write commands never get the exemption", () => {
  // 既有的 programHasSideEffect 是 denylist，漏判這兩種帶位址的形式；
  // 豁免改用 allowlist，故它們一定不豁免（evaluate 的既有判定不在本次變更範圍）。
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed '/x/r secret.txt'`)), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed '1,2w out.txt'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf(`sed '/x/e cmd'`)), false);
  // s/// 帶 w 旗標同樣不在白名單內
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed 's/a/b/w out.txt'")), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/sed_test.ts`
Expected: FAIL — `sed -nfprog.sed a.txt` currently allows.

- [ ] **Step 3: Replace `sed.ts`'s argv handling with one memoized scan**

The whole rule now reads a single `scanSed(ctx)` result. `collectProgram` and `inputPaths` are
folded into it, so there is no second pass with a different flag table — the failure mode where
`SED_ONE_VALUE` knew `--line-length` but `VALUE_FLAGS` did not, and `sed --line-length 80 'w out' f`
parsed `80` as the program.

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import type { Word } from "../../deps.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/** sed 的已知旗標。未列入者一律 ask，故新版 sed 新增的旗標不會被誤放行。 */
const NO_VALUE = new Set([
  "-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate",
  "-u", "--unbuffered", "-z", "--null-data", "--posix", "--debug", "--sandbox",
  "--help", "--version",
]);
const ONE_VALUE = new Set(["-e", "--expression", "-l", "--line-length"]);
/** 會就地寫檔或載入不可見腳本；任何形式（含群集、黏寫）出現即 ask。 */
const UNSAFE = new Set(["-i", "--in-place", "-f", "--file"]);

interface SedScan {
  /** 程式碼片段串接；無法靜態取得時為 null。 */
  program: string | null;
  /** 需做範圍檢查的輸入檔。 */
  inputs: Word[];
  /** 第一個未知旗標。 */
  unknownFlag: string | null;
  /** 是否出現 -i / -f（含群集與黏寫形式）。 */
  unsafe: boolean;
  /** 是否含動態 token。 */
  dynamic: boolean;
}

const CACHE = new WeakMap<RuleContext, SedScan>();

/** 每個 RuleContext 只掃描一次；evaluate 與 cwdIndependent 讀同一份結果。 */
function scanSed(ctx: RuleContext): SedScan {
  const hit = CACHE.get(ctx);
  if (hit) return hit;
  const r = doScanSed(ctx);
  CACHE.set(ctx, r);
  return r;
}

function doScanSed(ctx: RuleContext): SedScan {
  const argv = ctx.argv;
  const exprs: string[] = [];
  const positional: Word[] = [];
  let unknownFlag: string | null = null;
  let unsafe = false;
  let dynamic = false;
  let explicitExpr = false;
  let optionsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) { dynamic = true; continue; }

    if (optionsDone || !t.startsWith("-") || t === "-") { positional.push(argv[i]); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (UNSAFE.has(name)) { unsafe = true; continue; }
      if (NO_VALUE.has(name)) { if (eq !== -1) unknownFlag ??= name; continue; }
      if (ONE_VALUE.has(name)) {
        let value = inline;
        if (value === null) {
          i++;
          if (i >= argv.length) { unknownFlag ??= name; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; continue; }
        }
        if (name === "--expression") { exprs.push(value); explicitExpr = true; }
        continue;
      }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：-i / -f 一旦出現，同 token 剩餘字元歸該旗標，無須再掃
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (UNSAFE.has(short)) { unsafe = true; ate = true; break; }
      if (NO_VALUE.has(short)) continue;
      if (ONE_VALUE.has(short)) {
        const rest = t.slice(k + 1);
        let value: string | null = rest;
        if (rest === "") {
          i++;
          if (i >= argv.length) { unknownFlag ??= short; ate = true; break; }
          value = staticValue(argv[i]);
          if (value === null) { dynamic = true; ate = true; break; }
        }
        if (short === "-e" && value !== null) { exprs.push(value); explicitExpr = true; }
        ate = true;
        break;
      }
      unknownFlag ??= short;
      ate = true;
      break;
    }
    if (ate) continue;
  }

  // 未給 -e 時，第一個位置參數是程式碼，其餘是輸入檔；給了 -e 時全部位置參數都是輸入檔。
  let program: string | null;
  let inputs: Word[];
  if (explicitExpr) {
    program = exprs.join("\n");
    inputs = positional;
  } else if (positional.length === 0) {
    program = null;
    inputs = [];
  } else {
    program = staticValue(positional[0]);
    inputs = positional.slice(1);
  }

  return { program, inputs, unknownFlag, unsafe, dynamic };
}

/**
 * sed 程式中下列構造代表寫檔 / 執行：獨立的 w / W / e / r / R 指令，或 s///… 旗標含 w 或 e。
 *
 * **這個函式請逐字從現有的 `src/rules/commands/sed.ts` 原樣保留、不要重新輸入**——其中的
 * 反向參照與單字邊界跳脫一旦在複製過程被轉義處理就會靜默失效，寫檔偵測會整組失去作用。
 * 本次改動不碰它的內容，只是它現在由 scanSed 的結果餵入。
 */
// function programHasSideEffect(program: string): boolean { …原樣保留既有實作… }

/**
 * cwd 豁免專用的**保守**程式驗證器：只認兩種確定不碰檔案系統的形態。
 *
 * 為什麼不沿用 `programHasSideEffect`：它是 denylist，會漏掉帶位址的形式——
 * `/x/r secret.txt`（讀檔）與 `1,2w out.txt`（寫檔）都不會被它命中，因為其位址字元類
 * 只涵蓋 `[0-9$/]`，遇到 `x` 或 `,` 就中止比對。evaluate 沿用它（維持既有行為、不在本次
 * 變更範圍），但**豁免不能建立在 denylist 上**：一旦跳過 cwd 檢查，漏判就等於放行
 * 專案外的讀寫。此處改用 allowlist，形態不符即不豁免（evaluate 的判定不受影響）。
 *
 * 認可的兩種形態（可用 `;` 串接、可有前後空白）：
 *  1. 行號 / 範圍 + `p` 或 `d`（如 `600,750p`、`1d`、`3,5p;9p`）——純選取輸出；
 *  2. 單一 `s///` 替換，旗標僅限 `g` / `i` / `I` / `p` / 數字——不含會寫檔或執行的 `w` / `e`。
 */
function programSafeForExemption(program: string): boolean {
  const p = program.trim();
  // 形態 1：行號 / 範圍 + p 或 d，可用 `;` 串接。字元集僅數字、逗號、p/d、`;` 與空白，
  // 不可能夾帶檔名或其他指令。
  if (/^(?:\d+(?:,\d+)?\s*[pd]\s*;?\s*)+$/.test(p)) return true;
  return isPureSubstitution(p);
}

/**
 * 形態 2：**單一** s/// 替換，旗標僅限 g / i / I / p / 數字。
 *
 * 以逐字掃描而非正則實作：正則的 `(?:\\.|[^\\])*?` 允許在回溯時跨越未跳脫的
 * 分隔符，於是 `s/a/b/;1,2w out.txt` 這種「替換後面再接一條寫檔指令」會被整段當成一個替換而
 * 誤放行。改為數出**未跳脫分隔符的實際位置**，要求恰好三個、且第三個之後只剩允許的旗標字元，
 * 就不可能夾帶第二條指令。
 */
function isPureSubstitution(p: string): boolean {
  if (p.length < 4 || p[0] !== "s") return false;
  const delim = p[1];
  // 分隔符不可是空白、英數或反斜線（sed 本身也不接受）
  if (/[\sa-zA-Z0-9\\]/.test(delim)) return false;
  const positions: number[] = [];
  for (let i = 1; i < p.length; i++) {
    if (p[i] === "\\") { i++; continue; } // 跳過被跳脫的字元
    if (p[i] === delim) positions.push(i);
  }
  if (positions.length !== 3) return false;
  return /^[giIp0-9]*$/.test(p.slice(positions[2] + 1));
}


export const sedRule: CommandRule = {
  names: ["sed"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const r = scanSed(ctx);
    if (r.unsafe) return ask("sed：-i / -f 可就地寫檔或載入不可見腳本");
    if (r.unknownFlag !== null) return ask(`sed：未列入安全集合的旗標 ${r.unknownFlag}`);
    if (r.dynamic) return ask("sed：含動態 token，無法靜態判定");
    if (r.program === null) return ask("sed：無法靜態取得程式內容");
    if (programHasSideEffect(r.program)) {
      return ask("sed：程式含寫檔 / 執行構造（w/W/e/r 或 s///we）");
    }
    for (const p of r.inputs) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`sed：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
  /**
   * 程式碼已與輸入路徑分離；無輸入路徑、旗標全已知、無 -i/-f，
   * **且程式形態落在極保守的白名單內**時，與 cwd 無關。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scanSed(ctx);
    if (r.unsafe || r.unknownFlag !== null || r.dynamic) return false;
    if (r.program === null || programHasSideEffect(r.program)) return false;
    if (!programSafeForExemption(r.program)) return false;
    return r.inputs.length === 0;
  },
};
```

The old `ASK_FLAGS` / `VALUE_FLAGS` constants and the `collectProgram` / `inputPaths` helpers are
deleted — everything they did now happens inside `doScanSed`. Remove the now-unused
`../flags.ts` and `positionals` imports.

- [ ] **Step 4: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/sed.ts src/rules/commands/sed_test.ts
git commit -m "fix(rules): catch sed -i/-f in clustered form; add known-flag allowlist and cwd predicate"
```

---

### Task 11: `gh` — flag-aware parse, flag allowlist, local side effects, endpoint operand

**Files:**
- Modify: `src/rules/commands/gh.ts`
- Test: `src/rules/commands/gh_test.ts`

One memoized `parseGh` supplies the subcommand, the **flag-aware** operand positions, mutation
detection, the unknown flag, and the rescued operand index. `evaluate` and both predicates read
that single result — no separate `find((t) => !t.startsWith("-"))` that mistakes a flag value for
the endpoint.

**Placeholder behavior:** `{owner}` / `{repo}` / `{branch}` in an endpoint withholds the **cwd
exemption** only. An ordinary in-project `gh api 'repos/{owner}/…'` keeps its existing `allow`.

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/gh_test.ts` (export `ctxOf` if needed):

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

Deno.test("non-GET methods ask in every flag form", () => {
  assertEquals(v("gh api repos/o/r -X POST"), "ask");
  assertEquals(v("gh api repos/o/r -XPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iXPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iX DELETE"), "ask");
  assertEquals(v("gh api repos/o/r --method=PATCH"), "ask");
  assertEquals(v("gh api repos/o/r -f a=b"), "ask");
  assertEquals(v("gh api repos/o/r --input body.json"), "ask");
});

Deno.test("gh api tolerates a single-? query string in the endpoint", () => {
  assertEquals(v("gh api repos/o/r/tags?per_page=50"), "allow");
  assertEquals(v("gh api repos/o/r/contents/pkg/x.go?ref=v1.18.0"), "allow");
  assertEquals(v("gh api -X GET repos/o/r/tags?per_page=50"), "allow");
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

Deno.test("placeholder endpoints keep their ordinary verdict but lose the exemption", () => {
  assertEquals(v("gh api 'repos/{owner}/{repo}/issues'"), "allow");
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api 'repos/{owner}/{repo}/issues'")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api -X GET 'repos/{owner}/{repo}/issues'")), false);
});

Deno.test("flags before the subcommand are still checked", () => {
  assertEquals(v("gh -XPOST api repos/o/r"), "ask");
  assertEquals(v("gh -X POST api repos/o/r"), "ask");
  assertEquals(v("gh --method=PATCH api repos/o/r"), "ask");
  assertEquals(v("gh --method PATCH api repos/o/r"), "ask");
  assertEquals(v("gh --cache=1h api repos/o/r"), "ask");
  assertEquals(v("gh --web repo view"), "ask");
  assertEquals(v("gh --totally-unknown api repos/o/r"), "ask");
  // 合法的前置旗標仍放行——包含「分開寫的值」形式，其值不可被誤認為子指令
  assertEquals(v("gh -X GET api repos/o/r"), "allow");
  assertEquals(v("gh -XGET api repos/o/r"), "allow");
  assertEquals(v("gh --method GET api repos/o/r"), "allow");
  assertEquals(v("gh --method=GET api repos/o/r"), "allow");
  assertEquals(v("gh -H 'Accept: x' api repos/o/r"), "allow");
  // 子指令前出現位置參數 → 保守否決
  assertEquals(v("gh x api repos/o/r"), "ask");
});

Deno.test("glob position is judged on the raw token, not the quote-removed value", () => {
  // `a\?b`：quote removal 後是 `a\?b`，重掃會找不到元字元；必須用原始位置判定
  assertEquals(v("gh api a" + "\\\\" + "?b"), "ask");
  // 反向：`rep\?os/...` 的 `?` 是被跳脫的字面值，不是活躍 glob → 不應被位置護欄誤殺
  assertEquals(v("gh api rep" + "\\" + "?os/o/r/x"), "allow");
});

Deno.test("a rescued endpoint may not contain braces", () => {
  // 未加引號的 `?` 可展開成 `{` / `}`，形成 cwd 佔位符
  assertEquals(v("gh api repos/o/r/x?owner}"), "ask");
  assertEquals(v("gh api 'repos/o/r/x{owner}'"), "allow"); // 加引號、未經寬鬆取值
});

Deno.test("only api and search are cwd-independent", () => {
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api repos/o/r/tags?per_page=50")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh search code x")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh pr diff")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh repo view")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh issue list --repo o/r")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api x --cache 1h")), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/rules/commands/gh.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { nonPathStaticValue, staticValue } from "../../engine/word.ts";

/** 各 gh 指令的唯讀子指令。`gh repo clone` / `gh release download` 會寫本地檔 → 不在此列。 */
const READ_SUBS: Record<string, Set<string>> = {
  repo: new Set(["view", "list"]),
  issue: new Set(["view", "list", "status"]),
  pr: new Set(["view", "list", "status", "diff", "checks"]),
  release: new Set(["view", "list"]),
};

/** 開啟本機瀏覽器 / 寫入本機快取：對所有子指令一律 ask。 */
const SIDE_EFFECT_LONG = new Set(["--web", "--cache"]);
const SIDE_EFFECT_SHORT = new Set(["w"]);

/** 送出 request body 或非 GET 方法 → 寫入請求。 */
const MUTATING_LONG = new Set(["--method", "--field", "--raw-field", "--input"]);
const MUTATING_SHORT = new Set(["X", "f", "F"]);

const COMMON_NO_VALUE = ["-h", "--help"];
const COMMON_ONE_VALUE = ["--json", "-q", "--jq", "-t", "--template"];
const API_NO_VALUE = ["--paginate", "--silent", "--slurp", "-i", "--include", "--verbose"];
const API_ONE_VALUE = [
  "-H", "--header", "--hostname", "-p", "--preview", "-X", "--method",
  "--cache", "--input", "-f", "--raw-field", "-F", "--field",
];
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

function tablesFor(command: string): { noValue: Set<string>; oneValue: Set<string> } {
  if (command === "api") {
    return {
      noValue: new Set([...COMMON_NO_VALUE, ...API_NO_VALUE]),
      oneValue: new Set([...COMMON_ONE_VALUE, ...API_ONE_VALUE]),
    };
  }
  if (command === "search") {
    return {
      noValue: new Set([...COMMON_NO_VALUE, ...SEARCH_NO_VALUE]),
      oneValue: new Set([...COMMON_ONE_VALUE, ...SEARCH_ONE_VALUE]),
    };
  }
  return {
    noValue: new Set([...COMMON_NO_VALUE, ...READ_NO_VALUE]),
    oneValue: new Set([...COMMON_ONE_VALUE, ...READ_ONE_VALUE]),
  };
}

interface GhParse {
  /** 解析階段即可決定的否決理由；非 null 時其餘欄位不可信。 */
  reject: string | null;
  command: string;
  /** 子指令之後的位置操作元（已排除所有旗標與旗標值）。 */
  operands: string[];
  /** 被寬鬆取值救回的操作元在 argv 中的索引；無則 -1。 */
  relaxedIdx: number;
  sideEffect: boolean;
  mutating: boolean;
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

const reject = (reason: string): GhParse => ({
  reject: reason, command: "", operands: [], relaxedIdx: -1,
  sideEffect: false, mutating: false, unknownFlag: null,
});

function doParseGh(ctx: RuleContext): GhParse {
  const argv = ctx.argv;
  const toks = argv.map((w) => staticValue(w));
  const nullCount = toks.filter((t) => t === null).length;
  if (nullCount > 1) return reject("gh：含一個以上動態 token，無法靜態判定");

  // 子指令 = 第一個「不是旗標、也不是前置旗標的值」的 token。
  // 不能單純找第一個非 `-` 開頭者：`gh -X GET api …` 的 `GET` 是 -X 的值，不是子指令。
  // 前置旗標的 arity 不可能依賴尚未確定的子指令，故此處以**所有子指令共用的**吃值旗標集合
  // 保守消化；任一子指令專屬的吃值旗標寫在子指令之前時，其值會被當成子指令而落入
  // 「未列入唯讀 allowlist」→ ask（安全方向）。
  const LEADING_ONE_VALUE = new Set([
    ...COMMON_ONE_VALUE, "-X", "--method", "-H", "--header", "--hostname",
    "-p", "--preview", "--cache", "--input", "-f", "--raw-field", "-F", "--field",
  ]);
  let cmdIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === null) break; // 動態 token 在子指令前 → 無法判定
    if (t === "--") { cmdIdx = i + 1 < toks.length ? i + 1 : -1; break; }
    if (!t.startsWith("-") || t === "-") { cmdIdx = i; break; }
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    // 長旗標吃值且未用 `=` 黏寫 → 下一 token 是值，跳過
    if (t.startsWith("--") && LEADING_ONE_VALUE.has(name) && eq === -1) { i++; continue; }
    // 短旗標群集：最後一個字母若吃值且同 token 無剩餘字元 → 下一 token 是值
    if (!t.startsWith("--")) {
      const last = `-${t[t.length - 1]}`;
      if (LEADING_ONE_VALUE.has(last)) { i++; continue; }
    }
  }
  if (cmdIdx === -1 || toks[cmdIdx] === null) {
    return reject("gh：未指定指令或指令為動態");
  }
  const command = toks[cmdIdx]!;
  const tables = tablesFor(command);

  const operandIdxs: number[] = [];
  let sideEffect = false;
  let mutating = false;
  let unknownFlag: string | null = null;
  let optionsDone = false;

  // gh 接受子指令**之前**的旗標（`gh -XPOST api …`、`gh --cache=1h api …` 皆有效），
  // 故掃描必須從 index 0 開始，而不是從 cmdIdx + 1。子指令本身在迴圈中被當成位置操作元
  // 出現，於下方以 `i === cmdIdx` 跳過。
  for (let i = 0; i < argv.length; i++) {
    if (i === cmdIdx) continue; // 子指令 token 本身
    const t = toks[i];
    if (t === null) { operandIdxs.push(i); continue; } // 唯一的 null：只可能是操作元
    if (optionsDone || !t.startsWith("-") || t === "-") { operandIdxs.push(i); continue; }
    if (t === "--") { optionsDone = true; continue; }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      if (SIDE_EFFECT_LONG.has(name)) sideEffect = true;
      if (MUTATING_LONG.has(name)) {
        if (name === "--method") {
          const val = inline ?? (i + 1 < argv.length ? toks[i + 1] : null);
          if ((val ?? "").toUpperCase() !== "GET") mutating = true;
        } else mutating = true;
      }
      if (tables.noValue.has(name)) { if (inline !== null) unknownFlag ??= name; continue; }
      if (tables.oneValue.has(name)) { if (inline === null) i++; continue; }
      unknownFlag ??= name;
      continue;
    }

    // 短旗標群集：逐字母。吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token。
    // 群集內的 X / f / F 同樣算寫入旗標（`-iXPOST` 必須被攔下）。
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      const short = `-${c}`;
      if (SIDE_EFFECT_SHORT.has(c)) sideEffect = true;
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

  // 子指令前若出現位置操作元（`gh x api …`），形式不明 → 保守否決
  if (operandIdxs.some((i) => i < cmdIdx)) {
    return reject("gh：子指令之前出現位置參數，形式無法判定");
  }

  // 唯一的 null token 必須就是 api 之後的第一個位置操作元，且只有 gh api 可救
  let relaxedIdx = -1;
  const operands: string[] = [];
  for (const idx of operandIdxs) {
    const t = toks[idx];
    if (t !== null) { operands.push(t); continue; }
    if (command !== "api" || idx !== operandIdxs[0]) {
      return reject("gh：動態 token 不在 endpoint 位置");
    }
    const relaxed = nonPathStaticValue(argv[idx]);
    if (relaxed === null || relaxed.value.startsWith("-")) {
      return reject("gh：含動態 token，無法靜態判定");
    }
    // endpoint 的萬用字元必須落在第一個 `/` 之後，確保第一段（repos / orgs / …）為字面。
    // 位置判定**必須**用 relaxed.globIndex 與 relaxed.raw：對 relaxed.value 重跑
    // firstGlobMetacharIndex 會因 quote removal 抹除跳脫資訊而誤判。
    if (relaxed.globIndex !== -1) {
      const slash = relaxed.raw.indexOf("/");
      if (slash === -1 || relaxed.globIndex <= slash) {
        return reject(`gh api：endpoint 的萬用字元位置不安全（${relaxed.value}）`);
      }
      // `?` 可以展開成 `{` 或 `}`：`repos/o/r/x?owner}` 若 cwd 下有檔案
      // `repos/o/r/x{owner}`，展開後 endpoint 就含 {owner}，而含佔位符者不得享有 cwd
      // 豁免 —— 豁免判定會因此隨檔案系統改變。故被救回的 endpoint 不得含 `{` 或 `}`。
      if (relaxed.value.includes("{") || relaxed.value.includes("}")) {
        return reject("gh api：endpoint 含 { 或 }，展開後可能形成 cwd 佔位符");
      }
    }
    relaxedIdx = idx;
    operands.push(relaxed.value);
  }
  if (nullCount === 1 && relaxedIdx === -1) {
    return reject("gh：含動態 token，無法靜態判定");
  }

  return { reject: null, command, operands, relaxedIdx, sideEffect, mutating, unknownFlag };
}

/** endpoint 含由 cwd 的 git repository 填值的佔位符。 */
function hasCwdPlaceholder(endpoint: string): boolean {
  return endpoint.includes("{owner}") || endpoint.includes("{repo}") ||
    endpoint.includes("{branch}");
}

export const ghRule: CommandRule = {
  names: ["gh"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const p = parseGh(ctx);
    if (p.reject !== null) return ask(p.reject);
    if (p.sideEffect) {
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
    if (p.reject !== null || p.sideEffect || p.unknownFlag !== null) return false;
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

- [ ] **Step 4: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/gh.ts src/rules/commands/gh_test.ts
git commit -m "feat(rules): flag-aware gh parse, flag allowlist, local side-effect asks, endpoint operand"
```

---

### Task 12: `curl` — declare cwd-independence only (no relaxed parsing)

**Files:**
- Modify: `src/rules/commands/curl.ts`
- Test: `src/rules/commands/curl_test.ts`

`curl` gets **no** relaxed operand value: its verdict compares preapproved **path prefixes**, not
just the host, so an expanded `?` could change the verdict. Unquoted `?` therefore stays dynamic
and asks. Quoted URLs are unaffected, and `curl` still gets the cwd exemption — that never
depended on relaxed parsing.

- [ ] **Step 1: Write the failing tests**

The fixture's allowed domain is **`api.example.com`**. If the file has no one-liner, add
`const v = (src: string) => curlRule.evaluate(ctxOf(src)).kind;` next to its `ctxOf`.

```ts
Deno.test("curl leaves unquoted ? dynamic", () => {
  // curl 的判定會比對 preapproved 的 path 前綴，展開會改變判定 → 不套用寬鬆取值
  assertEquals(v("curl -s https://api.example.com/p?q=1"), "ask");
  assertEquals(v("curl -s https://api.example.com?q=1"), "ask");
});

Deno.test("quoted curl URLs are unaffected", () => {
  assertEquals(v("curl -s 'https://api.example.com/p?q=1'"), "allow");
  assertEquals(v("curl -s 'https://api.example.com/p'"), "allow");
});

Deno.test("curl cwdIndependent tracks the evaluate verdict", () => {
  assertEquals(curlRule.cwdIndependent!(ctxOf("curl -s 'https://api.example.com/p?q=1'")), true);
  assertEquals(curlRule.cwdIndependent!(ctxOf("curl -s 'https://not-allowed.test/p'")), false);
  assertEquals(curlRule.cwdIndependent!(ctxOf("curl -s https://api.example.com/p?q=1")), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: FAIL — `cwdIndependent` is undefined on `curlRule`.

- [ ] **Step 3: Add only the predicates to `src/rules/commands/curl.ts`**

No parsing change at all. Append to the exported object:

```ts
  /**
   * allow 形式只走網路；`-H @file` 已由 resolvePathValue 以真實 cwd 檢查。
   * evaluate 是 ctx 的純函式，故此處重入得到同一個判定；classify 只在 evaluate 已回
   * allow 時才詢問本述詞，因此不可能放寬判定。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    return curlRule.evaluate(ctx).kind === "allow";
  },
```

Do **not** add `toleratesNonStaticOperand` — `curl` tolerates no non-static token, so guardrail 4
must reject any such call.

- [ ] **Step 4: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/curl.ts src/rules/commands/curl_test.ts
git commit -m "feat(rules): declare curl cwd-independence; no relaxed URL parsing"
```

---

### Task 13: wire the cwd exemption into `classify` / `evaluate`

**Files:**
- Modify: `src/engine/classify.ts`, `src/engine/evaluate.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`. It **already imports `walk`** — do not re-import it.

```ts
/** 整條指令鏈的最終決策（session cwd 預設為專案內）。 */
function decide(src: string, start: CwdState = START) {
  return evaluate(src, ROOT, start);
}

/** 單一葉指令的判定，可指定 sessionCwdInScope，用於直接檢驗護欄 2。 */
function leaf(
  src: string,
  name: string,
  sessionInScope: boolean,
  start: CwdState = START,
  rules?: PermissionRules,
) {
  const invs = walk(parseCommand(src).script, start, ROOT);
  const inv = invs.find((i) => i.name === name)!;
  return classify(inv, ROOT, rules, null, [], sessionInScope);
}

Deno.test("chain cd out of project no longer asks for cwd-independent commands", () => {
  assertEquals(decide("cd /tmp && echo hi").verdict, "allow");
  assertEquals(decide("cd /tmp && pwd").verdict, "allow");
  assertEquals(decide("cd /tmp && whoami").verdict, "allow");
});

Deno.test("guardrail 1: a settings.allow upgrade never grants the exemption", () => {
  // gh api --input 讀本地檔 → 規則自身判 ask；即使 permissions.allow 命中也不得豁免
  const rules = rulesOf({ allow: ["Bash(gh api:*)"] });
  assertEquals(leaf("cd /tmp && gh api x --input body.json", "gh", true, START, rules).kind, "ask");
  // 對照：同一條規則在專案內 cwd 下會被升級成 allow
  assertEquals(onlyWith("gh api x --input body.json", rules).kind, "allow");
});

Deno.test("guardrail 2 blocks the leaf itself, not just the chain", () => {
  const dirty: CwdState = { kind: "known", path: "/outside" };
  assertEquals(leaf("cd . && echo hi", "echo", false, dirty).kind, "ask");
  assertEquals(leaf("cd /tmp && echo hi", "echo", false, dirty).kind, "ask");
  assertEquals(leaf("cd /tmp && echo hi", "echo", true).kind, "allow");
});

Deno.test("evaluate derives session trust from the initial cwd, not a caller flag", () => {
  const dirty: CwdState = { kind: "known", path: "/outside" };
  // evaluate 自己算出 sessionCwdInScope=false，整條鏈必須 ask
  assertEquals(decide("cd . && echo hi", dirty).verdict, "ask");
  assertEquals(decide("cd /tmp && echo hi", dirty).verdict, "ask");
  // gh 的寬鬆 endpoint 述詞會成功，但起點不可信仍不得豁免
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50", dirty).verdict, "ask");
  // 逐葉斷言：確認擋下的是 gh 葉指令本身，而不是被前面的 cd 葉指令遮蔽
  assertEquals(
    leaf("cd /tmp && gh api repos/o/r/tags?per_page=50", "gh", false, dirty).kind,
    "ask",
  );
  assertEquals(leaf("cd . && gh api repos/o/r/tags?per_page=50", "gh", false, dirty).kind, "ask");
  // 對照：起點可信時同一個 gh 葉指令才豁免
  assertEquals(
    leaf("cd /tmp && gh api repos/o/r/tags?per_page=50", "gh", true).kind,
    "allow",
  );
});

Deno.test("guardrail 3: path operands are still resolved against the real cwd", () => {
  assertEquals(decide("cd /tmp && head -100 a.txt").verdict, "ask");
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
  assertEquals(decide("cd /tmp && head -1 < ../outside.txt").verdict, "ask"); // 範圍外 <
});

Deno.test("every non-declaring command still asks after a chain cd", () => {
  const cases = [
    // 隱含以 cwd 為操作對象
    "ls", "tree", "find . -name x", "rg pat", "git status", "deno test",
    // fileReaderRule 的其餘成員：與 head/wc 共用規則，必須確認沒有被順帶豁免
    "cat", "cut -c1", "tr a b", "nl", "fold -w 80", "column -t",
    "stat x", "cmp a b", "comm a b", "md5sum", "hexdump", "basename x", "dirname x",
    "realpath x", "readlink x",
    // 其他未宣告的規則
    "awk '{print}'", "yq '.'", "sort", "uniq", "xxd", "diff a b", "file x", "date -r x",
    "which some-name",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "ask", c);
  }
});

Deno.test("find's hard deny needs a real root; /tmp is only an ask", () => {
  // dangerousRoot 只對磁碟根 / 家目錄根 deny；/tmp 兩者都不是
  assertEquals(decide("cd /tmp && find . -name x").verdict, "ask");
  assertEquals(decide("cd /tmp && find / -name x").verdict, "deny");
  assertEquals(decide("cd / && find . -name x").verdict, "deny");
});
```

Add `import type { PermissionRules } from "../permissions/settings.ts";` if the file does not
already have it (it imports the type for `rulesOf`, so it likely does).

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire it in `src/engine/classify.ts`**

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
  // 認定的操作元（本工具的判定完全不讀其內容）。
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

- [ ] **Step 4: Compute `sessionCwdInScope` in `src/engine/evaluate.ts`**

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

- [ ] **Step 5: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/engine/classify.ts src/engine/evaluate.ts src/engine/classify_test.ts
git commit -m "feat(engine): cwd-independent exemption for central preflight rule 1"
```

---

### Task 14: acceptance matrix + filesystem-state independence

**Files:**
- Test: `src/engine/classify_test.ts`, `src/rules/commands/gh_test.ts`

- [ ] **Step 1: Write the acceptance matrix**

Append to `src/engine/classify_test.ts`:

```ts
Deno.test("every declaring command takes the exemption in its read-only form", () => {
  const cases = [
    "head -100", "wc -l", "tail -200", "grep -E 'Retry'",
    "sed -n '600,750p'", "jq -r '.name'",
    "gh api repos/o/r/tags?per_page=50", "gh search code x --language go",
    "echo hi", "pwd", "whoami",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "allow", c);
  }
});

Deno.test("curl takes the exemption for a quoted allowed URL", () => {
  // classify_test.ts 既有的 webFetchRulesOf 提供 WebFetch 網域規則；
  // api.example.com 是該檔既有測試使用的網域（api.github.com 不在 preapproved 清單內）
  const rules = webFetchRulesOf({ allow: ["WebFetch(domain:api.example.com)"] });
  assertEquals(
    evaluate("cd /tmp && curl -s 'https://api.example.com/repos/o/r'", ROOT, START, rules).verdict,
    "allow",
  );
  // 未加引號的 `?` → curl 不套用寬鬆取值 → ask
  assertEquals(
    evaluate("cd /tmp && curl -s https://api.example.com/repos/o/r?x=1", ROOT, START, rules).verdict,
    "ask",
  );
  // 範圍外的 -H @file 以真實 cwd 檢查 → ask
  assertEquals(
    evaluate("cd /tmp && curl -s -H @../h.txt 'https://api.example.com/x'", ROOT, START, rules).verdict,
    "ask",
  );
  // 網域未放行 → ask（確認上面的 allow 真的來自網域規則，不是碰巧）
  assertEquals(
    evaluate("cd /tmp && curl -s 'https://not-allowed.test/x'", ROOT, START, rules).verdict,
    "ask",
  );
});

Deno.test("the same seven with a path operand or path flag still ask", () => {
  const cases = [
    "head -100 a.txt", "wc -l a.txt", "tail -200 a.txt", "grep pat a.txt",
    "sed -n '1p' a.txt", "jq -r '.name' a.json",
    "wc --files0-from=list", "grep --exclude-from=f pat", "jq -f prog.jq",
    "jq -L mods '.'", "sed -nfprog.sed p",
    "gh pr diff", "gh repo view", "gh api 'repos/{owner}/{repo}/issues'",
    "gh search code x --web", "gh api x --cache 1h", "gh api x --totally-unknown",
    "head --totally-unknown", "grep --totally-unknown pat", "sed --totally-unknown 'p'",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "ask", c);
  }
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
  assertEquals(decide("cd /tmp && gh api repos/o/r/x 2>&1 | tail -200").verdict, "allow");
});
```

- [ ] **Step 2: Write the filesystem-state independence fixture**

Append to `src/rules/commands/gh_test.ts`. The context must be built **with the temp directory as
its cwd and root**, and compared before and after creating a matching file:

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
  // cwd 與專案根刻意設成同一個暫存目錄：本測試要隔離的唯一變因是「檔案存不存在」，
  // 路徑範圍不是受測對象（範圍行為由 classify_test.ts 的整合測試涵蓋）。
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
  // `?` 在 bash 中可展開成「除 `/` 外的任一字元」。逐一列舉不可行，故取**每個字元類**
  // 的代表：英數、連字號與底線（常見檔名字元）、點、空白、shell 元字元、引號、非 ASCII，
  // 外加大括號。
  //
  // 大括號**必須**納入且必然安全：佔位符是完整的 `{owner}` / `{repo}` / `{branch}`，
  // 需要左右各一個大括號；而被救回的 endpoint 原本就不得含任何大括號（護欄會先 ask），
  // 單一 `?` 的展開至多只能新增**一個**大括號字元，湊不出佔位符。
  const chars = ["X", "x", "9", "-", "_", ".", " ", "&", ";", "|", "$", "*", "'", '"', "中", "{", "}"];
  for (const ch of chars) {
    // 以單引號包住整個 endpoint，確保測試餵進去的是「展開後的字面值」本身，
    // 不會又被 parser 當成新的 glob 或 shell 結構。
    const src = `gh api 'repos/o/r/tags${ch === "'" ? "" : ch}per_page=50'`;
    if (ch === "'") continue; // 單引號本身以雙引號包覆另測
    assertEquals(v(src), base, ch);
  }
  assertEquals(v(`gh api "repos/o/r/tags'per_page=50"`), base, "single quote");
});
```

**This test goes in `src/engine/classify_test.ts`**, not `gh_test.ts` — it needs `evaluate`,
`ROOT` and `START`, which only that file has:

```ts
Deno.test("expansion invariance holds through the cwd exemption, not just evaluate", () => {
  // 原 token 與其任一展開結果，在「鏈內 cd 到專案外」的完整判定下必須一致
  const base = evaluate("cd /tmp && gh api repos/o/r/tags?per_page=50", ROOT, START).verdict;
  assertEquals(base, "allow");
  for (const ch of ["X", "-", "_", ".", "{", "}", "$", ";", " "]) {
    assertEquals(
      evaluate(`cd /tmp && gh api 'repos/o/r/tags${ch}per_page=50'`, ROOT, START).verdict,
      base,
      ch,
    );
  }
  // 大括號是唯一例外，且兩側都必須 ask —— 原 token 因護欄 ask、展開結果因佔位符不豁免
  assertEquals(evaluate("cd /tmp && gh api repos/o/r/x?owner}", ROOT, START).verdict, "ask");
  assertEquals(evaluate("cd /tmp && gh api 'repos/o/r/x{owner}'", ROOT, START).verdict, "ask");
});
```

The remaining tests in this step stay in `gh_test.ts`, which already has `ctxOf` and `v`:

```ts

Deno.test("multiple expanded endpoints are a gh usage error, never a write", () => {
  // 兩個位置操作元：gh 自己會報錯；本工具的判定仍是 allow（GET、無寫入旗標）
  assertEquals(v("gh api repos/o/r/tagsXq=1 repos/o/r/tagsYq=1"), "allow");
});

Deno.test("an endpoint that could expand into a placeholder is rejected up front", () => {
  // `repos/o/r/x?owner}` 展開可得 `repos/o/r/x{owner}` → 含 cwd 佔位符。
  // 原 token 與其展開結果的豁免判定必須一致，故原 token 直接 ask。
  assertEquals(v("gh api repos/o/r/x?owner}"), "ask");
  assertEquals(v("gh api repos/o/r/x{owner}"), "allow"); // 展開結果本身：一般判定不變
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api repos/o/r/x{owner}")), false);
});
```

No curl fixture is needed — `curl` has no relaxed parsing, so its verdict is trivially independent
of the filesystem.

- [ ] **Step 3: Run everything**

Run: `deno task check && deno task lint && deno task test`
Expected: all green. `deno.json`'s test task already grants
`--allow-run --allow-env --allow-read --allow-write --allow-sys=uid`. Any failure in the matrix is
a real gap in Tasks 5–13 — fix the rule, never the assertion.

- [ ] **Step 4: Commit**

```bash
git add src/engine/classify_test.ts src/rules/commands/gh_test.ts
git commit -m "test: acceptance matrix for the seven declaring commands + fs-state independence"
```

---

### Task 15: sync `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

Three places currently contradict the new behavior and must change together, or a future
maintainer will remove the exemption as a "regression".

- [ ] **Step 1: Replace central preflight rule 1's description**

```markdown
1. **cwd 範圍**：`cwd.kind === "known"` 但落在「專案 ∪ 使用者以 `Read()/Edit()/Write()` 放寬的外部
   唯讀範圍 ∪ 當前 session 的 trusted read roots」之外 → ask（判定由 `scope.ts` 的 `isReadScoped`
   統一負責）。**唯一例外**：五道護欄全部成立時跳過本條（且只跳過本條）——
   (1) 指令規則自身回 `allow`（`permissions.allow` 升級的 ask 永不豁免）；
   (2) hook 傳入的 session cwd 本身在範圍內 **且** 當前 cwd 由鏈內 `cd` 產生（`origin === "chain-cd"`）；
   (3) 相對路徑仍以真實 cwd 解析；
   (4) argv 全為靜態 token（唯一例外是 `gh api` 的 endpoint 操作元，由規則以
       `toleratesNonStaticOperand` 認定）；
   (5) 每個旗標都命中該規則的已知旗標表。
   宣告方式為 `CommandRule.cwdIndependent`，未宣告 = 不豁免（default-deny）。
   **目前宣告者**：`gh`（僅 `api` / `search`）、`head`、`wc`、`tail`、`grep`、`sed`、`jq`、
   `curl`（僅 allow 形式；**不含**任何寬鬆取值），加上不接受路徑操作元的 `echo` / `pwd` / `whoami`
   （`which` 明確排除：PATH 可含 `.` 或空段）。
```

- [ ] **Step 2: Qualify the statement that an out-of-scope-cwd allow is a regression**

Replace that clause with:

```markdown
若 binary 對帶**寫入重導向／賦值前綴／範圍外 `<`** 的指令回 `allow`，那**是 regression**——這三條
中央前置 ask 對所有指令通用且不可由 `permissions.allow` 升級。**cwd 超範圍**則有一個受控例外：
符合上述五道護欄的純唯讀、與 cwd 無關的指令（如 `cd /outside && gh api …`）會 `allow`，這是設計
行為而非 regression；不符合任一護欄者仍必須 `ask`。
```

- [ ] **Step 3: Fix the contradicting sentence in 「新增 / 修改指令規則」**

```markdown
**不要重複處理**中央前置規則已涵蓋的事（cwd 範圍、寫入重導向、賦值前綴、範圍外 `<`）。規則雖**先於**
中央前置評估，但其 allow/ask 會被中央前置 ask 覆寫；能越過的只有 rule deny，以及規則明確宣告
`cwdIndependent` 且五道護欄全部成立時的**規則一**。規則二/三/四永遠不受規則行為影響。
```

- [ ] **Step 4: Update the architecture bullets**

`classify.ts` — append:

```markdown
  另計算 cwd 豁免旗標（`cwdIndependent` / `toleratesNonStaticOperand` 兩個可選述詞 + 五道護欄），
  以 `skipCwdCheck` 傳給 `centralPreflightAsk`，**僅**跳過規則一。
```

`scope.ts` — append:

```markdown
  另提供 `buildScopeConfig`，供 `evaluate`（計算 `sessionCwdInScope`）與 `classify` 共用同一份範圍定義。
```

`rules/` — replace the file-list line with:

```markdown
`rules/`：`types.ts`（`CommandRule`/`RuleContext`/`RuleVerdict` + `allow()`/`ask()`/`deny()`，
另含 `cwdIndependent` / `toleratesNonStaticOperand` 兩個可選述詞）、
`command_spec.ts`（`CommandSpec`：每個旗標只描述一次——名稱、吃值方式
（`none` / `required` / `attached-only`）、值是否為路徑；位置參數語義與遞迴判定皆可依**同一次解析**
的 `seenFlags` 動態決定。`parseArgv` 對每個 `RuleContext` 只解析一次並快取，`evaluate` 與
`cwdIndependent` 因此讀到**同一份**結果）、`flags.ts`、`factory.ts`、`allowlist.ts`、`commands/*.ts`
（本次新增 `commands/jq.ts`，`jq` 已自 `fileReaderRule` 移出；`rg` 已自 `grepRule.names` 移出、
成為 `grep.ts` 內獨立的 `rgRule`）。

**解析器歸屬與豁免資格是兩件事**：走 `CommandSpec` 的只有 `grep`/`egrep`/`fgrep`、`head`、`wc`、
`tail`；`gh`、`jq`、`sed` 各有自己的**單一 memoized 掃描**（同樣保證 evaluate 與述詞讀同一份結果）；
`curl` 與 `rg` 沿用既有 legacy 解析。豁免資格則由 `cwdIndependent` 宣告，兩者不重疊：
`curl` 不走 `CommandSpec` 但會豁免，`rg` 既不走 `CommandSpec` 也不豁免（恆為遞迴）。
```

- [ ] **Step 5: Add the `word.ts` note**

```markdown
- **`nonPathStaticValue`**：只容忍「單一 `?` 查詢串」形態（恰一個未跳脫 `?`、不在索引 0、其後不含 `/`）
  且**無 `parts`**（整個 word 皆未加引號）的 token，且**只可用於 `gh api` 的 endpoint 操作元**。
  安全性由「本工具的判定完全不讀該 token 內容」保證——`gh.ts` 的 `parseGh` 只由**旗標**決定
  HTTP 方法與副作用，不讀 endpoint 路徑。另兩道護欄：元字元須落在第一個 `/` 之後；被救回的
  endpoint 不得含 `{` / `}`（`?` 可展開成它們而形成 cwd 佔位符）。
  旗標、旗標值、任何路徑、以及 **`curl` 的所有 token** 一律沿用 `staticValue`：`curl` 的判定會比對
  preapproved 的 **path 前綴**（`matchesPreapproved`），展開會改變判定，故 `curl` 不套用寬鬆取值。
```

- [ ] **Step 6: Update the gh notes**

In 「安全誤放（auto-allow 不該 allow）」, replace the gh part of the git/gh bullet with:

```markdown
- **gh 已改為旗標 allowlist**：未知旗標一律 ask（同時免疫 gh 版本漂移）。本機副作用旗標
  `-w`/`--web`（開瀏覽器）與 `--cache`（寫本機快取）對所有子指令一律 ask。非 GET 方法與寫入 body
  的偵測在 `gh.ts` 的 `parseGh` 內以**旗標感知解析**進行（不再是獨立的 `ghApiMutates`），群集寫法
  （`-iXPOST`）與**子指令之前的旗標**（`gh -XPOST api …`）同樣攔下。`gh api` 的 endpoint 含
  `{owner}`/`{repo}`/`{branch}` 時目標由 cwd 的 git repo 決定 → 不得享有 cwd 豁免（一般判定不變）。
```

- [ ] **Step 7: Fix the three remaining contradicting lines**

Search `CLAUDE.md` for these statements and update each:

1. The sentence saying **only rule deny** can bypass the central preflight — add the exemption:

```markdown
`classify` 先評估指令規則：其硬 deny 優先於任何中央前置 ask。能越過中央前置的只有兩種情形：
rule deny，以及規則宣告 `cwdIndependent` 且五道護欄全部成立時的**規則一**。
```

2. The `flagGatedReader` description saying **every positional** gets `resolvePath` — qualify it:

```markdown
- **旗標型**：用 `factory.ts` 的 `flagGatedReader`。`askFlags` 兩條路徑都先套用；其餘分成兩種：
  - **有提供 `spec`（CommandSpec）者**：argv 分類**完全由 spec 決定**，`valueFlags` /
    `pathValueFlags` 一律不參與。旗標的路徑值靠 `FlagSpec.valueIsPath` 宣告；位置參數是不是路徑
    靠 `CommandSpec.positionals`（`grep` 未給 `-e`/`-f` 時第一個位置參數是 PATTERN，不做範圍檢查）。
    **替這類規則新增吃路徑的旗標時，要加在 `FlagSpec` 上並設 `valueIsPath: true`**——加到
    `pathValueFlags` 不會有任何作用。
  - **未提供 `spec` 的 legacy 規則**：維持既有行為——`valueFlags` 跳過吃值旗標、`pathValueFlags`
    對旗標路徑值做範圍檢查、所有位置參數一律 `resolvePath`。
```

3. The 「吃路徑值的 flag 要 scope-check 其值」 bullet still cites `grep -f` as a `pathValueFlags`
   case, but grep now goes through `CommandSpec`, where that option is ignored. Replace it:

```markdown
- **吃路徑值的 flag 要 scope-check 其值**：其值是會被讀取的路徑，必須做範圍檢查
  （`RuleContext.resolvePathValue`），不能只當 flag 跳過。**宣告位置依該規則走哪條路徑而不同**：
  - 走 `CommandSpec` 者（`grep`/`egrep`/`fgrep`、`head`、`wc`、`tail`）寫在 `FlagSpec` 上、
    設 `valueIsPath: true`（例：`grep -f <patternfile>`、`grep --exclude-from=<file>`、
    `wc --files0-from=<file>`）。加到 `pathValueFlags` **不會有任何作用**。
  - 走 legacy 路徑者（`diff`、`realpath` 等）仍用 `factory.ts` 的 `pathValueFlags`
    （例：`diff --from-file=<file>`、`realpath --relative-to=<dir>`）。
```

4. The line saying dynamic tokens are **unconditionally** treated as undecidable — add the one
   exception:

```markdown
- 動態 token（變數 / `$()` / 可逸出 glob）一律當不可判定 → ask，不要臆測其展開結果。
  **唯一例外**：`gh api` 的 endpoint 操作元容忍「單一 `?` 查詢串」形態（見 `word.ts` 的
  `nonPathStaticValue`），因為本工具的判定完全不讀該 token 的內容。
```

- [ ] **Step 8: Verify and commit**

Run: `deno task check && deno task lint && deno task test`
Expected: all green (no code changed).

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md with the cwd exemption, CommandSpec, gh allowlist and jq rule"
```

---

### Task 16: build + operational verification against the real baseline set

**Files:** no source changes. Produces `dist/permission-checker(.exe)` (gitignored).

**The acceptance criterion is fixed: 62 allow / 5 ask over the 67-command baseline.** A shortfall
is an unmet criterion to diagnose, not a number to rewrite. Do **not** edit the spec's target.

The fifth ask is expected and must stay an ask: the baseline's `gh search code … --match-all …`
uses a flag that **does not exist in gh** (`gh search code --match-all foo` → `unknown flag:
--match-all`), so the flag allowlist rejects it. Do not add `--match-all` to any safe flag set to
make the number come out — the command is broken as written.

- [ ] **Step 1: Build**

Run: `deno task build`
Expected: `dist/permission-checker.exe` written, exit 0.

- [ ] **Step 2: Create an isolated settings environment**

The binary reads project `.claude/settings.json`, `.claude/settings.local.json`, and the user
settings under `CLAUDE_CONFIG_DIR ?? <home>/.claude`. Isolate all three:

```bash
VERIFY_ROOT="$(mktemp -d)"
VERIFY_CFG="$(mktemp -d)"
mkdir -p "$VERIFY_ROOT/.claude"
printf '{}' > "$VERIFY_ROOT/.claude/settings.json"
printf '{}' > "$VERIFY_ROOT/.claude/settings.local.json"
printf '{}' > "$VERIFY_CFG/settings.json"

# Windows 關鍵：mktemp -d 回 POSIX 路徑（/tmp/...），但 binary 是 Windows 原生程式。
# 環境變數會被 MSYS 自動轉換，JSON 裡的 cwd 字串不會 —— 兩者必須都用 Windows 形式，
# 否則 sessionCwdInScope 恆為 false，所有基準指令都會 ask 而看不出原因。
VERIFY_ROOT_W="$(cygpath -m "$VERIFY_ROOT")"
VERIFY_CFG_W="$(cygpath -m "$VERIFY_CFG")"
echo "root=$VERIFY_ROOT_W cfg=$VERIFY_CFG_W"
```

Every invocation below passes **both** `CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W"` and
`CLAUDE_CONFIG_DIR="$VERIFY_CFG_W"`, and every JSON payload's `cwd` uses `$VERIFY_ROOT_W`.

Confirm the setup with **two** controls. The negative one alone would still print `ask` even if the
whole environment were misconfigured:

```bash
# 負控制：非唯讀指令必須 ask
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"rm -rf x"},"cwd":"'"$VERIFY_ROOT_W"'"}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W" CLAUDE_CONFIG_DIR="$VERIFY_CFG_W" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'

# 正控制：專案內的唯讀指令必須 allow —— 這條會抓到路徑形式設錯
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"pwd"},"cwd":"'"$VERIFY_ROOT_W"'"}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W" CLAUDE_CONFIG_DIR="$VERIFY_CFG_W" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask` then `allow`. If the second prints `ask`, the path form is wrong — fix it before
continuing; any tally taken now would be meaningless.

- [ ] **Step 3: Build the 67-command baseline fixture**

The baseline is the Bash tool calls of one research subagent transcript. Locate it by content
rather than a hardcoded path — it is the one whose Bash calls are 67 `cd /d && gh …` lines:

```bash
CANDIDATES="$(grep -rl 'gh api repos/GoogleContainerTools' \
  "$(cygpath -u "$USERPROFILE")/.claude/projects" --include='*.jsonl' 2>/dev/null)"
for f in $CANDIDATES; do
  # 必須數「tool_use 物件個數」而不是行數：基準集裡的 heredoc 指令本身跨多行，
  # 用 `jq -r .input.command | wc -l` 會數成 108，永遠對不上 67。
  cnt="$(jq -s '[.[] | select(.message.content) | .message.content[]?
                | select(.type=="tool_use" and .name=="Bash")] | length' "$f" 2>/dev/null)"
  printf '%s\t%s\n' "$cnt" "$f"
done
```

Pick the file whose count is **67**, then:

```bash
TRANSCRIPT="<the 67-line file from above>"
jq -c --arg d "$VERIFY_ROOT_W" 'select(.message.content) | .message.content[]?
       | select(.type=="tool_use" and .name=="Bash")
       | {tool_name:"Bash", tool_input:{command:.input.command}, cwd:$d}' \
  "$TRANSCRIPT" > baseline.jsonl
wc -l baseline.jsonl   # 期望 67（`jq -c` 每筆一行，指令內的換行已被 JSON 跳脫）
```

If no candidate has 67 lines, **stop and ask the user for the transcript path**. Do not substitute
a reconstructed set — the acceptance count is defined over the real one.

**Why `VERIFY_ROOT` replaces the original project root:** the only thing the substitution changes
is which absolute prefix counts as in-project. Every baseline command's paths are either absent
(the `gh` and filter pipelines) or relative to the chain's own `cd /d` target, so no verdict depends
on how the root is spelled — while §7.3's isolation requirement *does* need a project whose
`.claude/settings.json` we control. A purpose-built root satisfies both. If any baseline command
turns out to reference the original project root by absolute path, restore the original root for
that command and say so in the report.

- [ ] **Step 4: Replay and tally**

```bash
: > baseline_results.jsonl
n=$(wc -l < baseline.jsonl); i=1
while [ "$i" -le "$n" ]; do
  payload="$(sed -n "${i}p" baseline.jsonl)"
  out="$(printf '%s' "$payload" \
    | CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W" CLAUDE_CONFIG_DIR="$VERIFY_CFG_W" ./dist/permission-checker.exe)"
  # 指令與結果寫進同一個 JSON 物件。基準集的指令含換行，任何以物理行配對（paste / 行號）
  # 的做法都會錯位。
  jq -nc --argjson p "$payload" --argjson o "$out" --argjson i "$i" \
    '{i: $i, cmd: $p.tool_input.command,
      decision: $o.hookSpecificOutput.permissionDecision,
      reason: ($o.hookSpecificOutput.permissionDecisionReason // "")}' \
    >> baseline_results.jsonl
  i=$((i+1))
done
jq -r '.decision' baseline_results.jsonl | sort | uniq -c
```

Expected: **62 allow, 5 ask**. The five asks must be: the two `for f in …; do gh api …${f}… ; done`
loops (variable expansion), the one `xargs -I {} sh -c …` line, the one heredoc-write line, and the
one `gh search code … --match-all …` line (nonexistent gh flag).
每筆 `baseline_results.jsonl` 記錄都自帶 `cmd`，可直接 `jq` 檢視，不需要與原檔配對。

**If the count is short:** for each unexpected `ask`, read its reason, identify which guardrail or
flag table rejected it, and fix the rule — most likely a missing safe flag in a `CommandSpec` or in
gh's tables. Adding a genuinely safe, side-effect-free flag to a table is the correct fix.
Relaxing a guardrail, or editing the spec's target, is not.

**After any code fix, re-run the full gate before re-measuring**:
`deno task check && deno task lint && deno task test`, then `deno task build`, then this replay
from Step 1. The sibling tasks' passing tests no longer establish correctness of code you just
changed.

- [ ] **Step 5: Verify the guardrails end-to-end**

```bash
for c in "cd /d && ls" "cd /d && cat x.txt" "cd /d && echo *" "cd /d && grep *" \
         "cd /d && gh pr diff" "cd /d && gh api repos/o/r/x > out.txt" \
         "cd /d && gh search code x --web" "cd /d && wc --files0-from=list" \
         "cd /d && which some-name" "cd /d && curl -s https://api.github.com/x?q=1" \
         "cd /d && sed -nfprog.sed p" "cd /d && jq -f prog.jq" ; do
  printf '%-52s -> ' "$c"
  jq -nc --arg c "$c" --arg d "$VERIFY_ROOT_W" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
    | CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W" CLAUDE_CONFIG_DIR="$VERIFY_CFG_W" ./dist/permission-checker.exe \
    | jq -r '.hookSpecificOutput.permissionDecision'
done
printf '%-52s -> ' "cd /d && find . -name x"
jq -nc --arg c "cd /d && find . -name x" --arg d "$VERIFY_ROOT_W" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT_W" CLAUDE_CONFIG_DIR="$VERIFY_CFG_W" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask` for **every** loop entry, and `deny` — not `ask` — for the `find` line (`/d`
normalizes to the `D:` drive root on Windows). Check both directions: an `allow` anywhere is a
guardrail failure, and a `find` line that prints `ask` is a hard-deny regression.

- [ ] **Step 6: Record the results, then clean up**

Capture what Step 7 needs **before** deleting anything:

```bash
jq -r '.decision' baseline_results.jsonl | sort | uniq -c > baseline_tally.txt
jq -r 'select(.decision=="ask") | "#\(.i)	\(.reason)
\(.cmd)
---"'   baseline_results.jsonl > baseline_asks.txt
cat baseline_tally.txt baseline_asks.txt
```

Then clean up:

```bash
rm -rf "$VERIFY_ROOT" "$VERIFY_CFG" baseline.jsonl baseline_results.jsonl
```

Keep `baseline_tally.txt` and `baseline_asks.txt` until the report is written, then delete them too.

- [ ] **Step 7: Report**

Report the measured tally and the reason string for each of the **five** expected asks. The task is
**not** complete unless **all** of the following hold — diagnose and fix the rule, then re-run from
Step 1 if any fails:

- the tally is exactly **62 allow / 5 ask**;
- the five asks are the two `for` loops, the `xargs … sh -c` line, the heredoc-write line, and the
  `gh search code … --match-all …` line;
- every Step 5 guardrail line printed `ask` — **no** `allow` anywhere;
- the Step 5 `find` line printed **`deny`**, not `ask` (an `ask` there is a hard-deny regression).
