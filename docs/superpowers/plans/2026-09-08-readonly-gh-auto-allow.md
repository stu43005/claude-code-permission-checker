# Read-only `gh` CLI Auto-Allow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-codex:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking for read-only `gh` CLI research commands by fixing three interdependent false-ask root causes (out-of-project cwd, `?` in an endpoint treated as glob, `grep`/`jq` non-path leading positionals), while tightening several read-only gaps found during spec review.

**Architecture:** Three independent components plus two tightening passes. Component 1 adds an opt-in `cwdIndependent` declaration on `CommandRule` that lets `classify` skip **only** central preflight rule 1 (cwd scope), fenced by five guardrails. Component 2 adds a narrowly-scoped `nonPathStaticValue` used **only** for the `gh api` endpoint and `curl` URL operand. Component 3 stops treating `grep`'s PATTERN and `jq`'s filter as filesystem paths. Everything is an allowlist addition: any rule that does not opt in keeps its current behavior.

**Tech Stack:** Deno 2 + TypeScript, `npm:unbash@4.0.1` for Bash AST parsing, `@std/assert` for tests, `deno compile` to a single binary.

**Spec:** `docs/superpowers/specs/2026-09-03-readonly-gh-auto-allow-design.md`

---

## File Structure

**Modify:**

| File | Responsibility after this change |
| --- | --- |
| `src/engine/word.ts` | Adds `firstGlobMetacharIndex` and `nonPathStaticValue` (single-`?` query-string tolerance) alongside the existing `staticValue` |
| `src/types.ts` | `CwdState.known` gains optional `origin?: "chain-cd"` |
| `src/engine/cwd.ts` | `applyPath` stamps `origin: "chain-cd"` |
| `src/engine/scope.ts` | Adds `buildScopeConfig` so `evaluate` and `classify` construct `ScopeConfig` identically |
| `src/rules/types.ts` | `CommandRule` gains optional `cwdIndependent` and `toleratesNonStaticOperand` predicates |
| `src/engine/classify.ts` | Computes the cwd exemption, passes `skipCwdCheck` to `centralPreflightAsk` |
| `src/engine/evaluate.ts` | Computes `sessionCwdInScope` once, threads it to `classify` |
| `src/rules/factory.ts` | Single-parse `classifyArgv`; new options `nonPathLeadingPositional`, `cwdIndependentWhenNoPaths`, `cwdDependentNames`, `knownFlags` |
| `src/rules/commands/grep.ts` | PATTERN excluded from path checks; `--exclude-from` scope-checked; opt-in |
| `src/rules/commands/coreutils.ts` | `jq` removed from `fileReaderRule`; `--files0-from` / `--relative-to` / `--relative-base` scope-checked; `diff` gains `-X`/`-S`; opt-ins; `pureUtilRule` declares cwd-independence except `which` |
| `src/rules/commands/simple-flag.ts` | `sort --files0-from` scope-checked; `sort`/`yq` opt-in; `tree`/`file`/`date` deliberately not |
| `src/rules/commands/positional-output.ts` | `uniq`/`xxd` gain the same opt-in mechanism |
| `src/rules/commands/tail.ts` | opt-in |
| `src/rules/commands/sed.ts` | hand-written `cwdIndependent` |
| `src/rules/commands/awk.ts` | hand-written `cwdIndependent` |
| `src/rules/commands/gh.ts` | Flag allowlist, local side-effect asks, endpoint operand tolerance, cwd-independence for `api`/`search` |
| `src/rules/commands/curl.ts` | URL operand tolerance + authority guard, cwd-independence |
| `src/rules/allowlist.ts` | Registers `jqRule` |
| `CLAUDE.md` | Documentation sync |

**Create:**

| File | Responsibility |
| --- | --- |
| `src/rules/commands/jq.ts` | `jq` rule: filter is not a path; flag allowlist; `-f`/`-L`/`--slurpfile`/`--rawfile` values scope-checked |
| `src/rules/commands/jq_test.ts` | Tests for the above |

---

### Task 1: `word.ts` — glob metachar index + non-path operand static value

**Files:**
- Modify: `src/engine/word.ts`
- Test: `src/engine/word_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/word_test.ts`:

```ts
import { firstGlobMetacharIndex, nonPathStaticValue } from "./word.ts";

function wordOf(src: string) {
  const cmd = parse(`x ${src}`).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("firstGlobMetacharIndex finds first unescaped metachar", () => {
  assertEquals(firstGlobMetacharIndex("abc"), -1);
  assertEquals(firstGlobMetacharIndex("ab?c"), 2);
  assertEquals(firstGlobMetacharIndex("a*b?c"), 1);
  assertEquals(firstGlobMetacharIndex("a[bc]"), 1);
  assertEquals(firstGlobMetacharIndex("a\\*b?c"), 4); // \* is literal
  assertEquals(firstGlobMetacharIndex("?abc"), 0);
});

Deno.test("nonPathStaticValue tolerates a single-? query string", () => {
  assertEquals(nonPathStaticValue(wordOf("repos/o/r/tags?per_page=50")), "repos/o/r/tags?per_page=50");
  assertEquals(nonPathStaticValue(wordOf("https://h/p?q=1")), "https://h/p?q=1");
  assertEquals(nonPathStaticValue(wordOf("plain/endpoint")), "plain/endpoint");
});

Deno.test("nonPathStaticValue rejects everything outside that shape", () => {
  assertEquals(nonPathStaticValue(wordOf("a*b")), null); // * never tolerated
  assertEquals(nonPathStaticValue(wordOf("a[bc]")), null); // [ never tolerated
  assertEquals(nonPathStaticValue(wordOf("a?b?c")), null); // two metachars
  assertEquals(nonPathStaticValue(wordOf("?abc")), null); // metachar at index 0
  assertEquals(nonPathStaticValue(wordOf("a?b/c")), null); // / after the ?
  assertEquals(nonPathStaticValue(wordOf("$X")), null); // expansion
  assertEquals(nonPathStaticValue(wordOf("$(x)")), null); // command expansion
});

Deno.test("nonPathStaticValue matches staticValue for quoted words", () => {
  assertEquals(nonPathStaticValue(wordOf("'a?b/c'")), "a?b/c"); // quoted: no expansion happens
  assertEquals(nonPathStaticValue(wordOf('"a*b"')), "a*b");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: FAIL — `firstGlobMetacharIndex`/`nonPathStaticValue` are not exported from `./word.ts`.

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
 * 「單一 `?` 查詢串」容忍條件（spec §4.2）：三項全部成立才容忍。
 *  1. 未跳脫的 glob 元字元恰好一個，且該字元是 `?`（`*` / `[` 一律不容忍）；
 *  2. 該 `?` 不在索引 0（字面前綴非空 → 展開結果不可能以 `-` 開頭）；
 *  3. 該 `?` 之後的子字串不含 `/`（等價於「`?` 位於最後一個 `/` 之後」）。
 */
function isSingleQueryGlob(value: string): boolean {
  const first = firstGlobMetacharIndex(value);
  if (first <= 0) return false; // 無元字元由呼叫端另行處理；索引 0 不容忍
  if (value[first] !== "?") return false;
  const rest = value.slice(first + 1);
  if (firstGlobMetacharIndex(rest) !== -1) return false; // 第二個元字元
  return !rest.includes("/");
}

/**
 * 非路徑操作元（gh 的 API endpoint、curl 的 URL）的靜態取值。
 * 與 staticValue 的差異只有一項：未加引號、且符合「單一 `?` 查詢串」形態的 token
 * 不再視為動態。`*` / `[` / 多重元字元 / `?` 後含 `/` 一律回 null。
 * 展開類 part 與含反斜線的未引號 Literal 仍回 null（維持保守）。
 * **只可用於已證明 verdict 不變的操作元**（spec §4.2.5），不得用於路徑、旗標或旗標值。
 */
export function nonPathStaticValue(word: Word): string | null {
  const strict = staticValue(word);
  if (strict !== null) return strict; // 本來就靜態
  if (word.parts) {
    // 有 parts：展開類 part 或含反斜線的 Literal 仍算動態，不放寬
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
  // 無 parts（未加引號字面值）：套用 bash quote removal 後檢查形態
  if (word.value.includes("\\")) return null;
  return isSingleQueryGlob(word.value) ? word.value : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/word_test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Type check and lint**

Run: `deno task check && deno task lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/word.ts src/engine/word_test.ts
git commit -m "feat(engine): add firstGlobMetacharIndex + nonPathStaticValue"
```

---

### Task 2: `CwdState.origin` — mark chain-derived cwd

**Files:**
- Modify: `src/types.ts:6-8`
- Modify: `src/engine/cwd.ts:13-18`
- Test: `src/engine/cwd_test.ts` (create if absent) or `src/engine/walk_test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/engine/walk_test.ts`:

```ts
Deno.test("in-chain cd stamps origin chain-cd; session cwd does not", () => {
  const start = { kind: "known", path: "/proj" } as const;
  const invs = walk(parseCommand("cd /tmp && cat a").script, start, "/proj");
  const cd = invs.find((i) => i.name === "cd")!;
  const cat = invs.find((i) => i.name === "cat")!;
  // cd 葉指令本身帶的是變更前的 session cwd
  assertEquals(cd.cwd.kind === "known" && cd.cwd.origin, undefined);
  assertEquals(cat.cwd.kind === "known" && cat.cwd.path, "/tmp");
  assertEquals(cat.cwd.kind === "known" && cat.cwd.origin, "chain-cd");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL — `origin` does not exist on `CwdState`, or is `undefined` for `cat`.

- [ ] **Step 3: Add the field in `src/types.ts`**

Replace the `CwdState` declaration:

```ts
/** 指令執行時的有效工作目錄狀態。 */
export type CwdState =
  // origin 缺席 = 由 hook 傳入的 session cwd（不可信於 cwd 豁免）；
  // "chain-cd" = 由本次指令鏈內的 cd / git -C 推導而來。缺席時一律不豁免（fail-safe）。
  | { kind: "known"; path: string; origin?: "chain-cd" } // 已正規化的絕對 posix 路徑
  | { kind: "unknown" }; // 無法靜態確定
```

- [ ] **Step 4: Stamp it in `src/engine/cwd.ts`**

Replace `applyPath`:

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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/walk_test.ts src/engine/cwd_test.ts`
Expected: PASS. (`cwd_test.ts` may not exist; run only the files that do.)

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green. `origin` is optional, so no existing construction site needs updating.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/engine/cwd.ts src/engine/walk_test.ts
git commit -m "feat(engine): mark chain-derived cwd with origin: chain-cd"
```

---

### Task 3: `buildScopeConfig` — one ScopeConfig construction shared by evaluate and classify

**Files:**
- Modify: `src/engine/scope.ts` (append near `ScopeConfig`, around line 154)
- Modify: `src/engine/classify.ts:56-70`
- Test: `src/engine/scope_test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/engine/scope_test.ts`:

```ts
import { buildScopeConfig } from "./scope.ts";
import { EMPTY_RULES } from "../permissions/settings.ts";

Deno.test("buildScopeConfig wires root, home, rules and trusted roots", () => {
  const scope = buildScopeConfig("/proj", EMPTY_RULES, "/home/u", ["/trusted"]);
  assertEquals(scope.root, "/proj");
  assertEquals(scope.home, "/home/u");
  assertEquals(scope.trusted, ["/trusted"]);
  assertEquals(scope.allow, EMPTY_RULES.readScope.allow);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env src/engine/scope_test.ts`
Expected: FAIL — `buildScopeConfig` is not exported.

- [ ] **Step 3: Implement in `src/engine/scope.ts`**

Append after the `ScopeConfig` interface:

```ts
/**
 * 由 root / rules / home / trusted 建構 ScopeConfig。
 * evaluate 與 classify 皆呼叫此函式，確保兩處使用完全相同的範圍定義
 * （sessionCwdInScope 與逐葉的路徑判定不得有分歧）。
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

Add this import at the top of `src/engine/scope.ts` (type-only, no runtime cycle):

```ts
import type { PermissionRules } from "../permissions/settings.ts";
```

- [ ] **Step 4: Use it in `src/engine/classify.ts`**

Replace the inline `scope` construction inside `classify`:

```ts
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots);
```

and add `buildScopeConfig` to the existing `./scope.ts` import list.

- [ ] **Step 5: Run tests, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green (pure refactor — no behavior change).

- [ ] **Step 6: Commit**

```bash
git add src/engine/scope.ts src/engine/scope_test.ts src/engine/classify.ts
git commit -m "refactor(engine): extract buildScopeConfig shared by evaluate and classify"
```

---

### Task 4: `flagGatedReader` single-parse + `grep` PATTERN is not a path

**Files:**
- Modify: `src/rules/factory.ts`
- Modify: `src/rules/commands/grep.ts`
- Test: `src/rules/commands/grep_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/grep_test.ts`:

```ts
Deno.test("grep PATTERN is not scope-checked", () => {
  // pattern 看起來像專案外絕對路徑，但它是 pattern，不是檔案
  assertEquals(v("grep /etc/passwd in-project.txt"), "allow");
  assertEquals(v("grep -E 'Retry|backoff'"), "allow");
});

Deno.test("grep files are still scope-checked", () => {
  assertEquals(v("grep pat ../outside.txt"), "ask");
  assertEquals(v("grep pat a.txt b.txt"), "allow");
});

Deno.test("with -e / -f the first positional is a FILE again", () => {
  assertEquals(v("grep -e pat ../outside.txt"), "ask");
  assertEquals(v("grep --regexp=pat ../outside.txt"), "ask");
  assertEquals(v("grep -ie pat ../outside.txt"), "ask"); // cluster containing e
  assertEquals(v("grep -f pats.txt ../outside.txt"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: FAIL — `grep /etc/passwd in-project.txt` currently asks because the PATTERN is scope-checked.

- [ ] **Step 3: Add the option and single-parse helper to `src/rules/factory.ts`**

Add to `FlagGatedReaderOptions`:

```ts
  /**
   * 回 true 時，第一個位置參數視為「非路徑」（如 grep 的 PATTERN），不做範圍檢查。
   * 保守方向：無法確定時應回 false（多做一次路徑檢查 → 至多多問一次）。
   */
  nonPathLeadingPositional?: (argv: Word[]) => boolean;
```

Add above `flagGatedReader` (this is the single-parse source of truth required by spec §4.3.4):

```ts
/** flagGatedReader 對 argv 的唯一一次分類結果；evaluate 與 cwdIndependent 都只讀它。 */
export interface ArgvClassification {
  /** 需做 resolvePath 的位置參數（已扣除 nonPathLeadingPositional 指定的第一個）。 */
  pathOperands: Word[];
  /** 是否命中任一 pathValueFlags。 */
  pathValueFlagHit: boolean;
  /** 此次呼叫是否為遞迴遍歷。 */
  isRecursive: boolean;
}

/** 對 argv 做一次分類。此函式是 evaluate 與 cwdIndependent 的共同輸入來源。 */
export function classifyArgv(
  ctx: RuleContext,
  opts: FlagGatedReaderOptions,
): ArgvClassification {
  const valueFlags = opts.valueFlags ?? [];
  const pathValueFlagNames = opts.pathValueFlags ?? [];
  let pos = positionals(ctx.argv, valueFlags);
  if (pos.length > 0 && (opts.nonPathLeadingPositional?.(ctx.argv) ?? false)) {
    pos = pos.slice(1);
  }
  let pathValueFlagHit = false;
  for (const w of ctx.argv) {
    const t = staticValue(w);
    if (t === null || !t.startsWith("-")) continue;
    if (pathValueFlagNames.some((n) =>
      t === n || t.startsWith(n + "=") ||
      (n.length === 2 && !n.startsWith("--") && t.startsWith(n) && t.length > 2)
    )) {
      pathValueFlagHit = true;
      break;
    }
  }
  return {
    pathOperands: pos,
    pathValueFlagHit,
    isRecursive: opts.recursive?.(ctx.name, ctx.argv) ?? false,
  };
}
```

Then rewrite `flagGatedReader`'s `evaluate` to consume it:

```ts
export function flagGatedReader(opts: FlagGatedReaderOptions): CommandRule {
  const askFlags = opts.askFlags ?? [];
  return {
    names: opts.names,
    evaluate(ctx: RuleContext): RuleVerdict {
      if (askFlags.length && hasAnyFlag(ctx.argv, askFlags)) {
        return ask(opts.askReason?.(ctx.name) ?? `${ctx.name}：偵測到寫入 / 副作用參數`);
      }
      const pathFlagVerdict = checkPathValueFlags(ctx, opts.pathValueFlags ?? []);
      if (pathFlagVerdict) return pathFlagVerdict;
      const cls = classifyArgv(ctx, opts);
      // 遞迴遍歷時，危險根可能藏在「被 value-flag 吃掉的 token」位置，故掃描全部 argv token。
      if (cls.isRecursive) {
        for (const w of ctx.argv) {
          if (ctx.isDangerousRoot(w)) {
            return deny(recursiveRootDenyReason(ctx.name, w.value));
          }
        }
      }
      for (const arg of cls.pathOperands) {
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

- [ ] **Step 4: Wire the predicate in `src/rules/commands/grep.ts`**

Replace the whole file body after the imports with:

```ts
// grep 與 rg 共通：會吃下一 token 當值的 flag。
const VALUE_FLAGS = [
  exact(
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-d", "--directories", "--color", "--colour",
    "-r", "--replace", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-M",
  ),
];

// 短旗標群集含 r/R（如 -rn、-Rl）：僅作用於 grep 家族的遞迴偵測；漏判退回 ask（安全）。
const shortClusterHasR: FlagMatcher = (t) =>
  /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));

/**
 * GNU grep 3.0（`grep --help` 實測）：`grep [OPTION]... PATTERN [FILE]...`。
 * 給了 `-e/--regexp` 或 `-f/--file` 時 pattern 改由旗標提供，第一個位置參數變成 FILE。
 * 回 true 代表「pattern 由位置參數提供」→ 第一個位置參數不是路徑。
 * 保守方向：任一 token 動態（無法確定它是不是 -e）→ 回 false，照舊做路徑檢查。
 */
function patternIsLeadingPositional(argv: Word[]): boolean {
  for (const w of argv) {
    const t = staticValue(w);
    if (t === null) return false; // 動態 token：無法確定 → 保守
    if (!t.startsWith("-")) continue;
    if (t === "-e" || t === "--regexp" || t.startsWith("--regexp=")) return false;
    if (t === "-f" || t === "--file" || t.startsWith("--file=")) return false;
    if (t.startsWith("-e") && t.length > 2 && !t.startsWith("--")) return false; // -epat
    if (t.startsWith("-f") && t.length > 2 && !t.startsWith("--")) return false; // -fFILE
    // 短旗標群集含 e / f（GNU grep 的 -ie pattern 等於 -i -e pattern）
    if (/^-[A-Za-z]+$/.test(t) && /[ef]/.test(t.slice(1))) return false;
  }
  return true;
}

export const grepRule: CommandRule = flagGatedReader({
  names: ["grep", "egrep", "fgrep", "rg"],
  valueFlags: VALUE_FLAGS,
  // --exclude-from 會讀取一個檔案取得排除樣式，其值必須做範圍檢查（spec §4.3.3 護欄 5）。
  pathValueFlags: ["-f", "--file", "--exclude-from"],
  nonPathLeadingPositional: patternIsLeadingPositional,
  recursive: (n, a) =>
    n === "rg" ||
    hasAnyFlag(a, [
      exact("-r", "-R", "--recursive", "--dereference-recursive"),
      shortClusterHasR,
    ]),
});
```

Update the imports at the top of `grep.ts` to:

```ts
import type { CommandRule } from "../types.ts";
import type { Word } from "../../deps.ts";
import { flagGatedReader } from "../factory.ts";
import { exact, type FlagMatcher, hasAnyFlag } from "../flags.ts";
import { staticValue } from "../../engine/word.ts";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/grep_test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/grep.ts src/rules/commands/grep_test.ts
git commit -m "fix(rules): grep PATTERN is not a path; add single-parse classifyArgv"
```

---

### Task 5: extract `jq` into its own rule

**Files:**
- Create: `src/rules/commands/jq.ts`
- Create: `src/rules/commands/jq_test.ts`
- Modify: `src/rules/commands/coreutils.ts:12-18` (drop `"jq"` from `fileReaderRule` names)
- Modify: `src/rules/allowlist.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/rules/commands/jq_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { jqRule } from "./jq.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
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

function v(src: string) {
  return jqRule.evaluate(ctxOf(src)).kind;
}

Deno.test("jq filter is not treated as a path", () => {
  assertEquals(v("jq -r '.[] | select(.type==\"file\") | .name'"), "allow");
  assertEquals(v("jq ."), "allow");
  assertEquals(v("jq '/etc/passwd'"), "allow"); // filter that looks like a path
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

Deno.test("jq non-path two-value flags are not scope-checked", () => {
  assertEquals(v("jq --arg name ../outside '.'"), "allow");
  assertEquals(v("jq --argjson n 1 '.'"), "allow");
});

Deno.test("jq --args makes trailing positionals strings, not files", () => {
  assertEquals(v("jq -n '$ARGS.positional' --args ../outside a"), "allow");
});

Deno.test("jq unknown flags and dynamic tokens ask", () => {
  assertEquals(v("jq --totally-unknown ."), "ask");
  assertEquals(v("jq $FILTER"), "ask");
});

Deno.test("jq -- terminates option parsing", () => {
  assertEquals(v("jq -- . data.json"), "allow");
  assertEquals(v("jq -- . ../outside.json"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/jq_test.ts`
Expected: FAIL — module `./jq.ts` not found.

- [ ] **Step 3: Create `src/rules/commands/jq.ts`**

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

/**
 * jq 1.8.1（`jq --help` 本機實測）。用法：`jq [options] <jq filter> [file...]`。
 * jq 的 filter 語言沒有寫檔或執行外部程式的構造（無 system()、無輸出重導向），
 * 故不需要像 sed / awk 那樣掃描程式碼找副作用——只需正確分辨「哪些 token 是路徑」。
 */
const NO_VALUE_LONG = new Set([
  "--null-input", "--raw-input", "--slurp", "--compact-output", "--raw-output",
  "--raw-output0", "--join-output", "--ascii-output", "--sort-keys", "--color-output",
  "--monochrome-output", "--tab", "--unbuffered", "--stream", "--stream-errors",
  "--seq", "--args", "--jsonargs", "--exit-status", "--binary", "--version",
  "--build-configuration", "--help",
]);
/** 無值短旗標字母（可群集，如 -nr）。 */
const NO_VALUE_SHORT = new Set(["n", "R", "s", "c", "r", "j", "a", "S", "C", "M", "e", "b", "V", "h"]);
/** 吃一個非路徑值。 */
const ONE_NON_PATH = new Set(["--indent"]);
/** 吃一個路徑值。 */
const ONE_PATH = new Set(["-f", "--from-file", "-L", "--library-path"]);
/** 吃兩個值，皆非路徑。 */
const TWO_NON_PATH = new Set(["--arg", "--argjson"]);
/** 吃兩個值，第二個是路徑。 */
const TWO_SECOND_PATH = new Set(["--slurpfile", "--rawfile"]);

export const jqRule: CommandRule = {
  names: ["jq"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const argv = ctx.argv;
    const positional: typeof argv = [];
    let filterFromFile = false;
    let argsMode = false;
    let optionsDone = false;

    for (let i = 0; i < argv.length; i++) {
      const t = staticValue(argv[i]);
      if (t === null) return ask("jq：含動態 token，無法靜態判定");

      if (optionsDone || !t.startsWith("-") || t === "-") {
        positional.push(argv[i]);
        continue;
      }
      if (t === "--") { optionsDone = true; continue; }

      // 長旗標（含 --opt=value 形式）
      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        const name = eq === -1 ? t : t.slice(0, eq);
        const inline = eq === -1 ? null : t.slice(eq + 1);
        if (NO_VALUE_LONG.has(name)) {
          if (inline !== null) return ask(`jq：旗標 ${name} 不應帶值`);
          if (name === "--args" || name === "--jsonargs") argsMode = true;
          continue;
        }
        if (ONE_NON_PATH.has(name)) {
          if (inline === null) i++; // 吃掉值，不檢查
          continue;
        }
        if (ONE_PATH.has(name)) {
          let value = inline;
          if (value === null) {
            i++;
            value = i < argv.length ? staticValue(argv[i]) : null;
          }
          if (value === null) return ask(`jq：${name} 缺少值或值為動態`);
          if (ctx.resolvePathValue(value) !== "in-project") {
            return ask(`jq：${name} 的路徑值超出專案範圍或無法解析（${value}）`);
          }
          if (name === "-f" || name === "--from-file") filterFromFile = true;
          continue;
        }
        if (TWO_NON_PATH.has(name)) {
          i += inline === null ? 2 : 1; // --arg name value / --arg=name value
          continue;
        }
        if (TWO_SECOND_PATH.has(name)) {
          // --slurpfile name file / --rawfile name file：第二個值是路徑
          const fileIdx = inline === null ? i + 2 : i + 1;
          const value = fileIdx < argv.length ? staticValue(argv[fileIdx]) : null;
          if (value === null) return ask(`jq：${name} 缺少檔案值或值為動態`);
          if (ctx.resolvePathValue(value) !== "in-project") {
            return ask(`jq：${name} 的路徑值超出專案範圍或無法解析（${value}）`);
          }
          i = fileIdx;
          continue;
        }
        return ask(`jq：未列入安全集合的旗標 ${name}`);
      }

      // 短旗標（可群集）：逐字母比對；吃值字母後同 token 剩餘字元為值
      let consumed = false;
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (NO_VALUE_SHORT.has(c)) continue;
        const short = `-${c}`;
        if (ONE_PATH.has(short)) {
          const rest = t.slice(k + 1);
          let value: string | null = rest;
          if (rest === "") {
            i++;
            value = i < argv.length ? staticValue(argv[i]) : null;
          }
          if (value === null) return ask(`jq：${short} 缺少值或值為動態`);
          if (ctx.resolvePathValue(value) !== "in-project") {
            return ask(`jq：${short} 的路徑值超出專案範圍或無法解析（${value}）`);
          }
          if (c === "f") filterFromFile = true;
          consumed = true;
          break;
        }
        return ask(`jq：未列入安全集合的旗標 -${c}`);
      }
      if (consumed) continue;
    }

    // 位置參數：filter 未由 -f 提供時，第一個是 filter（不是路徑）
    let inputs = positional;
    if (!filterFromFile && inputs.length > 0) inputs = inputs.slice(1);
    if (argsMode) return allow(); // --args/--jsonargs 之後的位置參數是字串，不是檔案
    for (const p of inputs) {
      if (ctx.resolvePath(p) !== "in-project") {
        return ask(`jq：輸入路徑超出專案範圍或無法解析（${p.value}）`);
      }
    }
    return allow();
  },
};
```

- [ ] **Step 4: Remove `jq` from `fileReaderRule`**

In `src/rules/commands/coreutils.ts`, change the `names` array of `fileReaderRule` to drop `"jq"`:

```ts
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
```

- [ ] **Step 5: Register the rule in `src/rules/allowlist.ts`**

Add the import and the array entry:

```ts
import { jqRule } from "./commands/jq.ts";
```

and add `jqRule,` to the `RULES` array (after `grepRule,`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/jq_test.ts src/rules/allowlist_test.ts`
Expected: PASS. (`allowlist.ts` throws on duplicate names — a passing load proves `jq` was removed from `fileReaderRule`.)

- [ ] **Step 7: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/rules/commands/jq.ts src/rules/commands/jq_test.ts src/rules/commands/coreutils.ts src/rules/allowlist.ts
git commit -m "feat(rules): extract jq into its own rule; filter is not a path"
```

---

### Task 6: scope-check the unmodelled path-valued flags

**Files:**
- Modify: `src/rules/commands/coreutils.ts` (`fileReaderRule`, `diffRule`)
- Modify: `src/rules/commands/simple-flag.ts` (`sortRule`)
- Test: `src/rules/commands/coreutils_test.ts`, `src/rules/commands/simple-flag_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/coreutils_test.ts`:

```ts
Deno.test("wc --files0-from is scope-checked", () => {
  assertEquals(v("wc --files0-from=list.txt"), "allow");
  assertEquals(v("wc --files0-from=../outside/list.txt"), "ask");
});

Deno.test("realpath --relative-to / --relative-base are scope-checked", () => {
  assertEquals(v("realpath --relative-to=sub a.txt"), "allow");
  assertEquals(v("realpath --relative-to=../outside a.txt"), "ask");
  assertEquals(v("realpath --relative-base=../outside a.txt"), "ask");
});

Deno.test("diff -X / -S are scope-checked", () => {
  assertEquals(v("diff -X ex.txt a.txt b.txt"), "allow");
  assertEquals(v("diff -X ../outside.txt a.txt b.txt"), "ask");
  assertEquals(v("diff --starting-file=../outside a.txt b.txt"), "ask");
});
```

Append to `src/rules/commands/simple-flag_test.ts`:

```ts
Deno.test("sort --files0-from is scope-checked", () => {
  assertEquals(v("sort --files0-from=list.txt"), "allow");
  assertEquals(v("sort --files0-from=../outside/list.txt"), "ask");
});
```

(Use each test file's existing `v` helper; if a file's helper is bound to one command name, extend it to take the command name from the source string the same way the existing tests do.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts`
Expected: FAIL — the out-of-project variants currently return `allow` because the values are skipped as flags.

- [ ] **Step 3: Add the flags in `src/rules/commands/coreutils.ts`**

`fileReaderRule` gains `valueFlags` and `pathValueFlags` (verified from `wc --help` and `realpath --help`):

```ts
export const fileReaderRule: CommandRule = flagGatedReader({
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
  // 吃路徑值但過去未建模的旗標（實測 --help）：
  //   wc/sort  --files0-from=F   從 F 讀 NUL 分隔的檔名清單
  //   realpath --relative-to=DIR / --relative-base=DIR
  valueFlags: [exact("--files0-from", "--relative-to", "--relative-base")],
  pathValueFlags: ["--files0-from", "--relative-to", "--relative-base"],
  // 這些指令無「會寫檔」的 flag（已於 spec 查證）；故 askFlags 留空。
  recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")]),
});
```

`diffRule` gains the two extra path-valued flags (verified from `diff --help`):

```ts
/** diff：位置參數做範圍檢查，且吃路徑值的旗標也需範圍檢查。 */
export const diffRule: CommandRule = flagGatedReader({
  names: ["diff"],
  valueFlags: [exact("--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file")],
  pathValueFlags: ["--from-file", "--to-file", "-X", "--exclude-from", "-S", "--starting-file"],
});
```

- [ ] **Step 4: Add the flag in `src/rules/commands/simple-flag.ts`**

```ts
export const sortRule: CommandRule = flagGatedReader({
  names: ["sort"],
  askFlags: [exact("-o", "--output", "-T", "--temporary-directory"), prefix("-o", "--output=", "-T", "--temporary-directory=")],
  valueFlags: [exact("-o", "-T", "-S", "-k", "-t", "--output", "--temporary-directory", "--buffer-size", "--key", "--field-separator", "--files0-from")],
  pathValueFlags: ["--files0-from"],
  askReason: () => "sort：-o / -T 會寫檔或指定暫存目錄",
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/commands/coreutils.ts src/rules/commands/simple-flag.ts src/rules/commands/coreutils_test.ts src/rules/commands/simple-flag_test.ts
git commit -m "fix(rules): scope-check --files0-from, --relative-to/-base, diff -X/-S"
```

---

### Task 7: `gh` flag allowlist + local side-effect flags

**Files:**
- Modify: `src/rules/commands/gh.ts`
- Test: `src/rules/commands/gh_test.ts`

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
  assertEquals(v("gh pr diff --name-only"), "allow");
});

Deno.test("gh mutating flags still ask", () => {
  assertEquals(v("gh api repos/o/r -X POST"), "ask");
  assertEquals(v("gh api repos/o/r -f a=b"), "ask");
  assertEquals(v("gh api repos/o/r --input body.json"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: FAIL — `--web`, `--cache`, and unknown flags currently return `allow`.

- [ ] **Step 3: Implement the flag tables in `src/rules/commands/gh.ts`**

Add above `ghRule` (all flag names verified from `gh <sub> --help`, gh 2.93.0):

```ts
/** 本機副作用旗標：開瀏覽器 / 寫本機快取。對所有子指令一律 ask（spec §4.4）。 */
const LOCAL_SIDE_EFFECT = new Set(["-w", "--web", "--cache"]);

/** 全部子指令共用的安全旗標。 */
const COMMON_NO_VALUE = new Set(["-h", "--help"]);
const COMMON_ONE_VALUE = new Set(["--json", "-q", "--jq", "-t", "--template"]);

/** `gh api` 專屬安全旗標。 */
const API_NO_VALUE = new Set(["--paginate", "--silent", "--slurp", "-i", "--include", "--verbose"]);
const API_ONE_VALUE = new Set(["-H", "--header", "--hostname", "-p", "--preview", "-X", "--method"]);

/** `gh search *` 專屬安全旗標。 */
const SEARCH_NO_VALUE = new Set(["--archived"]);
const SEARCH_ONE_VALUE = new Set([
  "-L", "--limit", "-R", "--repo", "--owner", "--language", "--match", "--sort",
  "--order", "--state", "--filename", "--extension", "--size", "--label",
  "--author", "--assignee", "--created", "--updated", "--visibility", "--include-forks",
]);

/** repo / issue / pr / release 唯讀子指令的專屬安全旗標。 */
const READ_NO_VALUE = new Set(["--patch", "--name-only"]);
const READ_ONE_VALUE = new Set([
  "-R", "--repo", "-L", "--limit", "-s", "--state", "--label", "--author",
  "--assignee", "--search", "--color", "-e", "--exclude",
]);

interface FlagTable { noValue: Set<string>; oneValue: Set<string> }

function flagTableFor(command: string): FlagTable {
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

/** 命中本機副作用旗標（`-w` / `--web` / `--cache`，含 `--cache=…` 與短旗標群集）。 */
export function ghHasLocalSideEffect(toks: string[]): boolean {
  for (const t of toks) {
    if (!t.startsWith("-")) continue;
    const name = t.startsWith("--") ? (t.includes("=") ? t.slice(0, t.indexOf("=")) : t) : t;
    if (LOCAL_SIDE_EFFECT.has(name)) return true;
    if (!t.startsWith("--") && /^-[A-Za-z]+$/.test(t) && t.includes("w")) return true; // -qw 群集
  }
  return false;
}

/**
 * 旗標 allowlist：未列入者一律 ask（spec §4.5）。
 * 這同時解決版本漂移：新 gh 版本新增的旗標都是未知旗標 → ask。
 * 回 true 代表全部旗標皆安全。
 */
export function ghFlagsAllKnown(command: string, toks: string[]): boolean {
  const table = flagTableFor(command);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (table.noValue.has(name)) { if (eq !== -1) return false; continue; }
      if (table.oneValue.has(name)) { if (eq === -1) i++; continue; }
      return false;
    }
    // 短旗標群集：逐字母比對；吃值字母後同 token 剩餘字元為值
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (table.noValue.has(short)) continue;
      if (table.oneValue.has(short)) {
        if (t.slice(k + 1) === "") i++;
        ate = true;
        break;
      }
      return false;
    }
    if (ate) continue;
  }
  return true;
}
```

- [ ] **Step 4: Call them from `ghRule.evaluate`**

Insert immediately after `const after = toks.slice(cmdIdx + 1);`:

```ts
    // 本機副作用（開瀏覽器 / 寫快取）：對所有子指令一律 ask。
    if (ghHasLocalSideEffect(toks)) {
      return ask("gh：-w/--web 會開啟本機瀏覽器、--cache 會寫入本機快取");
    }
    // 旗標 allowlist：未知旗標一律 ask（含未來 gh 版本新增者）。
    if (!ghFlagsAllKnown(command, toks)) {
      return ask(`gh ${command}：含未列入安全集合的旗標`);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/commands/gh.ts src/rules/commands/gh_test.ts
git commit -m "fix(rules): gh flag allowlist; -w/--web and --cache are local side effects"
```

---

### Task 8: `gh api` endpoint operand tolerance + placeholder detection

**Files:**
- Modify: `src/rules/commands/gh.ts`
- Test: `src/rules/commands/gh_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/gh_test.ts`:

```ts
Deno.test("gh api tolerates a single-? query string in the endpoint", () => {
  assertEquals(v("gh api repos/o/r/tags?per_page=50"), "allow");
  assertEquals(v("gh api repos/o/r/contents/pkg/x.go?ref=v1.18.0"), "allow");
});

Deno.test("gh api rejects other glob shapes in the endpoint", () => {
  assertEquals(v("gh api repos/o/*/x"), "ask"); // *
  assertEquals(v("gh api rep?s/o/r/x"), "ask"); // ? before the first /
  assertEquals(v("gh api ?x"), "ask"); // metachar at index 0
  assertEquals(v("gh api a?b c?d"), "ask"); // more than one non-static token
});

Deno.test("the tolerance applies only to the api endpoint operand", () => {
  assertEquals(v("gh api x -H Accept:a?b"), "ask"); // flag value never tolerated
  assertEquals(v("gh issue list --repo o/r?x"), "ask"); // subcommand is not api
});

Deno.test("gh api rejects cwd-derived endpoint placeholders", () => {
  // gh api --help: {owner}/{repo}/{branch} are filled from the repo of the current directory
  assertEquals(v("gh api 'repos/{owner}/{repo}/issues'"), "ask");
  assertEquals(v("gh api 'repos/o/r/commits/{branch}'"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: FAIL — the `?per_page=50` cases ask, and the placeholder cases allow.

- [ ] **Step 3: Implement in `src/rules/commands/gh.ts`**

Add near the other helpers:

```ts
/** endpoint 含 cwd 推導的佔位符（`gh api --help`：由 current directory 的 repo 填入）。 */
export function endpointHasCwdPlaceholder(endpoint: string): boolean {
  return endpoint.includes("{owner}") || endpoint.includes("{repo}") ||
    endpoint.includes("{branch}");
}

/**
 * §4.2.2 gh 護欄：endpoint 的 glob 元字元必須出現在第一個 `/` 之後，
 * 確保第一段（repos / search / orgs …）為字面。無元字元時恆成立。
 */
function endpointMetacharAfterFirstSlash(endpoint: string): boolean {
  const g = firstGlobMetacharIndex(endpoint);
  if (g === -1) return true;
  const slash = endpoint.indexOf("/");
  return slash !== -1 && g > slash;
}
```

Add the imports at the top of `gh.ts`:

```ts
import { firstGlobMetacharIndex, nonPathStaticValue, staticValue } from "../../engine/word.ts";
import type { Word } from "../../deps.ts";
```

Replace the token-collection block at the start of `ghRule.evaluate` with:

```ts
    // 先全部 staticValue，記下唯一可補救的位置（spec §4.2.4）。
    const toks: string[] = [];
    let nullCount = 0;
    let nullIdx = -1;
    for (let i = 0; i < ctx.argv.length; i++) {
      const t = staticValue(ctx.argv[i]);
      if (t === null) {
        nullCount++;
        nullIdx = i;
        toks.push("\u0000"); // 佔位；補救成功才替換
      } else {
        toks.push(t);
      }
    }
    if (nullCount > 1) return ask("gh：含一個以上動態 token，無法靜態判定");

    // command = 第一個非旗標 token（必須是靜態的）
    const cmdIdx = toks.findIndex((t) => t !== "\u0000" && !t.startsWith("-"));
    if (cmdIdx === -1) return ask("gh：未指定指令或指令為動態");
    const command = toks[cmdIdx];

    if (nullCount === 1) {
      // 只有 `gh api` 的 endpoint 操作元可套用寬鬆取值。
      const relaxed = nonPathStaticValue(ctx.argv[nullIdx]);
      if (command !== "api" || relaxed === null || relaxed.startsWith("-")) {
        return ask("gh：含動態 token，無法靜態判定");
      }
      if (!endpointMetacharAfterFirstSlash(relaxed)) {
        return ask(`gh api：endpoint 的萬用字元位置不安全（${relaxed}）`);
      }
      // 位置必須就是 api 之後的第一個位置操作元
      const firstOperandIdx = toks.findIndex((t, i) =>
        i > cmdIdx && (i === nullIdx || (!t.startsWith("-") && t !== "\u0000"))
      );
      if (firstOperandIdx !== nullIdx) {
        return ask("gh：動態 token 不在 endpoint 位置");
      }
      toks[nullIdx] = relaxed;
    }

    const after = toks.slice(cmdIdx + 1);
```

Then, inside the existing `if (command === "api") { … }` branch, add the placeholder check before the `ghApiMutates` decision:

```ts
    if (command === "api") {
      const endpoint = after.find((t) => !t.startsWith("-"));
      if (endpoint !== undefined && endpointHasCwdPlaceholder(endpoint)) {
        return ask("gh api：endpoint 含 {owner}/{repo}/{branch}，目標由 cwd 的 git repo 決定");
      }
      return ghApiMutates(after) ? ask("gh api：非 GET（寫入）請求") : allow();
    }
```

> Note: the `firstOperandIdx` scan treats `--opt value` conservatively — a value token that follows a one-value flag is not a positional. `ghFlagsAllKnown` already walked the same flag table, so any layout it could not classify has already returned `ask` before this point.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/gh_test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/gh.ts src/rules/commands/gh_test.ts
git commit -m "feat(rules): tolerate single-? query strings in the gh api endpoint operand"
```

---

### Task 9: `curl` URL operand tolerance + authority guard

**Files:**
- Modify: `src/rules/commands/curl.ts`
- Test: `src/rules/commands/curl_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/rules/commands/curl_test.ts` (reuse the file's existing helper that allows `example.com`):

```ts
Deno.test("curl tolerates an unquoted single-? query string in the URL", () => {
  assertEquals(allowed("curl -s https://example.com/p?q=1"), "allow");
  assertEquals(allowed("curl -s https://example.com?q=1"), "allow"); // no path segment
});

Deno.test("curl rejects metachars inside the authority", () => {
  assertEquals(allowed("curl -s https://ex?mple.com/p"), "ask");
  assertEquals(allowed("curl -s http?://example.com/p"), "ask");
  assertEquals(allowed("curl -s https://ex?mple"), "ask");
});

Deno.test("curl never tolerates metachars in flags or flag values", () => {
  assertEquals(allowed("curl -H Accept:a?b https://example.com/p"), "ask");
  assertEquals(allowed("curl --max-time 1?0 https://example.com/p"), "ask");
});

Deno.test("curl still rejects * and [ in the URL", () => {
  assertEquals(allowed("curl -s https://example.com/a*b"), "ask");
  assertEquals(allowed("curl -s 'https://example.com/a[1-3]b'"), "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: FAIL — the `?q=1` cases currently ask with "curl：動態參數無法判定".

- [ ] **Step 3: Implement in `src/rules/commands/curl.ts`**

Add near the top, after the flag sets:

```ts
/**
 * §4.2.2 authority 護欄：URL 的 glob 元字元必須出現在 authority 之後。
 * authority 結束位置 = `scheme://` 之後第一個 `/`、`?` 或 `#` 的索引（三者取最小；
 * 皆不存在則為字串結尾）。這使 `https://host?q=1`（無路徑段）也能正確通過。
 */
function metacharAfterAuthority(url: string): boolean {
  const g = firstGlobMetacharIndex(url);
  if (g === -1) return true;
  const schemeEnd = url.indexOf("://");
  const from = schemeEnd === -1 ? 0 : schemeEnd + 3;
  let end = url.length;
  for (const ch of ["/", "?", "#"]) {
    const idx = url.indexOf(ch, from);
    if (idx !== -1 && idx < end) end = idx;
  }
  return g >= end;
}
```

Add to the imports:

```ts
import { firstGlobMetacharIndex, nonPathStaticValue, staticValue } from "../../engine/word.ts";
```

In `curlRule.evaluate`, replace the loop's opening `const t = staticValue(argv[i]); if (t === null) return ask(...)` with a two-stage read that only rescues a positional:

```ts
    const argv = ctx.argv;
    const urls: string[] = [];
    // 全 argv 只允許一個非靜態 token，且它必須落在位置參數（URL 候選）位置。
    const nullIdxs = argv.map((w, i) => (staticValue(w) === null ? i : -1)).filter((i) => i >= 0);
    if (nullIdxs.length > 1) return ask("curl：含一個以上動態參數，無法判定");
    const relaxIdx = nullIdxs.length === 1 ? nullIdxs[0] : -1;

    for (let i = 0; i < argv.length; i++) {
      let t = staticValue(argv[i]);
      if (t === null) {
        // 旗標與旗標值永不套用寬鬆取值；此處只可能是位置參數（否則下方分支會 ask）。
        const relaxed = i === relaxIdx ? nonPathStaticValue(argv[i]) : null;
        if (relaxed === null || relaxed.startsWith("-")) {
          return ask("curl：動態參數無法判定");
        }
        t = relaxed;
      }
```

Everywhere the loop reads a *flag value* via `staticValue(argv[i])` (the `--opt value`, `-H value` and `-m value` branches), leave those calls as `staticValue` — a `null` there must still `ask`. That is already the existing behavior; do not change those lines.

Finally, apply the authority guard just before the domain check:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/rules/commands/curl.ts src/rules/commands/curl_test.ts
git commit -m "feat(rules): tolerate single-? query strings in the curl URL operand"
```

---

### Task 10: `cwdIndependent` wiring in classify/evaluate + first declarer (`pureUtilRule`)

**Files:**
- Modify: `src/rules/types.ts`
- Modify: `src/engine/classify.ts`
- Modify: `src/engine/evaluate.ts`
- Modify: `src/rules/commands/coreutils.ts` (`pureUtilRule`)
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`:

```ts
function decide(src: string, start: CwdState = START) {
  const invs = walk(parseCommand(src).script, start, ROOT);
  return evaluate(src, ROOT, start);
}

Deno.test("chain cd out of project no longer asks for cwd-independent commands", () => {
  assertEquals(decide("cd /tmp && echo hi").verdict, "allow");
  assertEquals(decide("cd /tmp && pwd").verdict, "allow");
  assertEquals(decide("cd /tmp && whoami").verdict, "allow");
});

Deno.test("guardrail: which is never cwd-independent (PATH may contain .)", () => {
  assertEquals(decide("cd /tmp && which some-name").verdict, "ask");
});

Deno.test("guardrail 2: an out-of-scope session cwd cannot self-authorize", () => {
  const dirty: CwdState = { kind: "known", path: "/outside" };
  assertEquals(decide("cd . && echo hi", dirty).verdict, "ask");
  assertEquals(decide("cd /tmp && echo hi", dirty).verdict, "ask");
});

Deno.test("guardrail 3: path operands are still resolved against the real cwd", () => {
  assertEquals(decide("cd /tmp && cat a.txt").verdict, "ask");
});

Deno.test("guardrail 4: a non-static token blocks the exemption", () => {
  assertEquals(decide("cd /tmp && echo *").verdict, "ask");
});

Deno.test("commands that implicitly act on cwd still ask", () => {
  assertEquals(decide("cd /tmp && ls").verdict, "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL — every `cd /tmp && …` case currently asks with "工作目錄超出允許範圍".

- [ ] **Step 3: Declare the predicates in `src/rules/types.ts`**

Add to the `CommandRule` interface:

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
   * 注意 (c) 是「判定不依賴展開結果」，不是「不含 glob 元字元」。
   * 未宣告 = 否（default-deny）。必須為純函式、不得有副作用。
   */
  cwdIndependent?(ctx: RuleContext): boolean;
  /**
   * 此次呼叫是否僅含「spec §4.2 明文容忍且已證明 verdict 不變的 endpoint / URL 操作元」
   * 這一種非靜態 token（其餘 token 皆靜態）。只有 gh / curl 宣告；必須為純函式。
   */
  toleratesNonStaticOperand?(ctx: RuleContext): boolean;
}
```

- [ ] **Step 4: Wire it in `src/engine/classify.ts`**

Change `centralPreflightAsk`'s signature and rule 1:

```ts
function centralPreflightAsk(
  inv: CommandInvocation,
  scope: ScopeConfig,
  skipCwdCheck: boolean,
): RuleVerdict | null {
  // 一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）。
  // skipCwdCheck 由 classify 依五道護欄算出；規則二/三/四不受影響。
  if (
    !skipCwdCheck && inv.cwd.kind === "known" &&
    !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)
  ) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // …（其餘三條完全不變）
```

Change `classify`'s signature to take `sessionCwdInScope`, hoist the `RuleContext`, and compute the exemption:

```ts
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
  // 缺省 false = 起點不可信 → 永不豁免（fail-safe，既有呼叫端行為不變）
  sessionCwdInScope = false,
): RuleVerdict {
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots);

  // 步驟 1：動態指令名
  if (inv.name === null) return ask("動態指令名，無法判定");

  // 步驟 2：指令規則評估 + 硬 deny 短路
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

  // 護欄 4：argv 必須全為靜態 token；唯一例外是 §4.2 容忍的 endpoint / URL 操作元，
  // 由規則自身以 toleratesNonStaticOperand 認定。
  const allArgvStatic = inv.argv.every((w) => staticValue(w) !== null);
  const cwdExempt = ruleVerdict?.kind === "allow" && // 護欄 1
    sessionCwdInScope && // 護欄 2（起點可信）
    inv.cwd.kind === "known" &&
    inv.cwd.origin === "chain-cd" && // 護欄 2（鏈內 cd）
    (allArgvStatic || (rule?.toleratesNonStaticOperand?.(ctx) ?? false)) && // 護欄 4
    (rule?.cwdIndependent?.(ctx) ?? false);

  // 步驟 3：四條中央前置（通用、不可升級）
  const central = centralPreflightAsk(inv, scope, cwdExempt);
  if (central) return central;

  // …（步驟 4、5 完全不變）
```

Add `staticValue` and `RuleContext` to `classify.ts`'s imports:

```ts
import type { RuleContext } from "../rules/types.ts";
import { staticValue } from "./word.ts";
```

- [ ] **Step 5: Compute `sessionCwdInScope` in `src/engine/evaluate.ts`**

Replace the final `combine(...)` line:

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

Add the import:

```ts
import { buildScopeConfig, isReadScoped, normalizeAbsolute } from "./scope.ts";
```

- [ ] **Step 6: Declare `pureUtilRule` in `src/rules/commands/coreutils.ts`**

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

- [ ] **Step 7: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/rules/types.ts src/engine/classify.ts src/engine/evaluate.ts src/rules/commands/coreutils.ts src/engine/classify_test.ts
git commit -m "feat(engine): cwd-independent exemption for central preflight rule 1"
```

---

### Task 11: guardrail 5 flag table + `flagGatedReader` / `positionalOutputRule` opt-ins

**Files:**
- Modify: `src/rules/factory.ts`
- Modify: `src/rules/commands/coreutils.ts`, `simple-flag.ts`, `positional-output.ts`, `tail.ts`, `grep.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`:

```ts
Deno.test("stdin-only filters become cwd-independent after chain cd", () => {
  for (const cmd of ["cat", "head -100", "wc -l", "cut -c1", "tr a b", "nl", "fold -w 80", "sort", "uniq", "xxd", "tail -200", "yq"]) {
    assertEquals(decide(`cd /tmp && ${cmd}`).verdict, "allow", cmd);
  }
  assertEquals(decide("cd /tmp && grep -E 'Retry'").verdict, "allow");
  assertEquals(decide("cd /tmp && sed -n '600,750p'").verdict, "allow");
  assertEquals(decide("cd /tmp && awk '{print $1}'").verdict, "allow");
  assertEquals(decide("cd /tmp && jq -r '.name'").verdict, "allow");
});

Deno.test("the same commands with a path operand still ask", () => {
  assertEquals(decide("cd /tmp && cat a.txt").verdict, "ask");
  assertEquals(decide("cd /tmp && wc -l a.txt").verdict, "ask");
  assertEquals(decide("cd /tmp && grep pat a.txt").verdict, "ask");
});

Deno.test("guardrail 5: a path-valued flag or unknown flag blocks the exemption", () => {
  assertEquals(decide("cd /tmp && wc --files0-from=list").verdict, "ask");
  assertEquals(decide("cd /tmp && sort --files0-from=list").verdict, "ask");
  assertEquals(decide("cd /tmp && grep --exclude-from=f pat").verdict, "ask");
  assertEquals(decide("cd /tmp && wc --some-unknown-flag").verdict, "ask");
});

Deno.test("cwd-dependent readers are never exempt", () => {
  assertEquals(decide("cd /tmp && ls").verdict, "ask");
  assertEquals(decide("cd /tmp && tree").verdict, "ask");
  assertEquals(decide("cd /tmp && file x").verdict, "ask");
  assertEquals(decide("cd /tmp && date -r x").verdict, "ask");
  assertEquals(decide("cd /tmp && rg pat").verdict, "ask");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL — the stdin-only filters still ask.

- [ ] **Step 3: Add the opt-in options to `src/rules/factory.ts`**

Add to `FlagGatedReaderOptions`:

```ts
  /** opt-in：無路徑操作元、非遞迴、未命中 pathValueFlags、且所有旗標命中已知旗標表時視為 cwd 無關。 */
  cwdIndependentWhenNoPaths?: boolean;
  /** 上述 opt-in 的例外名單（隱含以 cwd 為操作對象者，如 ls）。 */
  cwdDependentNames?: string[];
  /** 護欄 5 的已知旗標表：per-name 列出 (i) 無值旗標與 (ii) 吃非路徑值的旗標。 */
  knownFlags?: Record<string, { noValue: string[]; nonPathValue: string[] }>;
```

Add the guardrail-5 checker above `flagGatedReader`:

```ts
/**
 * 護欄 5：每個以 `-` 開頭的 argv token 都必須命中該指令的已知旗標表。
 * 未列入者 → 不豁免（fail-closed）。這使「日後新增或本次仍漏掉的路徑值旗標」
 * 最壞只是維持現行 ask，而不會變成誤放行。
 */
function allFlagsKnown(ctx: RuleContext, opts: FlagGatedReaderOptions): boolean {
  const table = opts.knownFlags?.[ctx.name];
  if (!table) return false; // 未提供旗標表 → 不豁免
  const noValue = new Set(table.noValue);
  const oneValue = new Set(table.nonPathValue);
  const argv = ctx.argv;
  for (let i = 0; i < argv.length; i++) {
    const t = staticValue(argv[i]);
    if (t === null) return false;
    if (!t.startsWith("-") || t === "-") continue;
    if (t === "--") break;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      if (noValue.has(name)) { if (eq !== -1) return false; continue; }
      if (oneValue.has(name)) { if (eq === -1) i++; continue; }
      return false;
    }
    let ate = false;
    for (let k = 1; k < t.length; k++) {
      const short = `-${t[k]}`;
      if (noValue.has(short)) continue;
      if (oneValue.has(short)) { if (t.slice(k + 1) === "") i++; ate = true; break; }
      // 數字尾綴（head -100 / tail -200）視為值的一部分
      if (/[0-9]/.test(t[k])) { ate = true; break; }
      return false;
    }
    if (ate) continue;
  }
  return true;
}
```

Attach the predicate to the returned rule inside `flagGatedReader`:

```ts
  return {
    names: opts.names,
    evaluate(ctx: RuleContext): RuleVerdict { /* …unchanged… */ },
    cwdIndependent: opts.cwdIndependentWhenNoPaths
      ? (ctx: RuleContext) => {
        if ((opts.cwdDependentNames ?? []).includes(ctx.name)) return false;
        const cls = classifyArgv(ctx, opts); // 單一解析來源：與 evaluate 同一函式
        return !cls.isRecursive && !cls.pathValueFlagHit &&
          cls.pathOperands.length === 0 && allFlagsKnown(ctx, opts);
      }
      : undefined,
  };
```

- [ ] **Step 4: Add the same mechanism to `src/rules/commands/positional-output.ts`**

```ts
/** `cmd [INPUT [OUTPUT]]`：≥2 個位置參數代表有輸出檔 → ask；否則檢查輸入路徑。 */
function positionalOutputRule(
  names: string[],
  valueFlags: FlagMatcher[],
  knownFlags: Record<string, { noValue: string[]; nonPathValue: string[] }>,
): CommandRule {
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
    // 無位置參數（純 stdin 過濾）且所有旗標已知時，判定與 cwd 無關。
    cwdIndependent(ctx: RuleContext): boolean {
      if (positionals(ctx.argv, valueFlags).length !== 0) return false;
      return flagsKnown(ctx, knownFlags[ctx.name]);
    },
  };
}
```

Add a local `flagsKnown` helper to the same file with the identical semantics as `allFlagsKnown` (export it from `factory.ts` instead of duplicating: add `export` to `allFlagsKnown` and import it here as `flagsKnownFor(ctx, table)` taking the table directly).

Concretely: in `factory.ts`, change the helper's signature to take the table and export it:

```ts
export function flagsKnown(
  ctx: RuleContext,
  table: { noValue: string[]; nonPathValue: string[] } | undefined,
): boolean { /* body as above, using `table` directly */ }
```

and have `allFlagsKnown(ctx, opts)` call `flagsKnown(ctx, opts.knownFlags?.[ctx.name])`.

Then wire the two rules:

```ts
export const xxdRule = positionalOutputRule(["xxd"], XXD_VALUE_FLAGS, {
  xxd: { noValue: ["-a", "-b", "-C", "-E", "-e", "-i", "-t", "-p", "-r", "-u"], nonPathValue: ["-c", "-g", "-l", "-n", "-o", "-s"] },
});
export const uniqRule = positionalOutputRule(["uniq"], UNIQ_VALUE_FLAGS, {
  uniq: { noValue: ["-c", "--count", "-d", "--repeated", "-i", "--ignore-case", "-u", "--unique", "-z", "--zero-terminated"], nonPathValue: ["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"] },
});
```

- [ ] **Step 5: Opt in the reader rules**

`src/rules/commands/coreutils.ts` — `fileReaderRule` gains:

```ts
  cwdIndependentWhenNoPaths: true,
  // ls 無操作元時列出 cwd，故永不豁免。
  cwdDependentNames: ["ls"],
  knownFlags: {
    cat: { noValue: ["-A", "-b", "-e", "-E", "-n", "-s", "-t", "-T", "-u", "-v", "--number", "--squeeze-blank", "--show-ends"], nonPathValue: [] },
    head: { noValue: ["-q", "--quiet", "-v", "--verbose", "-z"], nonPathValue: ["-c", "--bytes", "-n", "--lines"] },
    wc: { noValue: ["-c", "--bytes", "-m", "--chars", "-l", "--lines", "-L", "--max-line-length", "-w", "--words"], nonPathValue: [] },
    stat: { noValue: ["-L", "--dereference", "-t", "--terse"], nonPathValue: ["-c", "--format", "--printf"] },
    cut: { noValue: ["-s", "--only-delimited", "--complement", "-z"], nonPathValue: ["-b", "--bytes", "-c", "--characters", "-d", "--delimiter", "-f", "--fields", "--output-delimiter"] },
    tr: { noValue: ["-c", "-C", "--complement", "-d", "--delete", "-s", "--squeeze-repeats", "-t", "--truncate-set1"], nonPathValue: [] },
    column: { noValue: ["-t", "-x"], nonPathValue: ["-c", "-s", "-o"] },
    cmp: { noValue: ["-b", "--print-bytes", "-l", "--verbose", "-s", "--silent", "--quiet"], nonPathValue: ["-i", "--ignore-initial", "-n", "--bytes"] },
    comm: { noValue: ["-1", "-2", "-3", "--total", "-z"], nonPathValue: ["--output-delimiter"] },
    md5sum: { noValue: ["-b", "--binary", "-t", "--text", "-z", "--zero", "--tag"], nonPathValue: [] },
    sha256sum: { noValue: ["-b", "--binary", "-t", "--text", "-z", "--zero", "--tag"], nonPathValue: [] },
    hexdump: { noValue: ["-b", "-c", "-C", "-d", "-o", "-x", "-v"], nonPathValue: ["-e", "-n", "-s"] },
    nl: { noValue: ["-p", "--no-renumber"], nonPathValue: ["-b", "--body-numbering", "-d", "--section-delimiter", "-f", "--footer-numbering", "-h", "--header-numbering", "-i", "--line-increment", "-l", "--join-blank-lines", "-n", "--number-format", "-s", "--number-separator", "-v", "--starting-line-number", "-w", "--number-width"] },
    fold: { noValue: ["-b", "--bytes", "-s", "--spaces"], nonPathValue: ["-w", "--width"] },
    basename: { noValue: ["-a", "--multiple", "-z", "--zero"], nonPathValue: ["-s", "--suffix"] },
    dirname: { noValue: ["-z", "--zero"], nonPathValue: [] },
    realpath: { noValue: ["-e", "--canonicalize-existing", "-m", "--canonicalize-missing", "-L", "--logical", "-P", "--physical", "-q", "--quiet", "-s", "--strip", "--no-symlinks", "-z", "--zero"], nonPathValue: [] },
    readlink: { noValue: ["-f", "--canonicalize", "-e", "--canonicalize-existing", "-m", "--canonicalize-missing", "-n", "--no-newline", "-q", "--quiet", "-s", "--silent", "-v", "--verbose", "-z", "--zero"], nonPathValue: [] },
  },
```

`diffRule` gains:

```ts
  cwdIndependentWhenNoPaths: true,
  knownFlags: { diff: { noValue: ["-q", "--brief", "-s", "--report-identical-files", "-u", "-c", "-y", "-i", "-w", "-b", "-B", "-a", "-r"], nonPathValue: ["-U", "--unified", "-C", "--context", "-W", "--width", "--label"] } },
```

`src/rules/commands/simple-flag.ts` — `sortRule` and `yqRule` gain:

```ts
// sortRule
  cwdIndependentWhenNoPaths: true,
  knownFlags: { sort: { noValue: ["-b", "-d", "-f", "-g", "-h", "-i", "-M", "-n", "-r", "-R", "-u", "-V", "-z", "-c", "-C", "-s", "--stable", "--reverse", "--unique", "--numeric-sort"], nonPathValue: ["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "--parallel"] } },

// yqRule
  cwdIndependentWhenNoPaths: true,
  knownFlags: { yq: { noValue: ["-r", "--raw-output", "-n", "--null-input", "-e", "--exit-status", "-N", "--no-colors", "-C", "--colors", "-M", "-P", "--prettyPrint", "-s", "--slurp"], nonPathValue: ["-o", "--output-format", "-p", "--input-format", "-I", "--indent"] } },
```

`treeRule`, `fileCmdRule`, `dateRule` are **deliberately left without** `cwdIndependentWhenNoPaths` — add this comment above each:

```ts
// 刻意不宣告 cwdIndependentWhenNoPaths：tree 無操作元時遞迴 cwd；
// file / date 的 valueFlags 含吃路徑的旗標（-m/-f、-r/-f）但未列入 pathValueFlags（spec §8.3）。
```

`src/rules/commands/tail.ts` gains:

```ts
  cwdIndependentWhenNoPaths: true,
  knownFlags: { tail: { noValue: ["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"], nonPathValue: ["-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats"] } },
```

`src/rules/commands/grep.ts` gains:

```ts
  cwdIndependentWhenNoPaths: true,
  knownFlags: {
    grep: { noValue: ["-E", "-F", "-G", "-P", "-i", "-v", "-w", "-x", "-c", "-l", "-L", "-o", "-q", "-s", "-n", "-b", "-H", "-h", "-a", "-I", "-z", "-U", "--color", "--colour", "--extended-regexp", "--fixed-strings", "--ignore-case", "--invert-match", "--line-number", "--no-filename", "--with-filename", "--only-matching", "--count", "--quiet"], nonPathValue: ["-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-d", "--directories", "--label"] },
    egrep: { noValue: ["-i", "-v", "-w", "-x", "-c", "-l", "-o", "-q", "-n", "-H", "-h"], nonPathValue: ["-m", "-A", "-B", "-C"] },
    fgrep: { noValue: ["-i", "-v", "-w", "-x", "-c", "-l", "-o", "-q", "-n", "-H", "-h"], nonPathValue: ["-m", "-A", "-B", "-C"] },
  },
```

(`rg` is intentionally absent from `knownFlags`: it is always recursive, so `classifyArgv().isRecursive` already excludes it, and a missing table is a second, independent block.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/rules/factory.ts src/rules/commands/coreutils.ts src/rules/commands/simple-flag.ts src/rules/commands/positional-output.ts src/rules/commands/tail.ts src/rules/commands/grep.ts src/engine/classify_test.ts
git commit -m "feat(rules): guardrail 5 flag table + cwd-independent opt-in for reader rules"
```

---

### Task 12: hand-written `cwdIndependent` for `sed` / `awk` / `jq`

**Files:**
- Modify: `src/rules/commands/sed.ts`, `awk.ts`, `jq.ts`
- Test: `src/engine/classify_test.ts` (already covered by Task 11's first test — this task makes those three cases pass)

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`:

```ts
Deno.test("sed/awk/jq are cwd-independent only with zero input paths", () => {
  assertEquals(decide("cd /tmp && sed -n '1,5p'").verdict, "allow");
  assertEquals(decide("cd /tmp && sed -n '1,5p' a.txt").verdict, "ask");
  assertEquals(decide("cd /tmp && awk '{print $1}'").verdict, "allow");
  assertEquals(decide("cd /tmp && awk '{print $1}' a.txt").verdict, "ask");
  assertEquals(decide("cd /tmp && jq -r '.name'").verdict, "allow");
  assertEquals(decide("cd /tmp && jq -r '.name' a.json").verdict, "ask");
  assertEquals(decide("cd /tmp && jq -f prog.jq").verdict, "ask"); // path-valued flag
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL — the three `allow` cases ask.

- [ ] **Step 3: Declare it on `sedRule` (`src/rules/commands/sed.ts`)**

Add to the exported object, reusing the existing single-parse helpers:

```ts
  /** 程式碼已與輸入路徑分離；無輸入路徑時判定與 cwd 無關（-i / -f 已於 evaluate ask）。 */
  cwdIndependent(ctx: RuleContext): boolean {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) return false;
    const { text, explicitExpr } = collectProgram(ctx);
    if (text === null) return false;
    return inputPaths(ctx, explicitExpr).length === 0;
  },
```

- [ ] **Step 4: Declare it on `awkRule` (`src/rules/commands/awk.ts`)**

```ts
  /** 程式碼已與輸入路徑分離；無輸入路徑時判定與 cwd 無關（-i / -f 已於 evaluate ask）。 */
  cwdIndependent(ctx: RuleContext): boolean {
    if (hasAnyFlag(ctx.argv, ASK_FLAGS)) return false;
    const { text, pos } = collectProgram(ctx);
    if (text === null) return false;
    return pos.length === 0;
  },
```

- [ ] **Step 5: Declare it on `jqRule` (`src/rules/commands/jq.ts`)**

Refactor `evaluate`'s scan body into a shared `scan(ctx)` that returns
`{ verdict: RuleVerdict | null; inputs: Word[]; pathFlagUsed: boolean }`, have `evaluate` call it,
and add:

```ts
  /** filter 不是路徑；無輸入檔且未用到吃路徑的旗標時，判定與 cwd 無關。 */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = scan(ctx);
    if (r.verdict !== null && r.verdict.kind !== "allow") return false;
    return r.inputs.length === 0 && !r.pathFlagUsed;
  },
```

`scan` sets `pathFlagUsed = true` whenever it consumes `-f` / `--from-file` / `-L` /
`--library-path` / `--slurpfile` / `--rawfile`, and returns the post-filter `inputs` list. This is
the single-parse contract of spec §4.3.4: `evaluate` and `cwdIndependent` both read `scan`'s result.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts src/rules/commands/jq_test.ts src/rules/commands/sed_test.ts src/rules/commands/awk_test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/rules/commands/sed.ts src/rules/commands/awk.ts src/rules/commands/jq.ts src/engine/classify_test.ts
git commit -m "feat(rules): cwd-independent declarations for sed, awk and jq"
```

---

### Task 13: `gh` / `curl` cwd-independence + non-static operand tolerance

**Files:**
- Modify: `src/rules/commands/gh.ts`, `src/rules/commands/curl.ts`
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`:

```ts
Deno.test("gh api / search become cwd-independent after chain cd", () => {
  assertEquals(decide("cd /tmp && gh api repos/o/r/tags?per_page=50").verdict, "allow");
  assertEquals(decide("cd /tmp && gh search code x --language go").verdict, "allow");
});

Deno.test("repo-scoped gh subcommands are never cwd-independent", () => {
  assertEquals(decide("cd /tmp && gh pr diff").verdict, "ask");
  assertEquals(decide("cd /tmp && gh repo view").verdict, "ask");
  assertEquals(decide("cd /tmp && gh issue list --repo o/r").verdict, "ask");
});

Deno.test("gh api with a cwd-derived placeholder is never cwd-independent", () => {
  assertEquals(decide("cd /tmp && gh api 'repos/{owner}/{repo}/issues'").verdict, "ask");
});

Deno.test("the full baseline pipeline shape now allows", () => {
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/contents/pkg?ref=v1 | jq -r '.[].name'").verdict,
    "allow",
  );
  assertEquals(
    decide("cd /tmp && gh api repos/o/r/x -H 'Accept: application/vnd.github.raw' 2>&1 | grep -A 10 -B 2 -E 'Retry|backoff'").verdict,
    "allow",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL — the `allow` cases still ask on cwd scope.

- [ ] **Step 3: Declare on `ghRule` (`src/rules/commands/gh.ts`)**

Extract the token-collection block from Task 8 into `readTokens(ctx)` returning
`{ verdict: RuleVerdict | null; toks: string[]; command: string; relaxedIdx: number }`, have
`evaluate` call it, then add:

```ts
  /**
   * 只有 api 與 search 的目標由 endpoint / query 決定，不看 cwd。
   * READ_SUBS 的 repo view / issue list / pr diff… 未給 --repo 時會以 cwd 所在的
   * git repository 推斷目標倉庫，故一律不宣告（spec §4.3.4）。
   * api 的 endpoint 含 {owner}/{repo}/{branch} 時同樣由 cwd 的 repo 填值 → 不宣告。
   */
  cwdIndependent(ctx: RuleContext): boolean {
    const r = readTokens(ctx);
    if (r.verdict !== null) return false;
    if (r.command !== "api" && r.command !== "search") return false;
    if (ghHasLocalSideEffect(r.toks) || !ghFlagsAllKnown(r.command, r.toks)) return false;
    if (r.command === "api") {
      const after = r.toks.slice(r.toks.indexOf(r.command) + 1);
      const endpoint = after.find((t) => !t.startsWith("-"));
      if (endpoint !== undefined && endpointHasCwdPlaceholder(endpoint)) return false;
    }
    return true;
  },

  /** 唯一容忍的非靜態 token 是 api 的 endpoint 操作元（spec §4.2.5 已證 verdict 不變）。 */
  toleratesNonStaticOperand(ctx: RuleContext): boolean {
    const r = readTokens(ctx);
    return r.verdict === null && r.command === "api" && r.relaxedIdx >= 0;
  },
```

- [ ] **Step 4: Declare on `curlRule` (`src/rules/commands/curl.ts`)**

```ts
  /** allow 形式只走網路；-H @file 已由 resolvePathValue 以真實 cwd 檢查。 */
  cwdIndependent(ctx: RuleContext): boolean {
    return curlRule.evaluate(ctx).kind === "allow";
  },

  /** 唯一容忍的非靜態 token 是 URL 操作元；其餘（旗標 / 旗標值）永不容忍。 */
  toleratesNonStaticOperand(ctx: RuleContext): boolean {
    return curlRule.evaluate(ctx).kind === "allow";
  },
```

> `curlRule.evaluate` is a pure function of `ctx` (spec §4.3.3 order-safety note), so calling it
> from the predicate keeps the single-parse contract: both read the same computation. `classify`
> already has the `evaluate` verdict and only consults the predicate when that verdict is `allow`,
> so this cannot widen the exemption.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/rules/commands/gh.ts src/rules/commands/curl.ts src/engine/classify_test.ts
git commit -m "feat(rules): declare gh api/search and curl cwd-independent"
```

---

### Task 14: filesystem-state independence fixture test

**Files:**
- Test: `src/rules/commands/gh_test.ts`

This is spec §4.2.3's requirement: prove the verdict depends only on the literal token, never on
what happens to exist in the cwd.

- [ ] **Step 1: Write the test**

Append to `src/rules/commands/gh_test.ts`:

```ts
Deno.test("gh api verdict does not depend on cwd filesystem contents", async () => {
  const dir = await Deno.makeTempDir();
  const prev = Deno.cwd();
  try {
    const before = v("gh api repos/o/r/tags?per_page=50");
    // 建立一個「把 ? 換成單一字元」後可匹配的檔案
    await Deno.mkdir(`${dir}/repos/o/r`, { recursive: true });
    await Deno.writeTextFile(`${dir}/repos/o/r/tagsXper_page=50`, "");
    Deno.chdir(dir);
    const after = v("gh api repos/o/r/tags?per_page=50");
    assertEquals(before, after);
    assertEquals(after, "allow");
  } finally {
    Deno.chdir(prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every single-character expansion of the endpoint yields the same verdict", () => {
  const base = v("gh api repos/o/r/tags?per_page=50");
  for (const ch of ["X", "-", ".", "1", "_"]) {
    assertEquals(v(`gh api repos/o/r/tags${ch}per_page=50`), base, ch);
  }
});
```

- [ ] **Step 2: Run the test**

Run: `deno test --allow-env --allow-read --allow-write --allow-sys=uid src/rules/commands/gh_test.ts`
Expected: PASS. (The rule is purely lexical, so it should pass without any implementation change — this test locks that property in.)

- [ ] **Step 3: Add the permissions to the test task if needed**

If `deno task test` does not already grant `--allow-write`, confirm it does by reading `deno.json`;
per `CLAUDE.md` the test task already carries `--allow-run --allow-env --allow-read --allow-write --allow-sys=uid`.

- [ ] **Step 4: Run the full suite, type check and lint**

Run: `deno task check && deno task lint && deno task test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/gh_test.ts
git commit -m "test(rules): lock verdict independence from cwd filesystem state"
```

---

### Task 15: sync `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the central preflight section**

In the "四條中央前置規則（於 classify.ts…）" section, replace item 1 with:

```markdown
1. **cwd 範圍**：`cwd.kind === "known"` 但落在專案根外 → ask。**唯一例外**：五道護欄全部成立時
   跳過本條（且只跳過本條）——(1) 指令規則自身回 `allow`；(2) hook 傳入的 session cwd 本身在範圍內
   **且** 當前 cwd 由鏈內 `cd` 產生（`origin === "chain-cd"`）；(3) 相對路徑仍以真實 cwd 解析；
   (4) argv 全為靜態 token（唯一例外是 gh api endpoint / curl URL 操作元）；(5) 每個旗標都命中該
   規則的已知旗標表。宣告方式為 `CommandRule.cwdIndependent`，未宣告 = 不豁免（default-deny）。
```

- [ ] **Step 2: Update the architecture section**

In the `classify.ts` bullet, append:

```markdown
  另計算 cwd 豁免旗標（`cwdIndependent` + `toleratesNonStaticOperand` 兩個可選述詞 + 五道護欄），
  以 `skipCwdCheck` 傳給 `centralPreflightAsk`，**僅**跳過規則一。
```

In the `scope.ts` bullet, append:

```markdown
  另提供 `buildScopeConfig`，供 `evaluate`（算 `sessionCwdInScope`）與 `classify` 共用同一份範圍定義。
```

In the `rules/` bullet, add `commands/jq.ts` to the list and note that `jq` was moved out of
`fileReaderRule`.

- [ ] **Step 3: Update the `word.ts` description**

Add after the existing `word.ts` note:

```markdown
- **`word.ts` 的 `nonPathStaticValue`**：只容忍「單一 `?` 查詢串」形態（恰一個未跳脫 `?`、不在索引 0、
  其後不含 `/`）的未加引號 token，且**只可用於 `gh api` 的 endpoint 與 `curl` 的 URL 操作元**。
  旗標、旗標值、任何路徑一律沿用 `staticValue`。安全性由「verdict 對所有展開結果不變」保證
  （gh 的判定只看旗標；curl 的 scheme/host 落在字面前綴內）。
```

- [ ] **Step 4: Update the `gh` notes**

In the "安全誤放（auto-allow 不該 allow）" section, replace the `git / gh 全域選項是攻擊面` bullet's
gh part with:

```markdown
- **gh 已改為旗標 allowlist**：未知旗標一律 ask（同時免疫 gh 版本漂移）。本機副作用旗標
  `-w`/`--web`（開瀏覽器）與 `--cache`（寫本機快取）對所有子指令一律 ask。`gh api` 的 endpoint
  含 `{owner}`/`{repo}`/`{branch}` 時目標由 cwd 的 git repo 決定 → 不得享有 cwd 豁免。
```

- [ ] **Step 5: Verify the doc builds nothing and commit**

Run: `deno task check && deno task lint && deno task test`
Expected: all green (no code changed).

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md with the cwd exemption, gh flag allowlist and jq rule"
```

---

### Task 16: build + operational verification against the baseline set

**Files:**
- No source changes. Produces `dist/permission-checker(.exe)` (gitignored).

- [ ] **Step 1: Build**

Run: `deno task build`
Expected: `dist/permission-checker.exe` written, exit 0.

- [ ] **Step 2: Verify one representative command end-to-end**

Run:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cd /d && gh api repos/o/r/tags?per_page=50 | head -100"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
```

Expected: JSON with `"permissionDecision":"allow"`, exit 0.

- [ ] **Step 3: Verify the guardrails end-to-end**

Run each and record the decision:

```bash
for c in "cd /d && ls" "cd /d && cat x.txt" "cd /d && echo *" "cd /d && gh pr diff" \
         "cd /d && gh api repos/o/r/x > out.txt" "cd /d && gh search code x --web" \
         "cd /d && wc --files0-from=list" ; do
  printf '%s -> ' "$c"
  jq -nc --arg c "$c" '{tool_name:"Bash",tool_input:{command:$c},cwd:"D:/proj"}' \
    | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe \
    | jq -r '.hookSpecificOutput.permissionDecision'
done
```

Expected: `ask` for every line except `cd /d && find . -name x`, which is `deny`. None may be `allow`.

- [ ] **Step 4: Replay the baseline set**

Rebuild the baseline inputs from the spec's §1.1 representative commands (they are reproduced
verbatim in the spec) plus any local transcript available, feed each to the binary, and tally the
decisions.

Expected: the read-only `gh api` / `gh search` pipelines return `allow`; the variable-expansion
`for` loop, the `xargs … sh -c` line, and the heredoc-write line return `ask`.

**If the allow count is lower than the spec's §7.3 target of 63/67**, the correct response is to
record the actual number and identify which guardrail rejected each remaining line — guardrails 4
and 5 and the gh flag allowlist were added after that target was estimated, so the target may be
optimistic. **Do not relax a guardrail to hit the number.** Update the spec's §7.3 figure with the
measured result and the reason for each remaining `ask`.

- [ ] **Step 5: Commit any spec figure correction**

```bash
git add docs/superpowers/specs/2026-09-03-readonly-gh-auto-allow-design.md
git commit -m "docs(spec): record measured operational verification results"
```

(Skip this commit if the measured result matches the spec.)
