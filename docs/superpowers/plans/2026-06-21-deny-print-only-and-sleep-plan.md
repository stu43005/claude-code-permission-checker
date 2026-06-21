# Deny print-only fakery & sleep polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the permission-checker hook return `deny` for "整鏈 print-only 偽裝驗證" (whole-chain `echo`/`printf`/`cat`-heredoc that only emits static text) and for any literal `sleep` polling, plus fold in two adjacent read-safety fixes (input-redirect scope check, `tail -f` gate).

**Architecture:** Three `evaluate`-layer gates run after `walk()` and **before** `classify()` (so they bypass `settingsAllows` and are non-upgradeable): ① any literal `sleep` leaf → deny, ② whole chain print-form → deny, ③ a called name shadowed by a same-script function → ask. A new `print_only.ts` module holds the print-form predicates; `walk.ts` gains heredoc-`body` substitution enumeration + `definedFunctionNames`; `classify.ts` gains a 4th central pre-rule (input-redirect `<` scope); `tail` moves to its own rule gating follow mode.

**Tech Stack:** Deno + TypeScript, `npm:unbash@4.0.1` (already upgraded), `@std/assert`. Spec: `docs/superpowers/specs/2026-06-21-deny-print-only-and-sleep-design.md`.

---

## File Structure

- `src/engine/word.ts` (modify) — `export` the existing `topPartIsDynamic` / `nestedPartIsDynamic`.
- `src/engine/print_only.ts` (**new**) — `isAllPrintOnly`, `isPrintOnlyForm`, `wordPrintEligible`, `isHeredocPrintEligible`, echo/printf/cat sub-judges. Pure (no FS).
- `src/rules/types.ts` (modify) — add `printOnlyDenyReason()`, `pollingDenyReason()`, `functionShadowReason()`.
- `src/engine/walk.ts` (modify) — (a) `emitCommand` enumerates inner substitutions from `[...inherited, ...cmd.redirects]` `target` **and** `body`; (b) add `definedFunctionNames(script)`.
- `src/engine/evaluate.ts` (modify) — insert the three gates before `combine`.
- `src/engine/classify.ts` (modify) — add 4th central pre-rule: input-redirect `<` target scope check → ask.
- `src/rules/commands/coreutils.ts` (modify) — remove `"tail"` from `fileReaderRule`.
- `src/rules/commands/tail.ts` (**new**) — `tailRule` (follow flags → ask).
- `src/rules/allowlist.ts` (modify) — register `tailRule`.
- Tests: `src/rules/types_test.ts`, `src/engine/print_only_test.ts` (new), `src/engine/walk_test.ts` (new), `src/engine/evaluate_test.ts` (new), `src/engine/classify_test.ts`, `src/rules/commands/tail_test.ts` (new), `src/main_test.ts`.
- `CLAUDE.md` (modify) — doc updates.

Commands (from `deno.json`): `deno task test` (full), `deno task check`, `deno task lint`, `deno task build`. Run a single test file: `deno test --allow-env --allow-read --allow-run --allow-sys=uid src/engine/print_only_test.ts`.

---

### Task 1: Deny/ask reason helpers (`src/rules/types.ts`)

**Files:**
- Modify: `src/rules/types.ts`
- Test: `src/rules/types_test.ts`

- [ ] **Step 1: Write the failing tests**

`src/rules/types_test.ts` already exists and already imports `assertStringIncludes`. Extend its existing `import { deny, recursiveRootDenyReason } from "./types.ts";` line to also import the new helpers:

```ts
import { deny, functionShadowReason, pollingDenyReason, printOnlyDenyReason, recursiveRootDenyReason } from "./types.ts";
```

Then append these tests to the file:

```ts
Deno.test("printOnlyDenyReason 含禁止字樣 + 替代建議", () => {
  const r = printOnlyDenyReason();
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "回覆");
});

Deno.test("pollingDenyReason 含 sleep 替代指引", () => {
  const r = pollingDenyReason();
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "ScheduleWakeup");
  assertStringIncludes(r, "task-notification");
});

Deno.test("functionShadowReason 含需確認 + 替代", () => {
  const r = functionShadowReason();
  assertStringIncludes(r, "需確認");
  assertStringIncludes(r, "函式");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/types_test.ts`
Expected: FAIL — `printOnlyDenyReason`/`pollingDenyReason`/`functionShadowReason` not exported.

- [ ] **Step 3: Add the three helpers**

Append to `src/rules/types.ts` (after the existing `recursiveRootDenyReason`):

```ts
/** 整鏈 print-only 偽裝驗證的 deny 理由（回饋給 agent）。 */
export function printOnlyDenyReason(): string {
  return `已禁止：此指令鏈的每個指令都只是把靜態文字輸出到 stdout（echo / printf / cat heredoc），` +
    `未讀取任何檔案、未執行任何真實計算或驗證——內容完全由你事先寫死，等同把推論用機器口吻轉述、` +
    `偽裝成「電腦跑出來的結果」。若你已有結論，請直接寫在回覆文字中；若需驗證，請實際讀取檔案、` +
    `執行測試、或執行會產生真實副作用的指令，而非用 echo/printf/heredoc 重述寫死的內容。`;
}

/** sleep 輪詢 / 等待的 deny 理由（回饋給 agent）。 */
export function pollingDenyReason(): string {
  return `已禁止：sleep 用於輪詢 / 等待，本工具的唯讀情境下無正當用途，且背景工作完成時 harness ` +
    `會自動以 task-notification 重新喚醒你，不需主動等待。若需排程下次喚醒，請改用 ScheduleWakeup，` +
    `不要用 Bash sleep 輪詢。`;
}

/** 函式遮蔽 allowlist 指令名的 ask 理由（回饋給 agent）。 */
export function functionShadowReason(): string {
  return `需確認：此指令在同一字串內定義了 shell 函式並覆寫（遮蔽）了一個指令名再呼叫，實際執行的是` +
    `函式本體、而非該指令本身——權限檢查無法靜態得知函式本體做什麼。請改為直接執行真正的指令（不要` +
    `用同名函式覆寫），或拆成多次呼叫以便逐一檢查。`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/types_test.ts`
Expected: PASS (all reason tests green).

- [ ] **Step 5: Commit**

```bash
git add src/rules/types.ts src/rules/types_test.ts
git commit -m "feat(types): add print-only/sleep/function-shadow deny-ask reason helpers"
```

---

### Task 2: Export `word.ts` predicates + `wordPrintEligible` (`src/engine/print_only.ts`)

**Files:**
- Modify: `src/engine/word.ts:22-35` (add `export` to two functions)
- Create: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/engine/print_only_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { wordPrintEligible } from "./print_only.ts";

/** 取 `echo …` 第一個引數 Word。 */
function arg0(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

Deno.test("wordPrintEligible: 靜態字面 / 命令替換 → 合格", () => {
  assertEquals(wordPrintEligible(arg0('echo hi')), true);
  assertEquals(wordPrintEligible(arg0('echo "$(echo x)"')), true);
  assertEquals(wordPrintEligible(arg0('echo a$(c)b')), true);
});

Deno.test("wordPrintEligible: 變數 / glob / brace / 混合 → 不合格", () => {
  assertEquals(wordPrintEligible(arg0('echo "$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo "$(c)$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo *$(echo x)')), false); // 頂層未引號 glob Literal
  assertEquals(wordPrintEligible(arg0('echo ?$(c)')), false);      // ? glob + 替換 → 不合格
  assertEquals(wordPrintEligible(arg0('echo *.txt')), false);
  assertEquals(wordPrintEligible(arg0('echo {1..5}')), false);     // brace expansion → 動態
  assertEquals(wordPrintEligible(arg0('echo "*"$(c)')), true);     // 引號保護 glob → 合格
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL — `./print_only.ts` does not exist.

- [ ] **Step 3a: Export the two predicates from `word.ts`**

In `src/engine/word.ts`, add `export` to the two helper functions (currently module-private). Change:

```ts
function nestedPartIsDynamic(part: WordPart): boolean {
```
to:
```ts
export function nestedPartIsDynamic(part: WordPart): boolean {
```

And change:
```ts
function topPartIsDynamic(part: WordPart): boolean {
```
to:
```ts
export function topPartIsDynamic(part: WordPart): boolean {
```

- [ ] **Step 3b: Create `print_only.ts` with `wordPrintEligible`**

Create `src/engine/print_only.ts`:

```ts
import type { Word, WordPart } from "../deps.ts";
import { isStatic, nestedPartIsDynamic, topPartIsDynamic } from "./word.ts";

/**
 * Word 是否「print 合格」：靜態，或其唯一動態成分為命令替換 $( … )。
 * 變數展開、算術、brace、未引號 glob 字元的 Literal、process substitution → 不合格。
 */
export function wordPrintEligible(w: Word): boolean {
  if (isStatic(w)) return true;          // 純靜態（含詞法 glob 判定）
  if (!w.parts) return false;            // 無 parts 但非靜態 = 未引號 glob 純字面 → 不合格
  return w.parts.every(topPartEligible);
}

function topPartEligible(p: WordPart): boolean {
  if (p.type === "CommandExpansion") return true;          // 豁免：$( … ) / 反引號
  if (!topPartIsDynamic(p)) return true;                   // 非動態（含未引號非 glob Literal、引號字面）
  if (p.type === "DoubleQuoted" || p.type === "LocaleString") {
    return p.parts.every((np) => np.type === "CommandExpansion" || !nestedPartIsDynamic(np));
  }
  return false;   // SimpleExpansion/Parameter/Arith/Brace/ExtGlob/ProcessSubstitution/含 glob 的未引號 Literal
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/word.ts src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(print-only): add command-substitution-aware wordPrintEligible"
```

---

### Task 3: `isPrintOnlyForm` (echo/printf) + `isAllPrintOnly` (`src/engine/print_only.ts`)

**Files:**
- Modify: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/print_only_test.ts`:

```ts
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { isAllPrintOnly, isPrintOnlyForm } from "./print_only.ts";
import type { CwdState } from "../types.ts";

const START: CwdState = { kind: "known", path: "/proj" };
function invs(src: string) {
  return walk(parseCommand(src).script, START, "/proj");
}

Deno.test("echo print 形態：靜態 / 替換包裝 → true", () => {
  assertEquals(isPrintOnlyForm(invs('echo "結論"')[0]), true);
  assertEquals(isPrintOnlyForm(invs("echo")[0]), true);            // 無引數
});

Deno.test("echo carve-out 收窄：-e 須含反斜線跳脫才放行", () => {
  assertEquals(isPrintOnlyForm(invs('echo -e "a\\tb"')[0]), false); // 真實跳脫 → 行為探測 → 非 print
  assertEquals(isPrintOnlyForm(invs('echo -e "verified"')[0]), true); // 無跳脫 → 仍 print
  assertEquals(isPrintOnlyForm(invs('echo -E "analysis"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('echo -n "fake"')[0]), true);   // -n 不算 carve-out
});

Deno.test("printf print 形態 + carve-out 收窄", () => {
  assertEquals(isPrintOnlyForm(invs('printf "結論：x\\n"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('printf "%s\\n" "結論"')[0]), true);  // %s 純字串 → 仍 print
  assertEquals(isPrintOnlyForm(invs('printf "%%done\\n"')[0]), true);
  assertEquals(isPrintOnlyForm(invs('printf "%05d\\n" 42')[0]), false);   // 數值轉換 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf "%c" 65')[0]), false);
  assertEquals(isPrintOnlyForm(invs('printf -v result ok')[0]), false);   // -v 賦值 → 非 print
});

Deno.test("前置排除：寫檔 / 賦值 / 變數 → 非 print", () => {
  assertEquals(isPrintOnlyForm(invs("echo hi > out.txt")[0]), false);     // 寫入重導向
  assertEquals(isPrintOnlyForm(invs("FOO=1 echo x")[0]), false);          // 賦值前綴
  assertEquals(isPrintOnlyForm(invs('echo "$VAR"')[0]), false);           // 變數
});

Deno.test("isAllPrintOnly 聚合", () => {
  assertEquals(isAllPrintOnly(invs('echo a; echo b')), true);
  assertEquals(isAllPrintOnly(invs('echo a && echo b')), true);
  assertEquals(isAllPrintOnly(invs('(echo fake)')), true);                // subshell 攤平
  assertEquals(isAllPrintOnly(invs('{ echo a; echo b; }')), true);
  assertEquals(isAllPrintOnly(invs('echo "$(echo fake)"')), true);        // 替換包裝
  assertEquals(isAllPrintOnly(invs('echo "pre $(echo x)"')), true);       // 字面+替換 → 仍 print
  assertEquals(isAllPrintOnly(invs('make && echo DONE')), false);         // make 非 print
  assertEquals(isAllPrintOnly(invs('echo "$(date)"')), false);            // inner date 非 print
  assertEquals(isAllPrintOnly(invs('echo "$(cat real)"')), false);        // inner cat 讀檔非 print
  assertEquals(isAllPrintOnly(invs('echo x | grep y')), false);           // grep 非 print
  assertEquals(isAllPrintOnly(invs('echo data | wc -l')), false);         // wc 非 print
  assertEquals(isAllPrintOnly([]), false);                                // 空 → false
});

Deno.test("print-only 邊界：%b 純字串 / -ne 跳脫 / 數值轉換 / process subst / 變數 / --", () => {
  assertEquals(isPrintOnlyForm(invs('printf "%b" "x"')[0]), true);        // %b 純字串 → print
  assertEquals(isPrintOnlyForm(invs('printf -- "結論\\n"')[0]), true);    // -- 後為 format → print
  assertEquals(isPrintOnlyForm(invs('echo -ne "x\\n"')[0]), false);       // -ne + 反斜線 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf "%.2f" 3.14')[0]), false);    // 數值格式 → carve-out
  assertEquals(isPrintOnlyForm(invs('printf -v x "%s" y')[0]), false);    // -v 賦值 → 非 print
  assertEquals(isPrintOnlyForm(invs('echo <(cmd)')[0]), false);           // process subst → 非合格
  assertEquals(isPrintOnlyForm(invs('echo "a$VAR b"')[0]), false);        // 含變數 → 非合格
});

Deno.test("printf 動態/替換型第一引數 → 保守視為非 print（與 echo 不對稱、刻意；落 ask 非 deny）", () => {
  // printf 第一引數為命令替換時 staticValue 為 null，無法靜態確認它不是選項（如 -v），
  // 故 printf 的命令替換包裝**不**比照 echo 硬 deny，而是非 print 形態 → 落 classify（ask）。
  assertEquals(isPrintOnlyForm(invs('printf "$(echo fake)"')[0]), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL — `isPrintOnlyForm`/`isAllPrintOnly` not exported.

- [ ] **Step 3: Add `isAllPrintOnly`, `isPrintOnlyForm`, echo/printf judges**

In `src/engine/print_only.ts`, update the imports line and add the functions. Change the import block at the top to:

```ts
import type { CommandInvocation } from "../types.ts";
import type { Word, WordPart } from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { isStatic, nestedPartIsDynamic, staticValue, topPartIsDynamic } from "./word.ts";
```

Add (above `wordPrintEligible`):

```ts
/** 整鏈聚合：至少一個指令、且每個葉指令皆 print 形態。 */
export function isAllPrintOnly(invocations: CommandInvocation[]): boolean {
  return invocations.length > 0 && invocations.every(isPrintOnlyForm);
}

/** 單一葉指令是否為「靜態吐字」形態（echo / printf / cat·tac heredoc）。 */
export function isPrintOnlyForm(inv: CommandInvocation): boolean {
  if (inv.name === null) return false;                 // 動態指令名 → 本就 ask
  if (hasWriteRedirect(inv.redirects)) return false;   // 有寫檔副作用 → 非純輸出
  if (inv.assignments.length > 0) return false;        // var=val 前綴 → 可能改變執行
  switch (inv.name) {
    case "echo":
      return isEchoPrintOnly(inv);
    case "printf":
      return isPrintfPrintOnly(inv);
    default:
      return false;
  }
}

function isEchoPrintOnly(inv: CommandInvocation): boolean {
  let hasEscapeFlag = false;       // -e / -E 跳脫詮釋旗標
  let hasBackslashPayload = false; // payload 含反斜線跳脫序列
  for (const w of inv.argv) {
    if (!wordPrintEligible(w)) return false;
    const v = staticValue(w);
    if (v === null) continue;                                // 替換型 payload
    if (/^-[neE]*[eE][neE]*$/.test(v)) { hasEscapeFlag = true; continue; }
    if (v.includes("\\")) hasBackslashPayload = true;
  }
  if (hasEscapeFlag && hasBackslashPayload) return false;    // 真正的跳脫行為探測 → carve-out
  return true;
}

function isPrintfPrintOnly(inv: CommandInvocation): boolean {
  const first = inv.argv.length > 0 ? staticValue(inv.argv[0]) : null;
  if (first !== null && first !== "--" && first.startsWith("-")) return false; // -v 等選項 → 非純輸出
  if (inv.argv.length > 0 && first === null) return false;                     // 第一引數動態 → 保守
  for (const w of inv.argv) if (!wordPrintEligible(w)) return false;
  const fmtWord = inv.argv.find((w) => staticValue(w) !== "--");
  if (!fmtWord) return true;
  const fmt = staticValue(fmtWord);
  if (fmt !== null && hasFormatterConversion(fmt)) return false;               // carve-out：格式化轉換符
  return true;
}

/** format 是否含「會做格式化轉換」的轉換符（排除 %s / %b 純字串、字面 %%）。 */
function hasFormatterConversion(fmt: string): boolean {
  const stripped = fmt.replace(/%%/g, "");
  return /%[-+ 0#]*[0-9.*]*[diouxXeEfFgGaACc]/.test(stripped);
}
```

> Note: `cat`/`tac` are added in **Task 5**. Leaving them out of the `switch` now means `cat <<EOF…` returns `false` (non-print) — Task 3 tests do not cover cat, so this is fine until Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(print-only): add isPrintOnlyForm (echo/printf) + isAllPrintOnly"
```

---

### Task 4: Walk enumerates heredoc `body` substitutions (`src/engine/walk.ts`)

**Files:**
- Modify: `src/engine/walk.ts` (the `emitCommand` `words` collection)
- Test: `src/engine/walk_test.ts` (**already exists — append**)

- [ ] **Step 1: Write the failing tests**

`src/engine/walk_test.ts` already exists with `import { assertEquals }`, `import { parseCommand }`, `import { walk } from "./walk.ts"`, `import type { CwdState }`, plus helpers `const ROOT = "/proj"`, `const START`, and `function names(src)`. **Append** these tests (reuse the existing `names` helper — do NOT re-import or redefine it):

```ts
Deno.test("walk 列舉 heredoc body 內的命令替換", () => {
  assertEquals(names("cat <<EOF\n$(rm -rf x)\nEOF"), ["cat", "rm"]);
  assertEquals(names("cat <<EOF\n$HOME\nEOF"), ["cat"]);          // 純變數 → 無內層指令
  assertEquals(names("cat <<'EOF'\n$(rm)\nEOF"), ["cat"]);        // 引號 → body 不解析
});

Deno.test("walk 列舉繼承（外層掛載）heredoc body / here-string 替換", () => {
  assertEquals(names("{ cat; } <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names("( cat ) <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names("while read; do cat; done <<EOF\n$(rm)\nEOF").includes("rm"), true);
  assertEquals(names('{ cat; } <<<"$(rm)"').includes("rm"), true); // 繼承 here-string target
});

Deno.test("walk here-string target 替換仍被列舉（回歸）", () => {
  assertEquals(names('cat <<<"$(rm)"').includes("rm"), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL — `cat <<EOF\n$(rm -rf x)\nEOF` returns `["cat"]` (body `rm` not enumerated).

- [ ] **Step 3: Enumerate `target` + `body` from inherited + own redirects**

In `src/engine/walk.ts`, the `emitCommand` function currently builds `words` like this:

```ts
  const words: Word[] = [
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.suffix,
    ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
    ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
  ];
  for (const w of words) enumerateInnerScripts(w, cwd, out);
```

Replace it with (adds inherited redirects + `body`):

```ts
  const allRedirects = [...inherited, ...cmd.redirects]; // 與 invocation.redirects 同源
  const words: Word[] = [
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.suffix,
    ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
    ...allRedirects.flatMap((r) => (r.target ? [r.target] : [])),
    ...allRedirects.flatMap((r) => (r.body ? [r.body] : [])), // heredoc body 內的替換
  ];
  for (const w of words) enumerateInnerScripts(w, cwd, out);
```

> `emitCommand` already receives `inherited` as a parameter (used for `redirects: [...inherited, ...cmd.redirects]`). No signature change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/walk.ts src/engine/walk_test.ts
git commit -m "feat(walk): enumerate heredoc body command substitutions (own + inherited)"
```

---

### Task 5: `cat`/`tac` heredoc passthrough + fd-0 order (`src/engine/print_only.ts`)

**Files:**
- Modify: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

> Depends on Task 4 (walk body enumeration), which is now implemented before this task — so the `cat <<EOF\n$(rm x)\nEOF` chain produces `[cat, rm]` and the assertions below pass without ordering caveats.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/print_only_test.ts`:

```ts
Deno.test("cat heredoc passthrough → print；含真實指令/變數 → 非全鏈 print", () => {
  assertEquals(isAllPrintOnly(invs("cat <<EOF\nhello\nEOF")), true);
  assertEquals(isAllPrintOnly(invs("cat <<'EOF'\n$x\nEOF")), true);      // 引號分隔符 → 靜態
  assertEquals(isAllPrintOnly(invs('cat <<<"x"')), true);                // here-string
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$(echo 假)\nEOF")), true); // body 僅替換 + inner echo
  assertEquals(isAllPrintOnly(invs('cat <<<"$(echo 假)"')), true);        // here-string 替換包裝
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$(rm x)\nEOF")), false);   // inner rm 非 print
  assertEquals(isAllPrintOnly(invs("cat <<EOF\n$HOME\nEOF")), false);     // body 變數 → cat 非 print
  assertEquals(isAllPrintOnly(invs('cat <<<"$VAR"')), false);             // here-string 變數
  assertEquals(isAllPrintOnly(invs("cat file")), false);                  // 無 heredoc
  assertEquals(isAllPrintOnly(invs("cat -n <<EOF\nx\nEOF")), true);       // 僅旗標、有 heredoc
  assertEquals(isAllPrintOnly(invs("cat f && echo ok")), false);          // cat 讀真檔 → 非全鏈 print
  assertEquals(isAllPrintOnly(invs("cat <<EOF\nx\nEOF | python")), false); // python 非 print
});

Deno.test("cat fd0 重導向順序（最後者勝）+ -- 操作元", () => {
  // 最後是 < README.md → 讀真實檔 → 非 passthrough
  assertEquals(isAllPrintOnly(invs("cat <<EOF\nfake\nEOF < README.md")), false);
  // 最後是 heredoc → 印 fake → passthrough（print）
  assertEquals(isAllPrintOnly(invs("cat < README.md <<EOF\nfake\nEOF")), true);
  // -- 後 -fixture 為檔名操作元 → 讀真實檔 → 非 passthrough
  assertEquals(isAllPrintOnly(invs("cat -- -fixture <<EOF\nx\nEOF")), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL — cat/tac not handled (heredoc cases return false where true is expected).

- [ ] **Step 3: Add `cat`/`tac` to `isPrintOnlyForm` + helpers**

In `src/engine/print_only.ts`, update the import line to also import `Redirect`:

```ts
import type { Redirect, Word, WordPart } from "../deps.ts";
```

Add `cat`/`tac` to the `switch` in `isPrintOnlyForm`:

```ts
    case "cat":
    case "tac":
      return isCatPassthrough(inv);
```

Add the helpers (anywhere in the module, e.g. after `hasFormatterConversion`):

```ts
function isCatPassthrough(inv: CommandInvocation): boolean {
  if (hasFileOperand(inv.argv)) return false;                 // 有檔案操作元 → 讀真實檔
  // 依 Bash 重導向順序決定 fd0 來源：影響 fd0 的輸入重導向中**最後一個勝**。
  const fd0Inputs = inv.redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0Inputs.length === 0) return false;                   // 無 fd0 輸入 → 非 passthrough
  const effective = fd0Inputs[fd0Inputs.length - 1];          // 最後者 = 有效 stdin
  if (effective.operator !== "<<" && effective.operator !== "<<-" && effective.operator !== "<<<") {
    return false;                                             // 有效 stdin 是 < file 或 <&fd
  }
  return isHeredocPrintEligible(effective);
}

/** argv 是否含檔案操作元：考慮 POSIX `--`（其後一律為操作元）。 */
function hasFileOperand(argv: Word[]): boolean {
  let afterDoubleDash = false;
  for (const w of argv) {
    const v = staticValue(w);
    if (!afterDoubleDash && v === "--") { afterDoubleDash = true; continue; }
    if (afterDoubleDash) return true;                          // `--` 之後任何 token = 檔名
    if (v === null || !v.startsWith("-")) return true;         // 動態或非旗標 → 視為檔名
  }
  return false;
}

/** heredoc/here-string body 是否「print 合格」（靜態，或唯一動態為 $( … )）。 */
function isHeredocPrintEligible(r: Redirect): boolean {
  if (r.operator === "<<<") {
    return r.target ? wordPrintEligible(r.target) : true;     // here-string：target 為實際字串 Word
  }
  if (r.heredocQuoted === true) return true;                  // 引號分隔符 → 靜態字面
  if (r.body) return wordPrintEligible(r.body);               // body 存在（含展開）→ 以 wordPrintEligible 判
  return !/[$`]/.test(r.content ?? "");                       // body 不存在 → 純文字（無 $/反引號才算靜態）
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS (Task 4's walk body enumeration is already in place, so `cat <<EOF\n$(rm x)\nEOF` yields `[cat, rm]`).

- [ ] **Step 5: Commit**

```bash
git add src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(print-only): cat/tac heredoc passthrough with fd-0 order + -- operands"
```

---

### Task 6: `definedFunctionNames` (`src/engine/walk.ts`)

**Files:**
- Modify: `src/engine/walk.ts` (add export + imports)
- Test: `src/engine/walk_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/walk_test.ts`:

```ts
import { definedFunctionNames } from "./walk.ts";

function fns(src: string) {
  return [...definedFunctionNames(parseCommand(src).script)].sort();
}

Deno.test("definedFunctionNames 收集函式定義名（含巢狀）", () => {
  assertEquals(fns("date(){ sleep 5; }; date"), ["date"]);
  assertEquals(fns("pwd(){ echo x; }; pwd"), ["pwd"]);
  assertEquals(fns("{ f(){ :; }; }; f"), ["f"]);
  assertEquals(fns("if true; then g(){ :; }; fi"), ["g"]);
  assertEquals(fns("echo hi"), []);
});

Deno.test("definedFunctionNames 涵蓋命令替換內的函式定義（含繼承 heredoc）", () => {
  // walk 會列舉 $() 內層的 date 呼叫；定義名也須被收集，閘③ 才能攔成 ask
  assertEquals(fns('echo "$(date(){ rm x; }; date)"'), ["date"]);
  // 繼承（Statement 層）heredoc body 內的定義也須收集
  assertEquals(fns("{ cat; } <<EOF\n$(f(){ :; }; f)\nEOF"), ["f"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL — `definedFunctionNames` not exported.

- [ ] **Step 3: Add `definedFunctionNames`**

In `src/engine/walk.ts`, ensure `Script`, `Node`, `Word`, `WordPart` are imported from `../deps.ts` (the file already imports `Command`, `Node`, `Redirect`, `Script`, `Statement`, `Word`, `WordPart`; confirm all are present). Then append:

```ts
/** 遞迴掃描 AST 收集所有函式定義名（靜態名；動態名忽略），含命令替換內層腳本。供 evaluate 閘③偵測函式遮蔽。 */
export function definedFunctionNames(script: Script): Set<string> {
  const out = new Set<string>();
  for (const s of script.commands) collectFns(s.command, out);
  return out;
}

function collectFns(node: Node, out: Set<string>): void {
  switch (node.type) {
    case "Function": {
      const n = staticValue(node.name);
      if (n !== null) out.add(n);
      collectFns(node.body, out); // 巢狀定義
      return;
    }
    case "Command": {
      // 函式可定義於命令替換內（如 echo "$(f(){ … }; f)"）；walk 會列舉其內層呼叫，
      // 故此處亦須掃 Word 內的 $( … ) / <( … ) 腳本，收集其中的函式定義名。
      const words: Word[] = [
        ...(node.name ? [node.name] : []),
        ...node.suffix,
        ...node.prefix.flatMap((a) => (a.value ? [a.value] : [])),
        ...node.redirects.flatMap((r) => (r.target ? [r.target] : [])),
        ...node.redirects.flatMap((r) => (r.body ? [r.body] : [])),
      ];
      for (const w of words) collectFnsInWord(w, out);
      return;
    }
    case "AndOr":
    case "Pipeline":
      for (const m of node.commands) collectFns(m, out);
      return;
    case "Subshell":
    case "BraceGroup":
      for (const s of node.body.commands) collectFns(s.command, out);
      return;
    case "CompoundList":
      for (const s of node.commands) collectFns(s.command, out);
      return;
    case "If":
      for (const s of node.clause.commands) collectFns(s.command, out);
      for (const s of node.then.commands) collectFns(s.command, out);
      if (node.else) {
        if (node.else.type === "If") collectFns(node.else, out);
        else for (const s of node.else.commands) collectFns(s.command, out);
      }
      return;
    case "For":
    case "Select":
    case "ArithmeticFor":
      for (const s of node.body.commands) collectFns(s.command, out);
      return;
    case "While":
      for (const s of node.clause.commands) collectFns(s.command, out);
      for (const s of node.body.commands) collectFns(s.command, out);
      return;
    case "Case":
      for (const it of node.items) for (const s of it.body.commands) collectFns(s.command, out);
      return;
    case "Statement":
      // Statement 層的重導向（如 `{ cat; } <<EOF $(f(){:;};f) EOF` 的 heredoc）會被 walk 以
      // inherited 列舉其 body 內層呼叫；此處同步掃 target/body，函式定義名才不漏。
      for (const r of node.redirects) {
        if (r.target) collectFnsInWord(r.target, out);
        if (r.body) collectFnsInWord(r.body, out);
      }
      collectFns(node.command, out);
      return;
    default:
      // TestCommand / ArithmeticCommand / Coproc：無相關內層函式定義
      return;
  }
}

/** 掃描 Word 內的 CommandExpansion / ProcessSubstitution 腳本，遞迴收集函式定義名。 */
function collectFnsInWord(word: Word, out: Set<string>): void {
  if (!word.parts) return;
  for (const part of word.parts) collectFnsInPart(part, out);
}

function collectFnsInPart(part: WordPart, out: Set<string>): void {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    for (const s of part.script.commands) collectFns(s.command, out);
  } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts) collectFnsInPart(child, out);
  }
}
```

> `node.name` on a `Function` node is a `Word` (unbash 4.0.1), so use `staticValue(node.name)`. `staticValue` is already imported in `walk.ts`. `collectFnsInWord`/`collectFnsInPart` mirror the existing `enumerateInnerScripts`/`walkPart` so the shadow set stays consistent with what `walk()` actually emits as invocations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/walk.ts src/engine/walk_test.ts
git commit -m "feat(walk): add definedFunctionNames for function-shadow detection"
```

---

### Task 7: Three evaluate-layer gates (`src/engine/evaluate.ts`)

**Files:**
- Modify: `src/engine/evaluate.ts`
- Test: `src/engine/evaluate_test.ts`

- [ ] **Step 1: Write the failing tests**

`src/engine/evaluate_test.ts` already exists and already defines `const ROOT = "/proj"`, `const AT_ROOT`, a `rulesOf(...)` helper, and imports `assertEquals`, `evaluate`, `parseBashRule`, `PermissionRules`. **Append** the following — reuse those existing identifiers (do NOT re-import or redefine `ROOT` / `AT_ROOT` / `rulesOf`). Add one small local `vd` helper and the tests:

```ts
function vd(src: string, rules?: PermissionRules) {
  return rules
    ? evaluate(src, ROOT, AT_ROOT, rules).verdict
    : evaluate(src, ROOT, AT_ROOT).verdict;
}

Deno.test("閘②整鏈 print-only → deny（不可由 Bash(echo *) 升級）", () => {
  assertEquals(vd('echo "結論是 X"'), "deny");
  assertEquals(vd('printf "%s\\n" "結論"'), "deny");
  assertEquals(vd("cat <<EOF\nfake\nEOF"), "deny");
  assertEquals(vd("echo a; echo b"), "deny");
  assertEquals(vd('echo "$(echo fake)"'), "deny");
  assertEquals(vd('echo -e "verified"'), "deny");
  assertEquals(vd('echo "結論是 X"', rulesOf({ allow: ["Bash(echo *)"] })), "deny"); // echo 不可升級
  assertEquals(vd('printf "%s\\n" "結論"', rulesOf({ allow: ["Bash(printf *)"] })), "deny"); // printf 不可升級
});

Deno.test("閘② print-only 不被後置函式定義降級；前置真實/no-op 葉指令使其落他閘", () => {
  // 呼叫在前、定義在後，且鏈中無其他葉指令 → 整鏈仍只有 echo "fake" → 閘② deny
  assertEquals(vd('echo "fake"; echo(){ :; }'), "deny");
  // `if false; …` 會讓 walk 額外列舉 `false` 葉指令 → 非整鏈 print；且 echo 被（dead 分支）函式定義
  // 遮蔽 → 落閘③ ask。靜態分析無法判定分支不可達，保守 ask（安全、非靜默 allow）。
  assertEquals(vd("if false; then echo(){ :; }; fi; echo fake"), "ask");
});

Deno.test("非整鏈 print → 不 deny", () => {
  assertEquals(vd("make && echo DONE"), "ask");
  assertEquals(vd('echo -e "a\\tb"'), "allow");                 // carve-out
  assertEquals(vd('printf "%05d\\n" 42'), "ask");               // carve-out（printf 非 allowlist）
});

Deno.test("heredoc body 命令替換經逐一分類（含繼承）；寫檔 heredoc 非 deny", () => {
  // body 內 rm 逐一分類 → ask；且 Bash(cat *) 無法升級 rm（自身與繼承 heredoc 皆然）
  assertEquals(vd("cat <<EOF\n$(rm -rf x)\nEOF"), "ask");
  assertEquals(vd("cat <<EOF\n$(rm -rf x)\nEOF", rulesOf({ allow: ["Bash(cat *)"] })), "ask");
  assertEquals(vd("{ cat; } <<EOF\n$(rm -rf x)\nEOF"), "ask");
  assertEquals(vd("{ cat; } <<EOF\n$(rm -rf x)\nEOF", rulesOf({ allow: ["Bash(cat *)"] })), "ask");
  // 內層 git log 為唯讀子指令 → allow；純變數 heredoc 無命令執行 → allow
  assertEquals(vd("cat <<EOF\n$(git log)\nEOF"), "allow");
  assertEquals(vd("cat <<EOF\n$HOME\nEOF"), "allow");
  // 寫檔 heredoc：`>` 寫入重導向 → 非 print 形態 → 中央寫入規則 ask（非 deny）
  assertEquals(vd("cat > /tmp/x <<EOF\nfake\nEOF"), "ask");
});

Deno.test("閘① 字面 sleep → deny（不受遮蔽/賦值/重導向/升級影響）", () => {
  assertEquals(vd("sleep 5"), "deny");
  assertEquals(vd("sleep"), "deny");
  assertEquals(vd("sleep 0.5"), "deny");
  assertEquals(vd("sleep 5 && make"), "deny");
  assertEquals(vd("sleep 2; echo waiting"), "deny");
  assertEquals(vd("FOO=1 sleep 5"), "deny");
  assertEquals(vd("sleep 5 > out"), "deny");
  assertEquals(vd('echo "$(sleep 5)"'), "deny");
  assertEquals(vd("while true; do sleep 1; done"), "deny");
  assertEquals(vd("for i in 1 2; do sleep 1; done"), "deny");
  assertEquals(vd("sleep 1", rulesOf({ allow: ["Bash(sleep *)"] })), "deny"); // 不可升級
  assertEquals(vd("sleep(){ :; }; sleep 5"), "deny");           // 遮蔽不豁免
  assertEquals(vd("sleep 5; sleep(){ :; }"), "deny");
});

Deno.test("閘① sleep deny 理由透過 pollingDenyReason 傳出", () => {
  const d = evaluate("sleep 5", ROOT, AT_ROOT);
  assertEquals(d.verdict, "deny");
  assertStringIncludes(d.reason, "ScheduleWakeup");
});

Deno.test("閘③ 函式遮蔽 → ask（不可升級）", () => {
  assertEquals(vd("date(){ sleep 5; }; date"), "ask");
  assertEquals(vd("pwd(){ echo fake; }; pwd"), "ask");
  assertEquals(vd("waiter(){ sleep 5; }; waiter"), "ask");
  assertEquals(vd("date(){ sleep 5; }; date", rulesOf({ allow: ["Bash(date *)"] })), "ask");
  assertEquals(vd('echo "$(date(){ rm x; }; date)"'), "ask");   // 替換內定義 + 呼叫
  assertEquals(vd("f(){ :; }; ls -la"), "allow");               // ls 未被遮蔽
});

Deno.test("已接受繞道：巢狀直譯器 / exec wrapper / 等價等待原語 預設 ask；廣域 allow 可升級", () => {
  // 預設（無對應 permissions.allow）→ ask（葉指令名非 allowlist）
  assertEquals(vd("bash -c 'echo fake'"), "ask");
  assertEquals(vd("eval 'echo fake'"), "ask");
  assertEquals(vd("python -c 'import time; time.sleep(5)'"), "ask");
  assertEquals(vd("read -t 5"), "ask");
  assertEquals(vd("timeout 5 sleep 10"), "ask");
  assertEquals(vd("env sleep 5"), "ask");
  assertEquals(vd("command echo fake"), "ask");
  // 既有升級層：使用者自設廣域 allow → allow（使用者自負；本功能不硬擋）
  assertEquals(vd("bash -c 'echo fake'", rulesOf({ allow: ["Bash(bash *)"] })), "allow");
  assertEquals(vd("timeout 5 sleep 10", rulesOf({ allow: ["Bash(timeout *)"] })), "allow");
});
```

The `assertStringIncludes` import: the existing file imports only `assertEquals`. Extend its first line to:

```ts
import { assertEquals, assertStringIncludes } from "@std/assert";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL — gates not yet added (e.g. `echo "結論是 X"` returns `allow`).

- [ ] **Step 3: Insert the three gates**

In `src/engine/evaluate.ts`, add imports near the top:

```ts
import { isAllPrintOnly } from "./print_only.ts";
import { definedFunctionNames } from "./walk.ts";
import { functionShadowReason, pollingDenyReason, printOnlyDenyReason } from "../rules/types.ts";
```

In the `try` block, replace:

```ts
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
```

with:

```ts
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    // 閘①（deny）：任何字面 sleep 葉指令（含控制流內、命令替換內層）—— 不因遮蔽而豁免
    if (invocations.some((inv) => inv.name === "sleep")) {
      return { verdict: "deny", reason: pollingDenyReason() };
    }
    // 閘②（deny）：整鏈皆 print 形態 —— 不因遮蔽而豁免
    if (isAllPrintOnly(invocations)) {
      return { verdict: "deny", reason: printOnlyDenyReason() };
    }
    // 閘③（ask）：被呼叫的名被同腳本函式遮蔽 → name 分析不可信 → 人工確認
    const fnNames = definedFunctionNames(script);
    if (fnNames.size > 0 && invocations.some((inv) => inv.name !== null && fnNames.has(inv.name))) {
      return { verdict: "ask", reason: functionShadowReason() };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/evaluate.ts src/engine/evaluate_test.ts
git commit -m "feat(evaluate): add sleep/print-only/function-shadow hard-deny gates"
```

---

### Task 8: 4th central pre-rule — input redirect `<` scope (`src/engine/classify.ts`)

**Files:**
- Modify: `src/engine/classify.ts` (inside `classifyBuiltin`, after the assignment-prefix rule)
- Test: `src/engine/classify_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/classify_test.ts`:

```ts
Deno.test("輸入重導向 < 目標範圍檢查（第4條中央前置規則）", () => {
  assertEquals(only("cat < /etc/passwd").kind, "ask");
  assertEquals(only("grep pat < /etc/shadow").kind, "ask");
  assertEquals(only("cat < src/a.ts").kind, "allow");           // in-project
  assertEquals(only("head < src/x.ts").kind, "allow");          // in-project（其他讀指令同理）
  assertEquals(only("cat < $VAR").kind, "ask");                  // 動態 target
  assertEquals(only("cat <<EOF\nx\nEOF").kind, "allow");         // heredoc 非 `<`，不受此規則
});

Deno.test("輸入重導向 ask 可被 Bash() 升級", () => {
  assertEquals(onlyWith("cat < /etc/passwd", rulesOf({ allow: ["Bash(cat *)"] })).kind, "allow");
});

Deno.test("輸入重導向 ask 可被 Read() 讀取範圍放寬升級", () => {
  // rulesWithRead 為 classify_test.ts 既有 helper（將 Read(...) 規則轉成 readScope.allow）
  assertEquals(onlyWith("cat < /etc/passwd", rulesWithRead(["Read(//etc/passwd)"])).kind, "allow");
});
```

> Reuse the existing `rulesWithRead([...])` helper already defined in `src/engine/classify_test.ts` (do not redefine it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: FAIL — `cat < /etc/passwd` returns `allow` (input redirect not scoped).

- [ ] **Step 3: Add the central pre-rule**

In `src/engine/classify.ts`, inside `classifyBuiltin`, after the existing assignment-prefix check (`if (inv.assignments.length > 0) { ... }`) and **before** `return rule.evaluate({...})`, insert:

```ts
  // 中央前置規則之四：輸入重導向 `<` 的目標路徑須落在允許讀取範圍
  for (const r of inv.redirects) {
    if (r.operator !== "<") continue;          // 只查讀檔 `<`；heredoc/here-string 與 fd 複製不在此
    if (!r.target) continue;
    if (resolvePath(r.target, inv.cwd, scope) !== "in-project") {
      return ask(`${inv.name}：輸入重導向讀取超出專案範圍或無法靜態解析（${r.target.value}）`);
    }
  }
```

> `resolvePath` and `ask` are already imported in `classify.ts`; `scope` and `inv.cwd` are in scope inside `classifyBuiltin`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/classify.ts src/engine/classify_test.ts
git commit -m "feat(classify): scope-check input redirect < targets (4th central pre-rule)"
```

---

### Task 9: `tailRule` follow-mode gate (`src/rules/commands/tail.ts`)

**Files:**
- Create: `src/rules/commands/tail.ts`
- Modify: `src/rules/commands/coreutils.ts:12-16` (remove `"tail"`)
- Modify: `src/rules/allowlist.ts`
- Test: `src/rules/commands/tail_test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/rules/commands/tail_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { tailRule } from "./tail.ts";
import { lookupRule } from "../allowlist.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

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
const v = (src: string) => tailRule.evaluate(ctxOf("tail", src)).kind;

Deno.test("tail follow → ask", () => {
  assertEquals(v("tail -f log"), "ask");
  assertEquals(v("tail -F log"), "ask");
  assertEquals(v("tail --follow log"), "ask");
  assertEquals(v("tail --follow=name log"), "ask");
  assertEquals(v("tail --retry log"), "ask");
  assertEquals(v("tail -fn10 log"), "ask");   // 短旗標群集含 f + 數字
  assertEquals(v("tail -Fq log"), "ask");     // 短旗標群集含 F
});

Deno.test("tail 非 follow → allow（唯讀）", () => {
  assertEquals(v("tail log"), "allow");
  assertEquals(v("tail -n 20 log"), "allow");
  assertEquals(v("tail -f /etc/x"), "ask");   // follow 先於範圍
});

Deno.test("tail 在 allowlist；cut -f 不受影響", () => {
  assertEquals(lookupRule("tail"), tailRule);
  assertEquals(lookupRule("cut")?.evaluate(ctxOf("cut", "cut -f1 data.csv")).kind, "allow");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/tail_test.ts`
Expected: FAIL — `./tail.ts` does not exist.

- [ ] **Step 3a: Create `tail.ts`**

Create `src/rules/commands/tail.ts`:

```ts
import type { CommandRule } from "../types.ts";
import type { FlagMatcher } from "../flags.ts";
import { exact, prefix } from "../flags.ts";
import { flagGatedReader } from "../factory.ts";

/** 短旗標群集含 f / F（如 -fn、-Fq、-fn10），代表 follow 模式。允許群集尾端帶數字（-fn10 = -f -n 10）。 */
const shortClusterHasF: FlagMatcher = (t) =>
  /^-[A-Za-z0-9]+$/.test(t) && /[fF]/.test(t.slice(1));

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  askFlags: [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF],
  valueFlags: [exact("-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats")],
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
});
```

- [ ] **Step 3b: Remove `"tail"` from `fileReaderRule`**

In `src/rules/commands/coreutils.ts`, the `fileReaderRule` `names` array currently includes `"tail"`. Remove it. Change:

```ts
  names: [
    "cat", "head", "tail", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
```
to:
```ts
  names: [
    "cat", "head", "wc", "ls", "stat", "cut", "tr", "column",
    "cmp", "comm", "md5sum", "sha256sum", "hexdump", "jq", "nl", "fold",
    "basename", "dirname", "realpath", "readlink",
  ],
```

- [ ] **Step 3c: Register `tailRule` in the allowlist**

In `src/rules/allowlist.ts`, add the import after the other command imports:

```ts
import { tailRule } from "./commands/tail.ts";
```

And add `tailRule,` to the `RULES` array (e.g. after `fileReaderRule,`):

```ts
const RULES: CommandRule[] = [
  fileReaderRule,
  tailRule,
  diffRule,
  // ... rest unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/tail_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules/commands/tail.ts src/rules/commands/coreutils.ts src/rules/allowlist.ts src/rules/commands/tail_test.ts
git commit -m "feat(tail): gate tail -f/--follow to ask via dedicated tailRule"
```

---

### Task 10: e2e tests, full verification & docs

**Files:**
- Modify: `src/main_test.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the failing e2e tests**

Append to `src/main_test.ts` (reuses the existing `runHook` helper):

```ts
Deno.test("e2e: print-only chain -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: 'echo "結論是 X"' }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: sleep -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "sleep 5" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: real command + status echo -> not deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "make && echo DONE" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: heredoc body command substitution -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat <<EOF\n$(rm -rf x)\nEOF" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: input redirect external read -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat < /etc/passwd" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: tail -f -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "tail -f x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
```

- [ ] **Step 2: Run the e2e tests to verify they pass**

Run: `deno test --allow-run --allow-env --allow-read --allow-sys=uid src/main_test.ts`
Expected: PASS (gates already implemented in Tasks 1–9; these confirm the full subprocess path).

- [ ] **Step 3: Run the full verification suite**

Run:
```bash
deno task check && deno task lint && deno task test
```
Expected: type-check clean, lint clean, all tests pass (0 failed). Fix any failures before continuing.

- [ ] **Step 4: Build and do operational verification**

Run:
```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"echo \"結論是 X\""},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # expect deny
echo '{"tool_name":"Bash","tool_input":{"command":"sleep 5"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # expect deny
echo '{"tool_name":"Bash","tool_input":{"command":"make && echo DONE"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # expect ask (not deny)
echo '{"tool_name":"Bash","tool_input":{"command":"cat < /etc/passwd"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # expect ask
echo '{"tool_name":"Bash","tool_input":{"command":"tail -f x"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # expect ask
```
Expected: each line prints JSON with the noted `permissionDecision` and exits 0.

- [ ] **Step 5: Update `CLAUDE.md`**

Edit `CLAUDE.md` per spec §9 (make each of these edits explicitly):
- 「這是什麼」段：deny 改述為**三類**（遞迴根掃描、整鏈 print-only 偽裝、sleep 輪詢）。
- 「架構（評估管線）」段：補 `evaluate` 在 walk 後、classify 前的**三閘**（①sleep→deny、②整鏈 print-only→deny、③函式遮蔽→ask）；補 `print_only.ts` 模組與 `walk` 的 `redirect.body` 列舉（含繼承）+ `definedFunctionNames`。
- 「第三方套件：unbash」段：版本 **3.0.0 → 4.0.1**；補一條已查證事實——未引號 heredoc body 含展開時，`redirect.body` 為**結構化 Word**（其 `CommandExpansion.script` 為完整解析的內層指令），引號分隔符 `<<'EOF'` 則 `body` 為 `undefined`。
- 「三條中央前置規則」段：標題與內容改為**四條**，補第 4 條「輸入重導向 `<` 目標 `resolvePath` 超出讀取範圍 → ask」；另補 `tailRule`（`tail -f`/`-F`/`--follow`→ask，已從 `fileReaderRule` 移出）。
- 「核心不變量」段：deny 三類；三閘皆在 classify 前短路、不過 `settingsAllows`，不可由 `permissions.allow` 解除。
- 「hook 決策 vs settings.json 權限的優先序」段：補 print-only / sleep 兩類硬 deny 不可解除；並**分開**記錄 §1.5 兩種不同性質的已接受繞道：
  - **預設 ask、可由使用者自設廣域 `Bash(...)` 升級為 allow（使用者自負）**：巢狀直譯器（`bash -c`/`eval`/`python -c`/`perl -e`）、exec wrapper（`command`/`env`/`nice`/`nohup`/`timeout`）、等價等待原語（`read -t`、`python -c 'time.sleep'`）、以及 `tail -f`（現為 ask、可由 `Bash(tail *)` 升級）。
  - **「整鏈 print」洗白繞道**（`pwd; echo 假`、`true && echo 已驗證`、`cat README.md; printf 假`）：因鏈中有真實 / no-op 指令而**非全鏈 print**，故**不 deny**，落該真實指令的既有判定（可能是 `allow` 或 `ask`，**非**「預設 ask + 升級」那一類）。此為使用者明確選擇維持乾淨結構規則、零誤殺的取捨。

- [ ] **Step 6: Commit**

```bash
git add src/main_test.ts CLAUDE.md
git commit -m "test(main): e2e for print-only/sleep/heredoc/input-redirect/tail; docs(CLAUDE): three deny classes"
```

---

## Done criteria

- `deno task check`, `deno task lint`, `deno task test` all green.
- Operational verification (Task 10 Step 4) shows deny/ask exactly as noted, exit 0 for every input.
- Spec §1.5 accepted-bypass behaviors remain as documented (no attempt to hard-deny nested interpreters / exec wrappers / no-op-laundered print chains).
