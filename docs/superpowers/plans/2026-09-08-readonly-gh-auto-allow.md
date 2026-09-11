# Read-only `gh` CLI Auto-Allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking for read-only `gh` CLI research commands by fixing three interdependent false-ask root causes (out-of-project cwd, `?` in a `gh api` endpoint treated as glob, `grep`/`jq` non-path leading positionals), while closing several read-only gaps found during review.

**Architecture:** `classify` gains a cwd exemption that skips **only** central preflight rule 1, fenced by five guardrails and opted into per rule. Exactly **seven** commands opt in — `gh`, `head`, `jq`, `grep`, `wc`, `tail`, `sed` — which is every filter the baseline set actually uses; plus `echo`/`pwd`/`whoami`, which take no operands. The four that go through `flagGatedReader` (`grep`, `head`, `wc`, `tail`) get a small `CommandSpec` declaring each flag once, parsed once and memoized per `RuleContext` so `evaluate` and the predicate provably read the same parse. `gh`, `jq`, and `sed` keep hand-written parsers with the same memoization. `gh api`'s endpoint operand gets a narrowly-scoped relaxed static value; `curl` does not.

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
| `src/rules/command_spec.ts` | `CommandSpec` (each flag declared once) + `parseArgv`, memoized per `RuleContext`. Four commands use it: `grep`/`egrep`/`fgrep`, `head`, `wc`, `tail` |
| `src/rules/command_spec_test.ts` | Parser tests |
| `src/rules/commands/jq.ts` | `jq` rule: filter is not a path; `-f` is boolean; `-L` takes an attached value |
| `src/rules/commands/jq_test.ts` | Tests for the above |

**Modify:** `src/engine/word.ts`, `src/types.ts`, `src/engine/cwd.ts`, `src/engine/scope.ts`,
`src/engine/classify.ts`, `src/engine/evaluate.ts`, `src/rules/types.ts`, `src/rules/factory.ts`,
`src/rules/commands/{grep,coreutils,simple-flag,tail,sed,gh}.ts`, `src/rules/allowlist.ts`,
`src/engine/{cwd,walk,classify}_test.ts`, `CLAUDE.md`.

**Deliberately untouched:** `src/rules/commands/{awk,positional-output,curl,find,deno,git}.ts`.
`awk`, `uniq`, `xxd`, `yq`, `sort`'s exemption, `diff`, `tree`, `file`, `date`, `curl`'s value
parsing — none of them opt in, so none of their flag grammars need modelling.

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

**Backslash behavior (resolves the spec's two statements):** `staticValue` already applies bash
quote removal to unquoted words, so `a\b` is *static* and returns `"ab"` through
`nonPathStaticValue`'s early return. The relaxed branch is therefore never reached for a
backslash-bearing unquoted word; both spec statements hold. The tests assert the real behavior.

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
  assertEquals(
    nonPathStaticValue(wordOf("repos/o/r/tags?per_page=50")),
    "repos/o/r/tags?per_page=50",
  );
});

Deno.test("nonPathStaticValue passes already-static words straight through", () => {
  assertEquals(nonPathStaticValue(wordOf("plain/endpoint")), "plain/endpoint");
  assertEquals(nonPathStaticValue(wordOf("'a?b/c'")), "a?b/c");
  assertEquals(nonPathStaticValue(wordOf('"a*b"')), "a*b");
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

`src/engine/cwd_test.ts` — add `origin: "chain-cd"` to the expected object on each line:

| Line | New expected object |
| --- | --- |
| 17 | `{ kind: "known", path: "/proj/src", origin: "chain-cd" }` |
| 22 | `{ kind: "known", path: "/tmp", origin: "chain-cd" }` |
| 35 | `{ kind: "known", path: "/proj/sub", origin: "chain-cd" }` |
| 43 | `{ kind: "known", path: "/proj/sub/wt", origin: "chain-cd" }` |
| 51 | `{ kind: "known", path: "/outside", origin: "chain-cd" }` |
| 57 | `{ kind: "known", path: "/outside/.git", origin: "chain-cd" }` |

Lines 26, 30, 63 (`{ kind: "unknown" }`) and line 71 (`git status` with no path option returns the
cwd object unchanged, so no `origin`) stay as they are.

`src/engine/walk_test.ts`:

| Line | New expected object |
| --- | --- |
| 28 | `{ kind: "known", path: "/proj/src", origin: "chain-cd" }` |
| 45 | `{ kind: "known", path: "/proj/sub", origin: "chain-cd" }` — inside `"git -C sets per-command cwd without leaking"`, this is the `git` leaf's cwd, which `gitEffectiveCwd` derives via `applyPath` |

Line 34, and the `cat.cwd` assertion that follows line 45, stay unchanged — those are cwd values
that were never passed through `applyPath`.

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
- Modify: `src/rules/commands/coreutils.ts` (`fileReaderRule`, `diffRule`), `src/rules/commands/simple-flag.ts` (`sortRule`)
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
});
```

Append to `src/rules/commands/simple-flag_test.ts` — its helper is `v(rule, name, src)`:

```ts
Deno.test("sort --files0-from is scope-checked", () => {
  assertEquals(v(sortRule, "sort", "sort --files0-from=list.txt"), "allow");
  assertEquals(v(sortRule, "sort", "sort --files0-from=../out/list.txt"), "ask");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts`
Expected: FAIL — the out-of-project variants currently allow, because the values are skipped.

- [ ] **Step 3: Add the flags to `fileReaderRule` in `src/rules/commands/coreutils.ts`**

```ts
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
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

> `jq` is still in this `names` list at this point; Task 8 removes it.

- [ ] **Step 4: Add the flags to `diffRule`**

```ts
/** diff：位置參數做範圍檢查，且吃路徑值的旗標也需範圍檢查。 */
export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  valueFlags: [exact("--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file")],
  pathValueFlags: ["--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file"],
});
```

- [ ] **Step 5: Add the flag to `sortRule` in `src/rules/commands/simple-flag.ts`**

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

- [ ] **Step 6: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/commands/coreutils.ts src/rules/commands/simple-flag.ts src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts
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
  assertEquals(parseArgv(ctxOf("head", "head -100"), HEAD).unknownFlag, null);
  assertEquals(parseArgv(ctxOf("head", "head -100x"), HEAD).unknownFlag, "-100x");
  assertEquals(parseArgv(ctxOf("demo", "demo -100"), DEMO).unknownFlag, "-100");
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

export interface CommandSpec {
  flags: FlagSpec[];
  positionals: PositionalKind;
  /**
   * 是否支援 legacy 數字短旗標（head -100 / tail -200）。
   * 僅在明確開啟時接受，且**整個 token** 必須是 `-` 加數字；`-100x` 視為未知旗標。
   */
  numericShorthand?: boolean;
  /** 此次呼叫是否遞迴遍歷（用於危險根偵測與 cwd 豁免排除）。 */
  recursive?: (name: string, argv: Word[]) => boolean;
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
  /** 此次呼叫是否遞迴遍歷。 */
  isRecursive: boolean;
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
      if (f.value === "none") { if (inline !== null) unknownFlag ??= name; continue; }
      if (f.value === "attached-only") { continue; } // 裸寫不吃值；=value 已含在同 token
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

    // legacy 數字短旗標：整個 token 必須是 `-` 加數字
    if (spec.numericShorthand && /^-[0-9]+$/.test(t)) continue;

    // 短旗標群集：逐字母；吃值字母吃掉同 token 剩餘字元，剩餘為空則吃下一 token
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      const f = find(short);
      if (!f) { unknownFlag ??= short; ate = true; break; }
      if (f.value === "none") {
        // `-b=1` 這種形式不合法，保守視為未知
        if (t[k + 1] === "=") { unknownFlag ??= short; ate = true; break; }
        continue;
      }
      if (f.value === "attached-only") continue; // 短旗標無此形態，容忍但不吃值
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

  let pathOperands = positional;
  let nonPathOperands: Word[] = [];
  if (spec.positionals === "pattern-then-paths" && positional.length > 0) {
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
- Modify: `src/rules/factory.ts`, `src/rules/commands/grep.ts`
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
function evaluateWithSpec(
  ctx: RuleContext,
  spec: CommandSpec,
  opts: FlagGatedReaderOptions,
): RuleVerdict {
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
      if (spec) return evaluateWithSpec(ctx, spec, opts);
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

/**
 * pattern 是否由位置參數提供。`-e` / `--regexp` / `-f` / `--file` 任一形式出現時，
 * pattern 改由旗標提供，全部位置參數都是 FILE。
 * 群集偵測不限字母：`-rex.y` 是 `-r -e x.y`，故只要群集的**前綴字母**出現 e / f 即算命中；
 * 任一 token 動態時保守回 false（多做一次路徑檢查）。
 */
function patternIsLeadingPositional(argv: Word[]): boolean {
  for (const w of argv) {
    const t = staticValue(w);
    if (t === null) return false;
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      if (t === "--regexp" || t.startsWith("--regexp=")) return false;
      if (t === "--file" || t.startsWith("--file=")) return false;
      continue;
    }
    // 短旗標群集：逐字母掃到第一個吃值字母為止；e / f 出現即命中
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (c === "e" || c === "f") return false;
      if (!/[A-Za-z]/.test(c)) break; // 已進入某個旗標的黏寫值
    }
  }
  return true;
}

function specFor(_name: string, argv: Word[]): CommandSpec {
  return {
    flags,
    positionals: patternIsLeadingPositional(argv) ? "pattern-then-paths" : "paths",
    recursive: isRecursive,
  };
}

export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  spec: specFor,
  cwdIndependentWhenNoPaths: true,
  // rg 恆為遞迴，isRecursive 已排除；列出僅為明示意圖
  cwdDependentNames: ["rg"],
});
```

- [ ] **Step 5: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/grep.ts src/rules/commands/grep_test.ts
git commit -m "fix(rules): grep PATTERN is not a path; --color takes no separate value"
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
  assertEquals(v("jq -f prog.jq data.json"), "allow");
  assertEquals(v("jq -f ../outside.jq data.json"), "ask");
  // 旗標寫在位置參數之後也一樣：第一個位置參數才是 program 檔
  assertEquals(v("jq ../outside.jq -f data.json"), "ask");
  assertEquals(v("jq prog.jq --from-file data.json"), "allow");
  // -fn 是 -f -n：program 檔仍是第一個位置參數
  assertEquals(v("jq -fn ../outside.jq"), "ask");
  assertEquals(v("jq -fn prog.jq"), "allow");
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
        if (name === "--args" || name === "--jsonargs") argsModeFrom = positional.length;
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
  //  - 有 -f：第一個是 program 檔（是路徑），其餘是輸入檔。
  //  - --args / --jsonargs 之後出現的位置參數是字串，不是檔案。
  const cutoff = argsModeFrom >= 0 ? argsModeFrom : positional.length;
  const considered = positional.slice(0, cutoff);
  const paths = fromFile ? considered : considered.slice(1);
  if (fromFile && considered.length > 0) pathFlagUsed = true;

  return { paths, pathValues, pathFlagUsed, unknownFlag, dynamic };
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
    for (const p of r.paths) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`jq：路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
  /** filter 不是路徑；無任何路徑（含 program 檔）且未用到吃路徑的旗標時與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scan(ctx);
    return !r.dynamic && r.unknownFlag === null && r.paths.length === 0 && !r.pathFlagUsed;
  },
};
```

- [ ] **Step 4: Remove `jq` from `fileReaderRule` and register the new rule**

In `src/rules/commands/coreutils.ts`, drop `"jq"` from `fileReaderRule`'s `names`.
In `src/rules/allowlist.ts`, add `import { jqRule } from "./commands/jq.ts";` and put `jqRule,`
in the `RULES` array after `grepRule,`.

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
- Modify: `src/rules/commands/coreutils.ts`, `src/rules/commands/tail.ts`
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

Append to `src/rules/commands/tail_test.ts` (use its existing helper):

```ts
Deno.test("tail numeric shorthand and -n value are not paths", () => {
  assertEquals(v("tail -200"), "allow");
  assertEquals(v("tail -n 200"), "allow");
});

Deno.test("tail declares cwd-independence only with no operands", () => {
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail -200")), true);
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail -200 a.txt")), false);
});

Deno.test("tail -f still asks", () => {
  assertEquals(v("tail -f a.txt"), "ask");
  assertEquals(v("tail -f"), "ask");
});
```

If `tail_test.ts` lacks `ctxOf` / `v`, add them following `grep_test.ts`'s shape, bound to
`name: "tail"`.

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

`askFlags` runs before the spec path, so `tail -f` still asks before any spec parsing. Note that
`cwdIndependent` does **not** consult `askFlags`; add the guard explicitly by keeping `-f`/`-F` in
the spec as `"none"` flags **and** relying on Task 10's guardrail 1 (`evaluate` must return
`allow`), which `tail -f` never does.

- [ ] **Step 5: Run the tests, full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/coreutils.ts src/rules/commands/tail.ts src/rules/commands/coreutils_test.ts src/rules/commands/tail_test.ts
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

Append to `src/rules/commands/sed_test.ts` (export its `ctxOf` if it is not already exported):

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

Deno.test("sed cwdIndependent requires zero input paths and known flags", () => {
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p'")), true);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -n '1,5p' a.txt")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed --totally-unknown 'p'")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -nfprog.sed p")), false);
  assertEquals(sedRule.cwdIndependent!(ctxOf("sed -i 's/a/b/'")), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test --allow-env src/rules/commands/sed_test.ts`
Expected: FAIL — `sed -nfprog.sed a.txt` currently allows.

- [ ] **Step 3: Add flag enforcement to `src/rules/commands/sed.ts`**

Add above `sedRule`:

```ts
/** sed 的已知旗標。未列入者一律 ask，故新版 sed 新增的旗標不會被誤放行。 */
const SED_NO_VALUE = new Set([
  "-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate",
  "-u", "--unbuffered", "-z", "--null-data", "--posix", "--debug", "--sandbox",
  "--help", "--version",
]);
const SED_ONE_VALUE = new Set(["-e", "--expression", "-l", "--line-length"]);
/** 會就地寫檔或載入不可見腳本；任何形式出現即 ask。 */
const SED_UNSAFE = new Set(["-i", "--in-place", "-f", "--file"]);

interface SedFlagScan {
  /** 第一個未知旗標。 */
  unknownFlag: string | null;
  /** 是否出現 -i / -f（含群集與黏寫形式）。 */
  unsafe: boolean;
}

/** 掃描旗標。長短、黏寫、群集三種形式皆處理。 */
function scanSedFlags(ctx: RuleContext): SedFlagScan {
  const argv = ctx.argv;
  let unknownFlag: string | null = null;
  let unsafe = false;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) continue; // 動態由既有流程判 ask
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (SED_UNSAFE.has(name)) { unsafe = true; continue; }
      if (SED_NO_VALUE.has(name)) { if (eq !== -1) unknownFlag ??= name; continue; }
      if (SED_ONE_VALUE.has(name)) { if (eq === -1) i++; continue; }
      unknownFlag ??= name;
      continue;
    }
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (SED_UNSAFE.has(short)) { unsafe = true; break; } // 黏寫值歸此旗標，無須再掃
      if (SED_NO_VALUE.has(short)) continue;
      if (SED_ONE_VALUE.has(short)) { if (t.slice(k + 1) === "") i++; break; }
      unknownFlag ??= short;
      break;
    }
  }
  return { unknownFlag, unsafe };
}
```

Replace the top of `sedRule.evaluate`:

```ts
    const fs = scanSedFlags(ctx);
    if (fs.unsafe) return ask("sed：-i / -f 可就地寫檔或載入不可見腳本");
    if (fs.unknownFlag !== null) return ask(`sed：未列入安全集合的旗標 ${fs.unknownFlag}`);
```

(this replaces the existing `hasAnyFlag(ctx.argv, ASK_FLAGS)` check, which missed clustered forms),
and add the predicate:

```ts
  /** 程式碼已與輸入路徑分離；無輸入路徑、旗標全已知且無 -i/-f 時與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    const fs = scanSedFlags(ctx);
    if (fs.unsafe || fs.unknownFlag !== null) return false;
    const { text, explicitExpr } = collectProgram(ctx);
    if (text === null || programHasSideEffect(text)) return false;
    return inputPaths(ctx, explicitExpr).length === 0;
  },
```

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
import { firstGlobMetacharIndex, nonPathStaticValue, staticValue } from "../../engine/word.ts";

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

  const cmdIdx = toks.findIndex((t) => t !== null && !t.startsWith("-"));
  if (cmdIdx === -1) return reject("gh：未指定指令或指令為動態");
  const command = toks[cmdIdx]!;
  const tables = tablesFor(command);

  const operandIdxs: number[] = [];
  let sideEffect = false;
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
    if (relaxed === null || relaxed.startsWith("-")) {
      return reject("gh：含動態 token，無法靜態判定");
    }
    // endpoint 的萬用字元必須落在第一個 `/` 之後，確保第一段（repos / orgs / …）為字面
    const g = firstGlobMetacharIndex(relaxed);
    const slash = relaxed.indexOf("/");
    if (g !== -1 && (slash === -1 || g <= slash)) {
      return reject(`gh api：endpoint 的萬用字元位置不安全（${relaxed}）`);
    }
    relaxedIdx = idx;
    operands.push(relaxed);
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

Deno.test("commands that implicitly act on cwd still ask", () => {
  for (const c of ["ls", "tree", "file x", "date -r x", "rg pat", "git status", "deno test", "cat", "awk '{print}'", "yq '.'", "sort", "uniq", "xxd", "diff", "tr a b"]) {
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
Deno.test("all seven declaring commands are cwd-independent with no operands", () => {
  const cases = [
    "head -100", "wc -l", "tail -200", "grep -E 'Retry'",
    "sed -n '600,750p'", "jq -r '.name'",
    "gh api repos/o/r/tags?per_page=50", "gh search code x --language go",
  ];
  for (const c of cases) {
    assertEquals(decide(`cd /tmp && ${c}`).verdict, "allow", c);
  }
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
   **目前宣告者只有七個指令**：`gh`（僅 `api` / `search`）、`head`、`wc`、`tail`、`grep`、`sed`、`jq`，
   加上無操作元的 `echo` / `pwd` / `whoami`（`which` 明確排除：PATH 可含 `.`）。
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
（`none` / `required` / `attached-only`）、值是否為路徑；外加位置參數語義與 legacy 數字短旗標開關。
`parseArgv` 對每個 `RuleContext` 只解析一次並快取，`evaluate` 與 `cwdIndependent` 因此讀到**同一份**
結果。**只有 `grep`/`egrep`/`fgrep`、`head`、`wc`、`tail` 使用它**；其餘指令沿用 legacy 設定且不參與
cwd 豁免，故無須建模其旗標文法）、`flags.ts`、`factory.ts`、`allowlist.ts`、`commands/*.ts`
（本次新增 `commands/jq.ts`，`jq` 已自 `fileReaderRule` 移出）。
```

- [ ] **Step 5: Add the `word.ts` note**

```markdown
- **`nonPathStaticValue`**：只容忍「單一 `?` 查詢串」形態（恰一個未跳脫 `?`、不在索引 0、其後不含 `/`）
  的未加引號 token，且**只可用於 `gh api` 的 endpoint 操作元**。安全性由「本工具的判定完全不讀該
  token 內容」保證——`ghApiMutates` 只掃描旗標。旗標、旗標值、任何路徑、以及 **`curl` 的所有 token**
  一律沿用 `staticValue`：`curl` 的判定會比對 preapproved 的 **path 前綴**（`matchesPreapproved`），
  展開會改變判定，故 `curl` 不套用寬鬆取值。
```

- [ ] **Step 6: Update the gh notes**

In 「安全誤放（auto-allow 不該 allow）」, replace the gh part of the git/gh bullet with:

```markdown
- **gh 已改為旗標 allowlist**：未知旗標一律 ask（同時免疫 gh 版本漂移）。本機副作用旗標
  `-w`/`--web`（開瀏覽器）與 `--cache`（寫本機快取）對所有子指令一律 ask。非 GET 方法以**旗標感知
  解析**偵測，群集寫法（`-iXPOST`）同樣攔下。`gh api` 的 endpoint 含 `{owner}`/`{repo}`/`{branch}`
  時目標由 cwd 的 git repo 決定 → 不得享有 cwd 豁免（一般判定不變）。
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

**Files:** no source changes. Produces `dist/permission-checker(.exe)` (gitignored).

**The acceptance criterion is fixed: 63 allow / 4 ask over the 67-command baseline.** A shortfall
is an unmet criterion to diagnose, not a number to rewrite. Do **not** edit the spec's target.

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
```

Every invocation below passes **both** `CLAUDE_PROJECT_DIR="$VERIFY_ROOT"` and
`CLAUDE_CONFIG_DIR="$VERIFY_CFG"`. Confirm the isolation before trusting any result:

```bash
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"rm -rf x"},"cwd":"'"$VERIFY_ROOT"'"}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask`. If this prints `allow`, the isolation failed — stop and fix it.

- [ ] **Step 3: Build the 67-command baseline fixture**

The baseline is the Bash tool calls of one research subagent transcript:

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
Pair `baseline.jsonl` with `baseline_results.txt` line by line to confirm.

**If the count is short:** for each unexpected `ask`, read its reason, identify which guardrail or
flag table rejected it, and fix the rule — most likely a missing safe flag in a `CommandSpec` or in
gh's tables. Adding a genuinely safe, side-effect-free flag to a table is the correct fix.
Relaxing a guardrail, or editing the spec's target, is not.

- [ ] **Step 5: Verify the guardrails end-to-end**

```bash
for c in "cd /d && ls" "cd /d && cat x.txt" "cd /d && echo *" "cd /d && grep *" \
         "cd /d && gh pr diff" "cd /d && gh api repos/o/r/x > out.txt" \
         "cd /d && gh search code x --web" "cd /d && wc --files0-from=list" \
         "cd /d && which some-name" "cd /d && curl -s https://api.github.com/x?q=1" \
         "cd /d && sed -nfprog.sed p" "cd /d && jq -f prog.jq" ; do
  printf '%-52s -> ' "$c"
  jq -nc --arg c "$c" --arg d "$VERIFY_ROOT" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
    | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
    | jq -r '.hookSpecificOutput.permissionDecision'
done
printf '%-52s -> ' "cd /d && find . -name x"
jq -nc --arg c "cd /d && find . -name x" --arg d "$VERIFY_ROOT" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
  | CLAUDE_PROJECT_DIR="$VERIFY_ROOT" CLAUDE_CONFIG_DIR="$VERIFY_CFG" ./dist/permission-checker.exe \
  | jq -r '.hookSpecificOutput.permissionDecision'
```

Expected: `ask` for all twelve loop entries; `deny` for the `find` line (`/d` normalizes to the
`D:` drive root on Windows). **No line may print `allow`.**

- [ ] **Step 6: Clean up**

```bash
rm -rf "$VERIFY_ROOT" "$VERIFY_CFG" baseline.jsonl baseline_results.txt
```

- [ ] **Step 7: Report**

Report the measured tally and the reason string for each of the four expected asks. If any
guardrail line printed `allow`, or the tally is not 63/4, the task is **not** complete — diagnose
and fix the rule, then re-run from Step 1.
