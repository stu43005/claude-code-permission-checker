# 統一 print-only 載具偽裝 deny 閘 ＋ 名稱重定義 deny 閘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有「shell 層 print-only 偽裝 deny」升級為跨載具（echo/printf/cat + node/python 等直譯器）的統一閘③，並新增「函式定義＋alias 類名稱重定義 → deny」閘②。

**Architecture:** `evaluate` 於 `classify` 前依序過閘①(sleep)→閘②(名稱重定義)→no-op→閘③(printDisguiseDeny)。新增純函式模組 `interp_payload.ts`（直譯器 payload 述詞）、`static_output.ts`（shell 靜態輸出還原＋既有 print-eligible 判定），改造 `print_only.ts` 為「載具框架＋單一自足 AST 走訪的聚合入口」，`walk.ts` 加兩個唯讀 helper。全程純詞法、不碰檔案系統、fail-safe（不確定 → 不 deny）。

**Tech Stack:** Deno + TypeScript；`unbash@4.0.1`；`@std/assert`；`deno compile`。

**規格來源：** `docs/superpowers/specs/2026-06-28-interpreter-print-disguise-deny-design.md`（HEAD b535f32）。行為對照與測試取自該規格 §4/§7。

**已查證的 unbash 4.0.1 AST 事實（實作以此為準，勿再自行探測）：**
- `Statement { command: Node; background?: boolean; redirects: Redirect[] }`——背景 `&` 在 `Statement.background === true`。
- `Pipeline { commands: Node[]; negated?: boolean; operators: string[] }`——否定 `!` 在 **`Pipeline.negated`**（非 Statement）；成員為 **Node[]**（bare `Command` 或 compound），非 Statement。單一簡單指令**加否定**時包成 1 成員 Pipeline(negated)；**加 pipe** 時為 ≥2 成員 Pipeline。
- `AndOr { commands: Node[]; operators: string[] }`——`operators[k-1]` 是 `commands[k]` 之前的連接符（`"&&"`/`"||"`）；成員為 Node[]。
- `Command { name?: Word; prefix: AssignmentPrefix[]; suffix: Word[]; redirects: Redirect[] }`。
- `Redirect { operator: string; target?: Word; content?: string; body?: Word; fileDescriptor?: number; heredocQuoted?: boolean }`——`fileDescriptor` 預設省略（`>` 視 1、`<<` 視 0）；未引號 heredoc 純文字在 `content`，引號 heredoc `heredocQuoted===true` 且 `body` 常為 undefined、`content` 保留原文；含 `$()` 的未引號 heredoc `body` 為結構化 `Word`。
- `Word.parts[]` 可含 `CommandExpansion`/`ProcessSubstitution`（帶 `.script: Script`），亦可巢狀於 `DoubleQuoted.parts`。
- `bun run <file>` / `deno run <file>`：`suffix = [run, <file>]`（子指令 `run` 後接進入點）；`deno eval <payload>` 為 inline；`deno run -` / `bun run -` 的 `-` **不特案**（保守 under-deny）。

**全域約定：**
- 每個 Task 完成後 `deno task check && deno task lint`，綠燈才 commit。
- 工作目錄共用，**不使用 worktree 隔離**。
- commit 一律 `git add <具體路徑>`，不用 `git add -A`。
- **程式碼註解不得引用 spec/plan 文件**（不得出現「§4.1」「見規格」等）；註解須自足。
- 新增測試若在既有測試檔末尾追加，**不得重複 import 或重宣告既有的頂層綁定**；用未與既有衝突的區域名稱。

---

## File Structure

| 檔案 | 職責 | 動作 |
|---|---|---|
| `src/engine/interp_payload.ts` | `payloadIsAllStaticPrint`、`printExprIsStaticString`（手寫 fail-safe tokenizer + 文法比對） | Create |
| `src/engine/interp_payload_test.ts` | 上者單元測試 | Create |
| `src/engine/static_output.ts` | 自 print_only.ts 移入 print-eligible 判定 + 新增 `echoText`/`printfText`/`catTacText`/`producerStdout`/`writtenContent` | Create |
| `src/engine/static_output_test.ts` | 上者單元測試 | Create |
| `src/engine/print_only.ts` | 改 import 移出的判定；新增 `recognizeInterpreter`/`leafCarrier`（Task 5）與 `printDisguiseDeny`（Task 6）；保留 `isPrintOnlyForm`/`isAllPrintOnly` 供既有回歸測試 | Modify |
| `src/engine/print_only_test.ts` | 既有測試保留 + 新增 leafCarrier/printDisguiseDeny 測試 | Modify |
| `src/engine/walk.ts` | 新增 `hasExecutableFunctionDefinition`、`hasAliasRedefinition` | Modify |
| `src/engine/walk_test.ts` | 上兩 helper 測試 | Modify |
| `src/rules/types.ts` | 新增 `printDisguiseDenyReason`/`nameRedefinitionDenyReason`；Task 7 移除 `printOnlyDenyReason`/`functionShadowReason` | Modify |
| `src/rules/types_test.ts` | Task 7 移除舊 reason 測試、加新 reason 測試 | Modify |
| `src/engine/evaluate.ts` | 接線閘②/③、no-op 移到閘②後 | Modify |
| `src/engine/evaluate_test.ts` | 閘②/③/排序整合測試 | Modify |
| `src/main_test.ts` | e2e：不可升級（含 settings fixture）、no-side-effect、migration | Modify |
| `deno.json` | test task 加 `--allow-write`（e2e 建臨時檔需要） | Modify |
| `CLAUDE.md` | deny 三類→四類、架構管線、已接受繞道 | Modify |

---

## Task 1: `interp_payload.ts` — 直譯器 payload 述詞

**Files:**
- Create: `src/engine/interp_payload.ts`
- Test: `src/engine/interp_payload_test.ts`

- [ ] **Step 1: 寫失敗測試**

Create `src/engine/interp_payload_test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { payloadIsAllStaticPrint, printExprIsStaticString } from "./interp_payload.ts";

Deno.test("payloadIsAllStaticPrint: js 命中", () => {
  const t = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), true, s);
  t('console.log("fake")');
  t('console.log("a");\nconsole.log("b")');
  t('// comment\nconsole.log("x")');
  t('console.log("a", "b", 1)');
  t('console.log(`plain`)');
  t('console.error("e"); console.info("i")');
  t('process.stdout.write("fake")');
  t('console.log(42)');
  t('console.log(-1)');            // 帶號數字
});

Deno.test("payloadIsAllStaticPrint: js 不命中", () => {
  const f = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), false, s);
  f('console.log(1+1)');
  f('console.log("a"+"b")');
  f('console.log(JSON.stringify(x))');
  f('console.log(x)');
  f('console.log(`${x}`)');
  f('import x from "y"; console.log("a")');
  f('if (a) console.log("x")');
  f('console.log(');
  f('console.log("unterminated');
  f('');
  f('console.log()');
  f('process.stdout.write(42)');
  f('foo("x")');
});

Deno.test("payloadIsAllStaticPrint: py", () => {
  assertEquals(payloadIsAllStaticPrint('print("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint("print('a')\nprint('b')", "py"), true);
  assertEquals(payloadIsAllStaticPrint('# c\nprint("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print("""multi""")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print(-1)', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print(json.dumps(d))', "py"), false);
  assertEquals(payloadIsAllStaticPrint('print(f"{x}")', "py"), false);
  assertEquals(payloadIsAllStaticPrint('print("x", end="")', "py"), false);
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write(1)', "py"), false);
});

Deno.test("payloadIsAllStaticPrint: 資源上限超標 → false", () => {
  assertEquals(payloadIsAllStaticPrint('console.log("x");'.repeat(20000), "js"), false);
});

Deno.test("printExprIsStaticString", () => {
  assertEquals(printExprIsStaticString('"fake"', "js"), true);
  assertEquals(printExprIsStaticString('"a" + "b"', "js"), true);
  assertEquals(printExprIsStaticString('`x`', "js"), true);
  assertEquals(printExprIsStaticString('1+1', "js"), false);
  assertEquals(printExprIsStaticString('os.cpus()', "js"), false);
  assertEquals(printExprIsStaticString('`${x}`', "js"), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/interp_payload_test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `interp_payload.ts`**

Create `src/engine/interp_payload.ts`:

```typescript
// 直譯器 payload 述詞：判定一段 source 是否「整段只是一條以上的 print 敘述印死字串」。
// 手寫 fail-safe tokenizer + 文法比對；任何不確定一律回 false（不 deny）。

export type Lang = "js" | "py";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOKENS = 20000;

type TokKind = "STRING" | "NUMBER" | "NAME" | "PUNCT" | "SIGN" | "DYNAMIC" | "OTHER";
interface Tok {
  kind: TokKind;
  value: string;
}

const TEXT_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["console.log", "console.info", "console.warn", "console.error", "console.debug"]),
  py: new Set(["print"]),
};
const WRITE_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["process.stdout.write", "process.stderr.write"]),
  py: new Set(["sys.stdout.write", "sys.stderr.write"]),
};

const NAME_START = /[A-Za-z_$]/;
const NAME_CONT = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function tokenize(src: string, lang: Lang): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (t: Tok) => { out.push(t); };
  while (i < n) {
    if (out.length > MAX_TOKENS) return null;
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "#" && src[i + 1] === "!" && (i === 0 || src[i - 1] === "\n")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (lang === "py" && c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) return null;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const r = readString(src, i, lang);
      if (r === null) return null;
      push({ kind: r.dynamic ? "DYNAMIC" : "STRING", value: "" });
      i = r.next;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._n]/.test(src[j])) j++;
      // 指數 e/E 後可接 +/-
      if ((src[j] === "e" || src[j] === "E") && /[+\-0-9]/.test(src[j + 1] ?? "")) {
        j += 2;
        while (j < n && DIGIT.test(src[j])) j++;
      }
      push({ kind: "NUMBER", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && (NAME_CONT.test(src[j]) || (src[j] === "." && NAME_CONT.test(src[j + 1] ?? "")))) j++;
      push({ kind: "NAME", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "+" || c === "-") { push({ kind: "SIGN", value: c }); i++; continue; }
    if (c === "(" || c === ")" || c === "," || c === ";") { push({ kind: "PUNCT", value: c }); i++; continue; }
    push({ kind: "OTHER", value: c });
    i++;
  }
  return out;
}

function readString(src: string, start: number, lang: Lang): { next: number; dynamic: boolean } | null {
  const n = src.length;
  const quote = src[start];
  if (quote === "`" && lang === "js") {
    let i = start + 1;
    let dynamic = false;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") return { next: i + 1, dynamic };
      if (src[i] === "$" && src[i + 1] === "{") dynamic = true;
      i++;
    }
    return null;
  }
  if (lang === "py" && (quote === '"' || quote === "'") && src[start + 1] === quote && src[start + 2] === quote) {
    const triple = quote.repeat(3);
    let i = start + 3;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src.startsWith(triple, i)) return { next: i + 3, dynamic: false };
      i++;
    }
    return null;
  }
  let i = start + 1;
  while (i < n) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return { next: i + 1, dynamic: false };
    if (src[i] === "\n" && lang === "js") return null;
    i++;
  }
  return null;
}

// 修正字串前綴：py f-string → DYNAMIC；r/b 前綴 → 保留 STRING。
function applyStringPrefixes(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === "NAME" && /^[fF]$/.test(t.value) && toks[k + 1]?.kind === "STRING") {
      out.push({ kind: "DYNAMIC", value: "" });
      k++;
      continue;
    }
    if (t.kind === "NAME" && /^(r|b|rb|br|R|B)$/.test(t.value) && toks[k + 1]?.kind === "STRING") {
      out.push(toks[k + 1]);
      k++;
      continue;
    }
    out.push(t);
  }
  return out;
}

// 消費一個 ARG：選擇性 SIGN + (STRING | NUMBER)。textApi=true 才允許 NUMBER。回下一個索引或 -1（不合法）。
function consumeArg(toks: Tok[], i: number, textApi: boolean): number {
  if (toks[i]?.kind === "SIGN") i++;               // 帶號
  const k = toks[i]?.kind;
  if (k === "STRING") return i + 1;
  if (k === "NUMBER" && textApi) return i + 1;
  return -1;
}

export function payloadIsAllStaticPrint(source: string, lang: Lang): boolean {
  if (source.length > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = applyStringPrefixes(raw);
  const textFns = TEXT_PRINT_FNS[lang];
  const writeFns = WRITE_PRINT_FNS[lang];

  let i = 0;
  let stmts = 0;
  const n = toks.length;
  while (i < n) {
    const fn = toks[i];
    if (fn.kind !== "NAME") return false;
    const isText = textFns.has(fn.value);
    const isWrite = writeFns.has(fn.value);
    if (!isText && !isWrite) return false;
    i++;
    if (toks[i]?.value !== "(") return false;
    i++;
    if (toks[i]?.value === ")") return false;        // 無引數
    let j = consumeArg(toks, i, isText);
    if (j < 0) return false;
    i = j;
    while (toks[i]?.value === ",") {
      i++;
      j = consumeArg(toks, i, isText);
      if (j < 0) return false;
      i = j;
    }
    if (toks[i]?.value !== ")") return false;
    i++;
    if (toks[i]?.value === ";") i++;
    stmts++;
  }
  return stmts >= 1;
}

export function printExprIsStaticString(source: string, lang: Lang): boolean {
  if (source.length > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = applyStringPrefixes(raw);
  if (toks.length === 0) return false;
  let i = 0;
  if (toks[i]?.kind !== "STRING") return false;
  i++;
  while (i < toks.length) {
    if (toks[i]?.kind !== "OTHER" || toks[i]?.value !== "+") return false;
    i++;
    if (toks[i]?.kind !== "STRING") return false;
    i++;
  }
  return true;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/interp_payload_test.ts`
Expected: PASS。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/interp_payload.ts src/engine/interp_payload_test.ts
git commit -m "feat(engine): add interp_payload static-print predicate"
```

---

## Task 2: `static_output.ts` — 移入 print-eligible 判定 ＋ 靜態輸出還原

**Files:**
- Create: `src/engine/static_output.ts`
- Test: `src/engine/static_output_test.ts`
- Modify: `src/engine/print_only.ts`（改 import）

把 `print_only.ts` 現有的低層判定移入 `static_output.ts` 並 `export`，再新增還原函式。**還原函式吃原 `Command` 節點**（保留 `name`）。分兩種語意：`producerStdout`（純 stdout，有寫入重導向 → null，供 pipe producer）與 `writtenContent`（寫檔內容，忽略寫入重導向，供 WRITE 葉）。

- [ ] **Step 1: 寫失敗測試**

Create `src/engine/static_output_test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { catTacText, echoText, printfText, producerStdout, writtenContent } from "./static_output.ts";

function cmd(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("echoText: 靜態 → 字串；動態/carve-out → null", () => {
  assertEquals(echoText(cmd("echo hello world")), "hello world\n");
  assertEquals(echoText(cmd("echo -n hi")), "hi");
  assertEquals(echoText(cmd('echo "$VAR"')), null);
  assertEquals(echoText(cmd('echo -e "a\\tb"')), null);   // -e + 反斜線 → 探測 carve-out
});

Deno.test("printfText: %s 純字串 → 還原；數值轉換符 → null", () => {
  assertEquals(printfText(cmd("printf '%s\\n' hi")), "hi\n");
  assertEquals(printfText(cmd("printf '%d' 5")), null);
});

Deno.test("catTacText: cat 原序、tac 行反轉", () => {
  assertEquals(catTacText(cmd("cat <<'EOF'\nA\nB\nEOF")), "A\nB\n");
  assertEquals(catTacText(cmd("tac <<'EOF'\nA\nB\nEOF")), "B\nA\n");
  assertEquals(catTacText(cmd("cat file.txt")), null);
});

Deno.test("producerStdout: 有寫入重導向 → null；純 stdout → 字串", () => {
  assertEquals(producerStdout(cmd("echo hi")), "hi\n");
  assertEquals(producerStdout(cmd("echo hi > f")), null);   // 寫檔 → 非 stdout
});

Deno.test("writtenContent: 寫檔內容（忽略寫入重導向）", () => {
  assertEquals(writtenContent(cmd("echo 'console.log(1)' > f")), "console.log(1)\n");
  assertEquals(writtenContent(cmd("cat > f <<'EOF'\nX\nEOF")), "X\n");
  assertEquals(writtenContent(cmd("tac > f <<'EOF'\nA\nB\nEOF")), "B\nA\n");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/static_output_test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 從 `print_only.ts` 剪下低層判定、貼入 `static_output.ts` 並 export**

從**現有** `src/engine/print_only.ts` 剪下以下函式（**原封不動、加 `export`**）貼入新檔 `src/engine/static_output.ts`：`hasLeadingTilde`、`wordPrintEligible`、`topPartEligible`、`heredocBodyEligible`、`isHeredocPrintEligible`、`isEchoPrintOnly`、`isPrintfPrintOnly`、`hasFormatterConversion`、`isCatPassthrough`、`hasFileOperand`。頂部 import 對齊：

```typescript
import type { CommandInvocation } from "../types.ts";
import type { Command, Redirect, Word, WordPart } from "../deps.ts";
import { isStatic, nestedPartIsDynamic, staticValue, topPartIsDynamic } from "./word.ts";
import { hasWriteRedirect } from "./redirect.ts";
```

其中 `wordPrintEligible`、`isEchoPrintOnly`、`isPrintfPrintOnly`、`isCatPassthrough`、`isHeredocPrintEligible`、`hasFileOperand`、`hasFormatterConversion` 加 `export`（其餘保持 module-private）。這些函式簽名沿用現有（吃 `Word`/`CommandInvocation`/`Redirect`）。

- [ ] **Step 4: 在 `static_output.ts` 末尾新增還原函式**

```typescript
/** 由 Command 取最小欄位視圖（保留 name）。 */
function inv(cmd: Command): Pick<CommandInvocation, "name" | "argv" | "redirects" | "assignments"> {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
  };
}

/** echo 邏輯輸出（忽略重導向/前綴）；動態或 -e+反斜線探測 → null。 */
export function echoText(cmd: Command): string | null {
  const c = inv(cmd);
  if (c.name !== "echo") return null;
  let noNewline = false;
  let escapes = false;
  let backslashPayload = false;
  const parts: string[] = [];
  let seenOperand = false;
  for (const w of c.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    if (!seenOperand && /^-[neE]+$/.test(v)) {
      if (v.includes("n")) noNewline = true;
      if (v.includes("e")) escapes = true;
      if (v.includes("E")) escapes = false;
      continue;
    }
    seenOperand = true;
    if (v.includes("\\")) backslashPayload = true;
    parts.push(v);
  }
  if (escapes && backslashPayload) return null;        // 探測 carve-out（與 isEchoPrintOnly 一致）
  const s = parts.join(" ");
  return noNewline ? s : s + "\n";
}

/** printf 邏輯輸出（僅 %s/%b/%% 純字串樣式；數值/日期等轉換符 → null）。 */
export function printfText(cmd: Command): string | null {
  const c = inv(cmd);
  if (c.name !== "printf") return null;
  const vals = c.argv.map((w) => staticValue(w));
  if (vals.some((v) => v === null)) return null;
  const args = vals as string[];
  let idx = 0;
  if (args[0] === "--") idx = 1;
  const fmt = args[idx];
  if (fmt === undefined) return "";
  if (fmt.startsWith("-") && fmt !== "--") return null;
  if (hasFormatterConversion(fmt)) return null;        // 數值/日期/%q/%n 等 → null
  const operands = args.slice(idx + 1);
  let out = "";
  let oi = 0;
  for (let k = 0; k < fmt.length; k++) {
    if (fmt[k] === "%" && fmt[k + 1] === "%") { out += "%"; k++; continue; }
    if (fmt[k] === "%" && (fmt[k + 1] === "s" || fmt[k + 1] === "b")) { out += operands[oi++] ?? ""; k++; continue; }
    if (fmt[k] === "\\" && fmt[k + 1] === "n") { out += "\n"; k++; continue; }
    if (fmt[k] === "\\" && fmt[k + 1] === "t") { out += "\t"; k++; continue; }
    out += fmt[k];
  }
  return out;
}

/** cat/tac 的 stdin passthrough 文字（cat 原序、tac 行反轉）；有檔案操作元/非合格 heredoc → null。 */
export function catTacText(cmd: Command): string | null {
  const c = inv(cmd);
  if (c.name !== "cat" && c.name !== "tac") return null;
  if (hasFileOperand(c.name, c.argv)) return null;
  const body = effectiveHeredocBody(c.redirects);
  if (body === null) return null;
  if (c.name === "tac") {
    const trailing = body.endsWith("\n");
    const lines = (trailing ? body.slice(0, -1) : body).split("\n");
    lines.reverse();
    return lines.join("\n") + (trailing ? "\n" : "");
  }
  return body;
}

/** fd0 最後者勝的有效 heredoc/here-string body 原文；非 passthrough → null。 */
function effectiveHeredocBody(redirects: Redirect[]): string | null {
  const fd0 = redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0.length === 0) return null;
  const eff = fd0[fd0.length - 1];
  if (eff.operator === "<<<") return eff.target ? staticValue(eff.target) : "";
  if (eff.operator !== "<<" && eff.operator !== "<<-") return null;
  if (!isHeredocPrintEligible(eff)) return null;
  return eff.content ?? "";
}

/** 純 stdout（供 pipe producer）：有寫入重導向 → null；否則依名還原。 */
export function producerStdout(cmd: Command): string | null {
  if (hasWriteRedirect(cmd.redirects) || cmd.prefix.length > 0) return null;
  return echoText(cmd) ?? printfText(cmd) ?? catTacText(cmd);
}

/** 寫檔內容（供 WRITE 葉；忽略寫入重導向，因重導向正是寫入目標）。 */
export function writtenContent(cmd: Command): string | null {
  return echoText(cmd) ?? printfText(cmd) ?? catTacText(cmd);
}
```

- [ ] **Step 5: 改 `print_only.ts` import 移出的判定**

在 `src/engine/print_only.ts` 刪除已移入的函式定義，頂部改為（把原本本檔定義、現由 static_output 提供的識別子改為 import）：

```typescript
import {
  hasFileOperand, isCatPassthrough, isEchoPrintOnly, isHeredocPrintEligible,
  isPrintfPrintOnly, wordPrintEligible,
} from "./static_output.ts";
export { wordPrintEligible } from "./static_output.ts";  // 既有測試由 print_only 匯入
```

`isPrintOnlyForm`（呼叫 `isEchoPrintOnly`/`isPrintfPrintOnly`/`isCatPassthrough`）與 `isAllPrintOnly` **保留在 print_only.ts**、改用 import 的判定。確認 `print_only.ts` 不再有這些函式的重複定義（否則 `deno check` 重複宣告錯誤）。

- [ ] **Step 6: 跑測試（新測試 + 既有 print_only 回歸全綠）**

Run: `deno test --allow-env src/engine/static_output_test.ts src/engine/print_only_test.ts`
Expected: PASS（static_output 新測試 + 既有 print_only 全部保留綠燈）。

- [ ] **Step 7: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/static_output.ts src/engine/static_output_test.ts src/engine/print_only.ts
git commit -m "feat(engine): add static_output (reconstruction + shared print-eligible helpers)"
```

---

## Task 3: `walk.ts` — 名稱重定義偵測 helper

**Files:**
- Modify: `src/engine/walk.ts`
- Test: `src/engine/walk_test.ts`

`hasExecutableFunctionDefinition(script)`（node-based fail-closed，**完整鏡射既有 `collectFns` 走訪**，含 ArithmeticCommand/TestCommand/Case 主體/Coproc/巢狀 `$()`）。`hasAliasRedefinition(invocations)`（name-based，解 builtin/command 包裝，`-v`/`-V` 查詢不算）。

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/walk_test.ts` **末尾**新增（若 `walk`/`parseCommand`/`assertEquals` 已於檔頂 import，勿重複；僅補匯入 `hasAliasRedefinition`/`hasExecutableFunctionDefinition`）：

```typescript
// 追加於檔案末尾；沿用檔頂既有 import，僅補：
import { hasAliasRedefinition, hasExecutableFunctionDefinition } from "./walk.ts";

const NR_CWD = { kind: "known", path: "/proj" } as const;
function nrScript(src: string) { return parseCommand(src).script; }
function nrInvs(src: string) { return walk(parseCommand(src).script, NR_CWD, "/proj"); }

Deno.test("hasExecutableFunctionDefinition: 可執行位置 → true", () => {
  assertEquals(hasExecutableFunctionDefinition(nrScript("f(){ echo hi; }; f")), true);
  assertEquals(hasExecutableFunctionDefinition(nrScript("f(){:;}")), true);
  assertEquals(hasExecutableFunctionDefinition(nrScript("if false; then f(){:;}; fi; echo hi")), true);
  assertEquals(hasExecutableFunctionDefinition(nrScript('echo "$(f(){:;}; f)"')), true);
  assertEquals(hasExecutableFunctionDefinition(nrScript("cat <<EOF\n$(g(){:;}; g)\nEOF")), true);
  assertEquals(hasExecutableFunctionDefinition(nrScript("[[ $(h(){:;}; h) ]]")), true);          // TestCommand
  assertEquals(hasExecutableFunctionDefinition(nrScript("case $(k(){:;}; k) in x) :; esac")), true); // Case 主體
});

Deno.test("hasExecutableFunctionDefinition: 資料 → false", () => {
  assertEquals(hasExecutableFunctionDefinition(nrScript("cat > x.sh <<'EOF'\nf(){ :; }\nEOF")), false);
  assertEquals(hasExecutableFunctionDefinition(nrScript("cat > x.sh <<EOF\nf(){ :; }\nEOF")), false);
  assertEquals(hasExecutableFunctionDefinition(nrScript("echo 'f(){ echo hi; }'")), false);
  assertEquals(hasExecutableFunctionDefinition(nrScript("cat <<'EOF'\n$(f(){:;}; f)\nEOF")), false);
  assertEquals(hasExecutableFunctionDefinition(nrScript("ls -la")), false);
});

Deno.test("hasAliasRedefinition: alias/unalias/shopt + builtin/command 包裝 → true", () => {
  assertEquals(hasAliasRedefinition(nrInvs("alias grep='rm -rf'; grep x")), true);
  assertEquals(hasAliasRedefinition(nrInvs("unalias -a")), true);
  assertEquals(hasAliasRedefinition(nrInvs("shopt -s expand_aliases; alias c=x")), true);
  assertEquals(hasAliasRedefinition(nrInvs("builtin alias x=y")), true);
  assertEquals(hasAliasRedefinition(nrInvs("command alias x=y")), true);
  assertEquals(hasAliasRedefinition(nrInvs("command builtin alias x=y")), true);
  assertEquals(hasAliasRedefinition(nrInvs("command -p alias x=y")), true);
  assertEquals(hasAliasRedefinition(nrInvs("if true; then alias a=b; fi")), true);
});

Deno.test("hasAliasRedefinition: 非啟用/查詢/資料/非 alias → false", () => {
  assertEquals(hasAliasRedefinition(nrInvs("shopt -s globstar")), false);
  assertEquals(hasAliasRedefinition(nrInvs("shopt -u expand_aliases")), false);
  assertEquals(hasAliasRedefinition(nrInvs("shopt expand_aliases")), false);
  assertEquals(hasAliasRedefinition(nrInvs("command ls")), false);
  assertEquals(hasAliasRedefinition(nrInvs("command -v alias")), false);   // 查詢，不執行
  assertEquals(hasAliasRedefinition(nrInvs("command -V unalias")), false);
  assertEquals(hasAliasRedefinition(nrInvs("cat > setup.sh <<'EOF'\nalias grep=x\nEOF")), false);
  assertEquals(hasAliasRedefinition(nrInvs("echo 'alias grep=x'")), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL（helper 未匯出）。

- [ ] **Step 3: 實作（`walk.ts` 末尾新增；`CommandInvocation`/`staticValue` 等已於檔頂 import，勿重複 import）**

```typescript
/** 是否存在任一「可執行位置」的函式定義（node-based；忽略函式名可否靜態還原）。鏡射 collectFns 走訪。 */
export function hasExecutableFunctionDefinition(script: Script): boolean {
  return seqHasFn(script.commands);
}

function seqHasFn(statements: Statement[]): boolean {
  return statements.some((s) =>
    s.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(s.command)
  );
}

function nodeHasFn(node: Node): boolean {
  switch (node.type) {
    case "Function":
      return true;
    case "Command": {
      const words: Word[] = [
        ...(node.name ? [node.name] : []),
        ...node.suffix,
        ...node.prefix.flatMap((a) => (a.value ? [a.value] : [])),
        ...node.redirects.flatMap((r) => (r.target ? [r.target] : [])),
        ...node.redirects.flatMap((r) => (r.body ? [r.body] : [])),
      ];
      return words.some(wordHasFn);
    }
    case "AndOr":
    case "Pipeline":
      return node.commands.some(nodeHasFn);
    case "Subshell":
    case "BraceGroup":
      return seqHasFn(node.body.commands);
    case "CompoundList":
      return seqHasFn(node.commands);
    case "If":
      return seqHasFn(node.clause.commands) || seqHasFn(node.then.commands) ||
        (node.else ? (node.else.type === "If" ? nodeHasFn(node.else) : seqHasFn(node.else.commands)) : false);
    case "For":
    case "Select":
      return node.wordlist.some(wordHasFn) || seqHasFn(node.body.commands);
    case "While":
      return seqHasFn(node.clause.commands) || seqHasFn(node.body.commands);
    case "ArithmeticFor":
      return arithHasFn(node.initialize) || arithHasFn(node.test) || arithHasFn(node.update) ||
        seqHasFn(node.body.commands);
    case "Case":
      return wordHasFn(node.word) ||
        node.items.some((it) => it.pattern.some(wordHasFn) || seqHasFn(it.body.commands));
    case "Statement":
      return node.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(node.command);
    case "ArithmeticCommand":
      return arithHasFn(node.expression);
    case "TestCommand":
      return node.expression ? testHasFn(node.expression) : false;
    case "Coproc":
      return (node.name ? wordHasFn(node.name) : false) || nodeHasFn(node.body);
    default:
      return false;
  }
}

function wordHasFn(word: Word | undefined): boolean {
  if (!word?.parts) return false;
  return word.parts.some(partHasFn);
}
function partHasFn(part: WordPart): boolean {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    return seqHasFn(part.script.commands);
  }
  if (part.type === "ArithmeticExpansion") return arithHasFn(part.expression);
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") return part.parts.some(partHasFn);
  return false;
}
function arithHasFn(expr: ArithmeticExpression | undefined): boolean {
  if (!expr) return false;
  switch (expr.type) {
    case "ArithmeticCommandExpansion":
      return expr.script ? seqHasFn(expr.script.commands) : false;
    case "ArithmeticBinary":
      return arithHasFn(expr.left) || arithHasFn(expr.right);
    case "ArithmeticUnary":
      return arithHasFn(expr.operand);
    case "ArithmeticTernary":
      return arithHasFn(expr.test) || arithHasFn(expr.consequent) || arithHasFn(expr.alternate);
    case "ArithmeticGroup":
      return arithHasFn(expr.expression);
    default:
      return false;
  }
}
function testHasFn(expr: TestExpression): boolean {
  switch (expr.type) {
    case "TestUnary":
      return wordHasFn(expr.operand);
    case "TestBinary":
      return wordHasFn(expr.left) || wordHasFn(expr.right);
    case "TestLogical":
      return testHasFn(expr.left) || testHasFn(expr.right);
    case "TestNot":
      return testHasFn(expr.operand);
    case "TestGroup":
      return testHasFn(expr.expression);
    default:
      return false;
  }
}

const ALIAS_BUILTINS = new Set(["alias", "unalias"]);

/** 是否存在 alias 類名稱重定義（含 builtin/command 包裝；-v/-V 查詢不算）。 */
export function hasAliasRedefinition(invocations: CommandInvocation[]): boolean {
  return invocations.some((i) => {
    const eff = unwrapDispatcher(i.name, i.argv);
    if (eff === null) return false;
    if (ALIAS_BUILTINS.has(eff.name)) return true;
    if (eff.name === "shopt") return shoptEnablesAliases(eff.argv);
    return false;
  });
}

function unwrapDispatcher(name: string | null, argv: Word[]): { name: string; argv: Word[] } | null {
  if (name === null) return null;
  if (name !== "builtin" && name !== "command") return { name, argv };
  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null;
    if (v === "-v" || v === "-V") return null;          // 查詢：不執行 → 非 alias 重定義
    if (v.startsWith("-") && v !== "-") { i++; continue; }
    return unwrapDispatcher(v, argv.slice(i + 1));       // 遞迴解多層
  }
  return null;
}

function shoptEnablesAliases(argv: Word[]): boolean {
  const vals = argv.map((w) => staticValue(w));
  return vals.includes("-s") && vals.includes("expand_aliases");
}
```

> `ArithmeticExpression`/`TestExpression`/`Statement`/`Word`/`WordPart`/`Node`/`Script` 已於 `walk.ts` 檔頂 import；`CommandInvocation` 亦已 import。勿重複 import。

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: PASS。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/walk.ts src/engine/walk_test.ts
git commit -m "feat(engine): add hasExecutableFunctionDefinition + hasAliasRedefinition"
```

---

## Task 4: `rules/types.ts` — 新增 deny 理由（只增不刪）

**Files:**
- Modify: `src/rules/types.ts`

**只新增** `printDisguiseDenyReason`/`nameRedefinitionDenyReason` 與 `PrintDisguiseKind` type。**不刪** `printOnlyDenyReason`/`functionShadowReason`（仍被 evaluate/types_test 使用，Task 7 才移除）。

- [ ] **Step 1: 新增理由函式**

在 `src/rules/types.ts` 末尾新增：

```typescript
export type PrintDisguiseKind =
  | "shell-print" | "interp-inline" | "write-exec" | "cat-readback" | "pipe";

/** 統一 print-only 載具偽裝的 deny 理由（依命中形態客製）。 */
export function printDisguiseDenyReason(kind: PrintDisguiseKind): string {
  const head: Record<PrintDisguiseKind, string> = {
    "shell-print": "整條指令每段都只是 echo/printf/cat 把靜態文字印到 stdout",
    "interp-inline": "你正用 -e/-c/-p 跑一段每行都只是 console.log/print 印死字串的程式",
    "write-exec": "你先把寫死文字寫進暫存檔、再用直譯器執行同檔把它印出來",
    "cat-readback": "你先把寫死文字寫進暫存檔、再 cat 讀回印出——與直接 echo 無異",
    "pipe": "你把寫死文字 pipe 給直譯器印出來",
  };
  return `已禁止：${head[kind]}。內容完全寫死、沒讀檔沒計算——偽裝成跑出來的驗證結果。` +
    `若你已有結論，請直接寫在回覆文字中；若需查證，請實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。`;
}

/** 名稱重定義（函式定義 / alias 類）的 deny 理由。 */
export function nameRedefinitionDenyReason(kind: "function" | "alias"): string {
  if (kind === "function") {
    return `已禁止：這個指令定義了 shell 函式（name(){…}）。函式可重定義任何指令名（如 grep(){ rm -rf; }）、` +
      `使本工具的指令名安全分析失真，屬危險構造；在單次 Bash 呼叫內定義函式無正當常見理由。` +
      `若需複用邏輯，請直接展開為具體指令、或拆成多次呼叫。`;
  }
  return `已禁止：這個指令用 alias/unalias/shopt -s expand_aliases 改變指令名的解析，可讓後續 grep/cat 等` +
    `執行成別的東西、繞過本工具的指令名安全分析。請勿在 Bash 呼叫內設定 alias；直接用真實指令名。`;
}
```

- [ ] **Step 2: check + lint + commit**

```bash
deno task check && deno task lint
git add src/rules/types.ts
git commit -m "feat(rules): add printDisguiseDenyReason + nameRedefinitionDenyReason"
```

---

## Task 5: `print_only.ts` — 直譯器旗標解析 ＋ 葉載具識別

**Files:**
- Modify: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

新增 `recognizeInterpreter(inv)`（保守 arity、per-language 旗標）與 `leafCarrier(inv)`（shell 靜態吐字 ＋直譯器 inline A / heredoc-stdin B）。

- [ ] **Step 1: 寫失敗測試（末尾追加；沿用既有 import，補 `leafCarrier`/`parseCommand`/`walk` 若尚未 import）**

在 `src/engine/print_only_test.ts` 末尾新增：

```typescript
import { leafCarrier } from "./print_only.ts";
// parseCommand / walk / CwdState 若檔頂已 import 則勿重複。

const LC_CWD = { kind: "known", path: "/proj" } as const;
function lc(src: string) { return leafCarrier(walk(parseCommand(src).script, LC_CWD, "/proj")[0]); }

Deno.test("leafCarrier: shell 靜態吐字", () => {
  assertEquals(lc("echo hi"), "shell");
  assertEquals(lc("printf '%s\\n' hi"), "shell");
  assertEquals(lc("cat <<'EOF'\nhi\nEOF"), "shell");
  assertEquals(lc("ls"), null);
});

Deno.test("leafCarrier: 直譯器 inline（A）per-language", () => {
  assertEquals(lc(`node -e 'console.log("fake")'`), "interp");
  assertEquals(lc(`python -c 'print("x")'`), "interp");
  assertEquals(lc(`node -p '"fake"'`), "interp");
  assertEquals(lc(`deno eval 'console.log("x")'`), "interp");
  assertEquals(lc(`node -e 'console.log(1+1)'`), null);
  assertEquals(lc(`node -p '1+1'`), null);
  assertEquals(lc(`node -c 'console.log("x")'`), null);   // node 無 -c → 非 inline
  assertEquals(lc(`python -e 'print("x")'`), null);       // python 無 -e
  assertEquals(lc(`node --no-warnings -e 'console.log("x")'`), "interp");
  assertEquals(lc(`node --title -e 'console.log("x")'`), null);        // 分離未知旗標 → 放棄
  assertEquals(lc(`node --require ./p.js -e 'console.log("x")'`), null);
  assertEquals(lc(`node --require=./p.js -e 'console.log("x")'`), null); // =value 注入
  assertEquals(lc(`X=1 node -e 'console.log("x")'`), null);            // 賦值前綴
});

Deno.test("leafCarrier: 直譯器 heredoc-stdin（B）", () => {
  assertEquals(lc(`node <<'EOF'\nconsole.log("x")\nEOF`), "interp");
  assertEquals(lc(`python <<'EOF'\nprint("x")\nEOF`), "interp");
  assertEquals(lc(`node`), null);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`leafCarrier` 未匯出）。

- [ ] **Step 3: 實作旗標解析 + `leafCarrier`（`print_only.ts` 新增；合併既有 import，勿重複宣告 `CommandInvocation`/`Word`/`staticValue`）**

在 `src/engine/print_only.ts` 頂部**合併**新 import（與 Task 2 已加的 import 合併；勿重複 `CommandInvocation`/`Word`/`staticValue`）：

```typescript
import { payloadIsAllStaticPrint, printExprIsStaticString, type Lang } from "./interp_payload.ts";
import { isHeredocPrintEligible } from "./static_output.ts";  // 已於 Task 2 import；勿重複
```

新增：

```typescript
const INTERP_LANG: Record<string, Lang> = {
  node: "js", nodejs: "js", deno: "js", bun: "js", "ts-node": "js",
  python: "py", python3: "py",
};
// per-language inline-eval / print 旗標
const JS_INLINE = new Set(["-e", "--eval"]);
const PY_INLINE = new Set(["-c"]);
const JS_PRINT = new Set(["-p", "--print"]);   // python/deno 無此語意
const INJECT_FLAGS = new Set([
  "-r", "--require", "--import", "-m", "--preload", "--env-file", "--loader", "--experimental-loader",
]);
const KNOWN_NULLARY = new Set(["--no-warnings", "--no-check", "-A", "--esm", "--transpile-only"]);
function isKnownNullaryPrefix(f: string): boolean {
  return f.startsWith("--experimental-") || f.startsWith("--allow-");
}
function flagName(tok: string): string {
  const eq = tok.indexOf("=");
  return eq > 0 && tok.startsWith("-") ? tok.slice(0, eq) : tok;
}
function flagValue(tok: string, next: Word | undefined): string | null {
  return tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : (next ? staticValue(next) : null);
}

type InterpForm =
  | { kind: "inline"; payload: string }
  | { kind: "print-expr"; expr: string }
  | { kind: "stdin" }
  | { kind: "script"; entrypoint: string }
  | { kind: "none" };

/** 解析直譯器葉形態。fail-safe：任何不確定 → { kind: "none" } 或 null（非直譯器/動態）。 */
export function recognizeInterpreter(inv: CommandInvocation): { lang: Lang; form: InterpForm } | null {
  if (inv.name === null) return null;
  let name = inv.name;
  let argv = inv.argv;
  // deno/bun 子指令
  if (name === "deno") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "eval") {
      const p = argv.length > 1 ? staticValue(argv[1]) : null;
      return p === null ? null : { lang: "js", form: { kind: "inline", payload: p } };
    }
    if (sub === "run") argv = argv.slice(1);
    else return null;
  } else if (name === "bun") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "run") argv = argv.slice(1);
    // 裸 bun（配 heredoc）由下方 stdin 判定
  }
  const lang = INTERP_LANG[name];
  if (lang === undefined) return null;
  const inlineFlags = lang === "py" ? PY_INLINE : JS_INLINE;
  const printFlags = lang === "js" && name !== "deno" ? JS_PRINT : new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null;
    if (!v.startsWith("-") || v === "-") {
      if (v === "-") return { lang, form: { kind: "none" } };  // bun/deno run - 不特案
      return { lang, form: { kind: "script", entrypoint: v } };
    }
    const fn = flagName(v);
    if (inlineFlags.has(fn)) {
      const val = flagValue(v, argv[i + 1]);
      return val === null ? null : { lang, form: { kind: "inline", payload: val } };
    }
    if (printFlags.has(fn)) {
      const val = flagValue(v, argv[i + 1]);
      return val === null ? null : { lang, form: { kind: "print-expr", expr: val } };
    }
    if (INJECT_FLAGS.has(fn)) return { lang, form: { kind: "none" } };
    if (v.includes("=")) { i++; continue; }
    if (KNOWN_NULLARY.has(fn) || isKnownNullaryPrefix(fn)) { i++; continue; }
    return { lang, form: { kind: "none" } };   // 分離未知裸旗標 → 保守放棄
  }
  return { lang, form: { kind: "stdin" } };    // 無位置參數、無 inline → 可能配 heredoc
}

/** 直譯器葉 fd0 靜態 heredoc/here-string body；否則 null。 */
function interpStdinBody(inv: CommandInvocation): string | null {
  const fd0 = inv.redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0.length === 0) return null;
  const eff = fd0[fd0.length - 1];
  if (eff.operator === "<<<") return eff.target ? staticValue(eff.target) : "";
  if (eff.operator !== "<<" && eff.operator !== "<<-") return null;
  if (!isHeredocPrintEligible(eff)) return null;
  return eff.content ?? "";
}

/** 葉載具：shell 靜態吐字 → "shell"；直譯器 inline/stdin → "interp"；否則 null。 */
export function leafCarrier(inv: CommandInvocation): "shell" | "interp" | null {
  if (isPrintOnlyForm(inv)) return "shell";
  if (inv.assignments.length > 0) return null;
  const r = recognizeInterpreter(inv);
  if (r === null) return null;
  if (r.form.kind === "inline") return payloadIsAllStaticPrint(r.form.payload, r.lang) ? "interp" : null;
  if (r.form.kind === "print-expr") return printExprIsStaticString(r.form.expr, r.lang) ? "interp" : null;
  if (r.form.kind === "stdin") {
    const body = interpStdinBody(inv);
    return body !== null && payloadIsAllStaticPrint(body, r.lang) ? "interp" : null;
  }
  return null;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(engine): interpreter flag parser + leaf carrier recognition (vectors A/B)"
```

---

## Task 6: `print_only.ts` — 複合載具 ＋ 聚合入口 `printDisguiseDeny`

**Files:**
- Modify: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

單一自足 AST 走訪（鏡射 walk.ts 結構）：分類每葉、偵測 WRITE→EXEC(a)(b)/pipe，兩階段判定回 `{ kind } | null`。**WRITE 葉透過 `prevWrite` 保留其 Leaf 參照，配對時回頭標記兩端為 write-exec**；kind 優先序 write-exec > cat-readback > pipe > interp-inline > shell-print。

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/print_only_test.ts` 末尾新增：

```typescript
import { printDisguiseDeny } from "./print_only.ts";

function pd(src: string): string | null {
  const hit = printDisguiseDeny(parseCommand(src).script, LC_CWD);
  return hit ? hit.kind : null;
}

Deno.test("printDisguiseDeny: 純 shell / 混載具 → deny", () => {
  assertEquals(pd("echo a; echo b"), "shell-print");
  assertEquals(pd(`echo a; node -e 'console.log("b")'`), "interp-inline");
  assertEquals(pd("for x in a b; do echo 假; done"), "shell-print");
});

Deno.test("printDisguiseDeny: 整鏈洗白 → 不 deny", () => {
  assertEquals(pd(`ls; node -e 'console.log("假")'`), null);
  assertEquals(pd("ls; echo 假"), null);
  assertEquals(pd("pwd; echo 假"), null);
  assertEquals(pd("true && echo 已驗證"), null);
  assertEquals(pd("mkdir build && echo done"), null);
  assertEquals(pd("echo 假; ls"), null);
  assertEquals(pd(`node -e 'console.log("x")'; ls`), null);
});

Deno.test("printDisguiseDeny: WRITE→EXEC(a)", () => {
  assertEquals(pd(`cat > /tmp/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode /tmp/x.mjs`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > f; node f`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > fixture.js; node runner.js fixture.js`), null);       // P=argv
  assertEquals(pd(`echo 'console.log("x")' > fixture.js; node --loader fixture.js runner.js`), null); // P=旗標值
  assertEquals(pd(`echo 'console.log("f")' > x.mjs; node --experimental-default-type=module x.mjs`), "write-exec");
});

Deno.test("printDisguiseDeny: WRITE→EXEC(b) cat 讀回", () => {
  assertEquals(pd(`cat > /tmp/q.txt <<'EOF'\ndead\nEOF\ncat /tmp/q.txt`), "cat-readback");
  assertEquals(pd(`printf 'x\\n' > q; tac q`), "cat-readback");
  assertEquals(pd(`cat > q <<'EOF'\nx\nEOF\necho hi; cat q`), null);   // 非緊鄰
  assertEquals(pd(`cat > a <<'EOF'\nx\nEOF\ncat b`), null);            // 非同檔
});

Deno.test("printDisguiseDeny: setup 豁免 / false / ! true", () => {
  assertEquals(pd(`mkdir -p /tmp && cat > x <<'EOF'\nconsole.log("f")\nEOF\n && node x`), "write-exec");
  assertEquals(pd(`cd /tmp; cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(pd("false && cat > x && node x"), null);
  assertEquals(pd(`! true && cat > x <<'EOF'\nconsole.log("f")\nEOF\n && node x`), null);
});

Deno.test("printDisguiseDeny: pipe（D）", () => {
  assertEquals(pd(`echo 'console.log(1)' | node`), "pipe");
  assertEquals(pd("grep x f | node"), null);
  assertEquals(pd("echo 'console.log(1)' | node < real.js"), null);   // fd0 蓋過
  assertEquals(pd("node"), null);
  assertEquals(pd("echo 'console.log(1)' | node &"), null);           // 背景 → 跳過 pipe
});
```

> 註：setup 案例的 `EOF\n && node x` 內含 heredoc 終止行後接 `&&`；若 unbash 對某寫法解析不如預期，改為單行 `&&` 連接（如 `mkdir -p /tmp && cat > x <<'EOF'…EOF && node x` 但 heredoc 需自成行）。以 `parseCommand(...).errors.length === 0` 為前提；解析失敗的 fixture 應改寫。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`printDisguiseDeny` 未匯出）。

- [ ] **Step 3: 實作（`print_only.ts` 新增；合併既有 import）**

在 `src/engine/print_only.ts` 頂部**合併** import（勿重複）：

```typescript
import type { AndOr, Command, CompoundList, Node, Pipeline, Script, Statement, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { applyCd, isCd } from "./cwd.ts";
import { normalizeAbsolute } from "./scope.ts";
import type { PrintDisguiseKind } from "../rules/types.ts";
import { catTacText, producerStdout, writtenContent } from "./static_output.ts";
```

新增：

```typescript
type Role = "leaf" | "write-exec" | "pipe" | "setup" | "none";
const SETUP_NAMES = new Set(["mkdir", "cd", "true", ":"]);

interface Leaf {
  inv: CommandInvocation;
  cmd: Command;          // 原 AST 節點（保留 name，供還原）
  role: Role;
  carrier: "shell" | "interp" | null;
}
interface WriteRef {
  leaf: Leaf;            // 指向 WRITE 葉的 Leaf 物件（配對時回頭改 role）
  path: string;
  content: string | null;
  cwd: CwdState;
}

/** 聚合入口：單一自足走訪、兩階段。回命中 kind 或 null。 */
export function printDisguiseDeny(script: Script, initialCwd: CwdState): { kind: PrintDisguiseKind } | null {
  const leaves: Leaf[] = [];
  let hasWriteExecComposite = false;

  const seq = (statements: Statement[], startCwd: CwdState): CwdState => {
    let cwd = startCwd;
    let prev: WriteRef | null = null;
    for (const stmt of statements) {
      if (stmt.background === true) prev = null;   // 背景不參與 adjacency
      const res = node(stmt.command, cwd, false, prev);
      cwd = res.cwd;
      prev = stmt.background === true ? null : res.prev;
    }
    return cwd;
  };

  // 回傳 { cwd, prev }：prev 為此節點後可傳遞給下一 sibling 的 WRITE。
  const node = (n: Node, cwd: CwdState, negated: boolean, prev: WriteRef | null): { cwd: CwdState; prev: WriteRef | null } => {
    switch (n.type) {
      case "Command": {
        const cmd = n as Command;
        const inv = toInv(cmd, cwd);
        const leaf = classify(inv, cmd, negated, prev);
        leaves.push(leaf);
        descendWordSubstitutions(cmd, cwd);          // $() 內層葉（任何位置載具）
        const nextPrev = detectWrite(inv, cmd, cwd, leaf);
        const nextCwd = isCd(cmd) ? applyCd(cmd, cwd) : cwd;
        return { cwd: nextCwd, prev: nextPrev };
      }
      case "AndOr": {
        const ao = n as AndOr;
        let cur = cwd;
        let p = prev;
        for (let k = 0; k < ao.commands.length; k++) {
          if (k > 0 && ao.operators[k - 1] === "||") p = null;   // || 重置 adjacency
          const r = node(ao.commands[k], cur, negated, p);
          cur = r.cwd;
          p = r.prev;
        }
        return { cwd: cur, prev: p };
      }
      case "Pipeline": {
        const pl = n as Pipeline;
        detectPipe(pl, cwd, pl.negated === true);
        return { cwd, prev: null };
      }
      case "Subshell":
        seq(n.body.commands, cwd);
        return { cwd, prev: null };
      case "BraceGroup":
        return { cwd: seq(n.body.commands, cwd), prev: null };
      case "CompoundList":
        return { cwd: seq((n as CompoundList).commands, cwd), prev: null };
      case "If":
        seq(n.clause.commands, cwd);
        seq(n.then.commands, cwd);
        if (n.else) n.else.type === "If" ? node(n.else, cwd, false, null) : seq(n.else.commands, cwd);
        return { cwd, prev: null };
      case "For":
      case "Select":
        seq(n.body.commands, cwd);
        return { cwd, prev: null };
      case "While":
        seq(n.clause.commands, cwd);
        seq(n.body.commands, cwd);
        return { cwd, prev: null };
      case "Case":
        for (const it of n.items) seq(it.body.commands, cwd);
        return { cwd, prev: null };
      case "Statement":
        if ((n as Statement).background === true) return { cwd, prev: null };
        return node((n as Statement).command, cwd, negated, prev);
      default:
        return { cwd, prev: null };
    }
  };

  // 單一否定 Pipeline（! cmd）：把否定傳給唯一成員；≥2 成員為 pipe。
  const detectPipe = (pl: Pipeline, cwd: CwdState, negated: boolean): void => {
    const members = pl.commands;
    if (members.length === 1) { node(members[0], cwd, negated, null); return; }
    if (members.length !== 2 || negated) {
      for (const m of members) node(m, cwd, false, null);
      return;
    }
    const prod = members[0].type === "Command" ? members[0] as Command : null;
    const cons = members[1].type === "Command" ? members[1] as Command : null;
    if (prod && cons) {
      const consInv = toInv(cons, cwd);
      const source = producerStdout(prod);
      const r = recognizeInterpreter(consInv);
      const clean = consInv.assignments.length === 0 && r !== null && r.form.kind === "stdin" && !hasFd0Override(consInv);
      if (source !== null && clean && payloadIsAllStaticPrint(source, r.lang)) {
        leaves.push({ inv: toInv(prod, cwd), cmd: prod, role: "pipe", carrier: null });
        leaves.push({ inv: consInv, cmd: cons, role: "pipe", carrier: null });
        return;
      }
    }
    for (const m of members) node(m, cwd, false, null);
  };

  seq(script.commands, initialCwd);

  // 階段 2
  if (leaves.length === 0) return null;
  let sawCarrier = false;
  for (const lf of leaves) {
    const covered = lf.role === "leaf" || lf.role === "write-exec" || lf.role === "pipe" ||
      (lf.role === "setup" && hasWriteExecComposite);
    if (!covered) return null;
    if (lf.carrier !== null || lf.role === "write-exec" || lf.role === "pipe") sawCarrier = true;
  }
  if (!sawCarrier) return null;
  return { kind: pickKind() };

  // ── 內部 helper ──
  function classify(inv: CommandInvocation, cmd: Command, negated: boolean, prev: WriteRef | null): Leaf {
    const exec = matchExec(inv, prev);
    if (exec !== null) {
      prev!.leaf.role = "write-exec";                 // 回頭把 WRITE 葉標為複合成員
      if (exec === "interp") hasWriteExecComposite = true;
      else hasWriteExecComposite ||= true;            // cat-readback 也算 WRITE→EXEC（吃 setup 豁免）
      return { inv, cmd, role: "write-exec", carrier: null };
    }
    const carrier = leafCarrier(inv);
    if (carrier) return { inv, cmd, role: "leaf", carrier };
    if (!negated && inv.name !== null && SETUP_NAMES.has(inv.name) && inv.assignments.length === 0) {
      return { inv, cmd, role: "setup", carrier: null };
    }
    return { inv, cmd, role: "none", carrier: null };
  }

  /** EXEC 配對：回 "interp"（a）/ "cat"（b）/ null。 */
  function matchExec(inv: CommandInvocation, prev: WriteRef | null): "interp" | "cat" | null {
    if (prev === null || prev.content === null || inv.assignments.length > 0) return null;
    const r = recognizeInterpreter(inv);
    if (r && r.form.kind === "script") {
      if (!sameFile(r.form.entrypoint, inv.cwd, prev.path, prev.cwd)) return null;
      return payloadIsAllStaticPrint(prev.content, r.lang) ? "interp" : null;
    }
    if (inv.name === "cat" || inv.name === "tac") {
      const op = soleReadOperand(inv);
      if (op !== null && sameFile(op, inv.cwd, prev.path, prev.cwd)) return "cat";
    }
    return null;
  }

  /** 偵測靜態 WRITE（cat/tac/echo/printf、唯一 fd1 截斷 `>`/`>|` 到靜態路徑、內容可還原）→ WriteRef，否則 null。 */
  function detectWrite(inv: CommandInvocation, cmd: Command, cwd: CwdState, leaf: Leaf): WriteRef | null {
    if (inv.name === null || inv.assignments.length > 0) return null;
    if (!["cat", "tac", "echo", "printf"].includes(inv.name)) return null;
    const p = soleTruncWrite(inv.redirects);
    if (p === null) return null;
    return { leaf, path: p, content: writtenContent(cmd), cwd };
  }

  function pickKind(): PrintDisguiseKind {
    if (leaves.some((l) => l.role === "write-exec" && weIsInterp(l))) return "write-exec";
    if (leaves.some((l) => l.role === "write-exec")) return "cat-readback";
    if (leaves.some((l) => l.role === "pipe")) return "pipe";
    if (leaves.some((l) => l.carrier === "interp")) return "interp-inline";
    return "shell-print";
  }
  function weIsInterp(l: Leaf): boolean {
    const r = recognizeInterpreter(l.inv);
    return r !== null && r.form.kind === "script";
  }
  function descendWordSubstitutions(cmd: Command, cwd: CwdState): void {
    const words: Word[] = [
      ...(cmd.name ? [cmd.name] : []),
      ...cmd.suffix,
      ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
      ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
      ...cmd.redirects.flatMap((r) => (r.body ? [r.body] : [])),
    ];
    for (const w of words) descendWord(w, cwd);
  }
  function descendWord(w: Word, cwd: CwdState): void {
    if (!w.parts) return;
    for (const part of w.parts) {
      if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
        seq(part.script.commands, cwd);   // 內層葉（非持久 cwd、prev 由 seq 重置）
      } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
        for (const child of part.parts) descendWordPart(child, cwd);
      }
    }
  }
  function descendWordPart(part: Word["parts"][number], cwd: CwdState): void {
    if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
      seq(part.script.commands, cwd);
    } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
      for (const child of part.parts) descendWordPart(child, cwd);
    }
  }
}

// ── module-level helpers（非閉包，供上方使用）──
function toInv(cmd: Command, cwd: CwdState): CommandInvocation {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: cmd.redirects,
    cwd,
  };
}
function soleTruncWrite(redirects: CommandInvocation["redirects"]): string | null {
  const fd1 = redirects.filter((r) =>
    (r.operator === ">" || r.operator === ">|" || r.operator === ">>" || r.operator === "&>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
  if (fd1.length !== 1) return null;
  const r = fd1[0];
  if (r.operator !== ">" && r.operator !== ">|") return null;   // append/其他 → 非 WRITE
  return r.target ? staticValue(r.target) : null;
}
function soleReadOperand(inv: CommandInvocation): string | null {
  const ops: string[] = [];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    if (v.startsWith("-") && v !== "--") continue;
    ops.push(v);
  }
  return ops.length === 1 ? ops[0] : null;
}
function hasFd0Override(inv: CommandInvocation): boolean {
  return inv.redirects.some((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
}
function sameFile(a: string, ca: CwdState, b: string, cb: CwdState): boolean {
  const ra = resolveForCompare(a, ca);
  const rb = resolveForCompare(b, cb);
  return ra !== null && ra === rb;
}
function resolveForCompare(p: string, cwd: CwdState): string | null {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return normalizeAbsolute(p);
  if (cwd.kind === "known") return normalizeAbsolute(cwd.path + "/" + p);
  return "REL:" + p;   // cwd unknown：相同相對字串同檔；絕對 vs 相對 → 不等
}
```

> 實作備註：
> - `catTacText` import 於本 Task 但主要供 producer/writtenContent 內部；若 lint 報 `catTacText` 未使用，改為只 import `producerStdout`/`writtenContent`（兩者內部已用 catTacText）。**最終 import 以 `deno lint` 綠燈為準**。
> - `descendWordPart` 的參數型別用 `Word["parts"][number]`（WordPart）；若型別推導不便，改 import `WordPart` from `../deps.ts`。
> - cat-readback（b）與直譯器（a）都設 `hasWriteExecComposite = true`（皆屬 WRITE→EXEC 複合、吃 setup 豁免）。

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS。逐案對照測試；**誤 deny（安全形式回非 null）必須修正**，漏 deny 盡量對齊但 fail-safe 可接受。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(engine): composite carriers + printDisguiseDeny two-phase aggregate (gate ③)"
```

---

## Task 7: `evaluate.ts` — 接線閘②/③、no-op 重排、移除舊 reason

**Files:**
- Modify: `src/engine/evaluate.ts`
- Modify: `src/rules/types.ts`（移除 `printOnlyDenyReason`/`functionShadowReason`）
- Modify: `src/rules/types_test.ts`（移除舊 reason 測試）
- Modify: `src/engine/evaluate_test.ts`

- [ ] **Step 1: 寫失敗/回歸測試（`evaluate_test.ts` 末尾；用未與既有衝突的名稱）**

在 `src/engine/evaluate_test.ts` 末尾新增（`evaluate` 已於檔頂 import；用區域名稱 `g2v`/`G2_ROOT`/`G2_CWD` 避免與既有頂層綁定衝突）：

```typescript
import { assertNotEquals } from "@std/assert";
const G2_ROOT = "/proj";
const G2_CWD = { kind: "known", path: "/proj" } as const;
function g2v(src: string) { return evaluate(src, G2_ROOT, G2_CWD).verdict; }

Deno.test("evaluate 閘②：名稱重定義 → deny", () => {
  assertEquals(g2v("f(){ :; }; echo 假"), "deny");
  assertEquals(g2v("f(){:;}"), "deny");
  assertEquals(g2v("alias grep=x; grep y"), "deny");
  assertEquals(g2v("builtin alias x=y"), "deny");
});

Deno.test("evaluate 閘③：print 偽裝 → deny", () => {
  assertEquals(g2v("echo a; echo b"), "deny");
  assertEquals(g2v(`node -e 'console.log("f")'`), "deny");
});

Deno.test("evaluate：整鏈洗白 → 非 deny", () => {
  assertNotEquals(g2v("ls; echo 假"), "deny");            // ls/echo 皆 allowlist → allow（非 deny）
  assertNotEquals(g2v(`ls; node -e 'console.log("假")'`), "deny");
});

Deno.test("evaluate：no-op 空指令 allow；寫含函式 script 非 deny", () => {
  assertEquals(g2v(""), "allow");
  assertNotEquals(g2v("cat > x.sh <<'EOF'\nf(){ :; }\nEOF"), "deny");  // 資料 → 落寫入重導向 ask
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL（`f(){:;}` 目前 allow/ask、`node -e` 目前非 deny）。

- [ ] **Step 3: 改寫 `evaluate.ts`**

Replace `src/engine/evaluate.ts` 內容為：

```typescript
import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { hasAliasRedefinition, hasExecutableFunctionDefinition, walk } from "./walk.ts";
import { printDisguiseDeny } from "./print_only.ts";
import { classify } from "./classify.ts";
import { combine } from "./combine.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { nameRedefinitionDenyReason, pollingDenyReason, printDisguiseDenyReason } from "../rules/types.ts";

/**
 * 主流程：parse → walk → 四閘 → 合併。任何例外 → ask（fail-safe）。
 * 閘序：① sleep → ② 名稱重定義 → no-op → ③ print 偽裝 → classify。
 */
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) return { verdict: "ask", reason: "指令語法無法可靠解析" };
    const invocations = walk(script, initialCwd, root);
    if (invocations.some((inv) => inv.name === "sleep")) {
      return { verdict: "deny", reason: pollingDenyReason() };
    }
    if (hasExecutableFunctionDefinition(script)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("function") };
    }
    if (hasAliasRedefinition(invocations)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("alias") };
    }
    if (invocations.length === 0) return { verdict: "allow", reason: "無可執行指令（no-op）" };
    const hit = printDisguiseDeny(script, initialCwd);
    if (hit) return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

- [ ] **Step 4: 移除 `rules/types.ts` 的 `printOnlyDenyReason`、`functionShadowReason`**

刪除這兩個函式（現已無使用者）。

- [ ] **Step 5: 更新 `rules/types_test.ts`**

在 `src/rules/types_test.ts`：移除 import 的 `functionShadowReason`、`printOnlyDenyReason` 及其對應 `Deno.test`（測 `printOnlyDenyReason`／`functionShadowReason` 的兩個測試整塊刪除）。新增（import `printDisguiseDenyReason`、`nameRedefinitionDenyReason`）：

```typescript
Deno.test("printDisguiseDenyReason 依 kind 客製、含替代", () => {
  assertStringIncludes(printDisguiseDenyReason("interp-inline"), "已禁止");
  assertStringIncludes(printDisguiseDenyReason("cat-readback"), "cat 讀回");
  assertStringIncludes(printDisguiseDenyReason("write-exec"), "已禁止");
});
Deno.test("nameRedefinitionDenyReason 含禁止 + 替代", () => {
  assertStringIncludes(nameRedefinitionDenyReason("function"), "shell 函式");
  assertStringIncludes(nameRedefinitionDenyReason("alias"), "alias");
});
```

（若 `assertStringIncludes` 未 import，於檔頂補 `import { assertStringIncludes } from "@std/assert";`。）

- [ ] **Step 6: 跑全套測試確認通過**

Run: `deno task test`
Expected: PASS（全部）。既有 print_only_test.ts 的 `isAllPrintOnly`/`isPrintOnlyForm` 測試維持綠燈（未動這兩函式）。

- [ ] **Step 7: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/evaluate.ts src/engine/evaluate_test.ts src/rules/types.ts src/rules/types_test.ts
git commit -m "feat(engine): wire gate ② (name redefinition) + gate ③ (printDisguiseDeny); drop old reasons"
```

---

## Task 8: `main_test.ts` + `deno.json` — e2e（不可升級 / no-side-effect / migration）

**Files:**
- Modify: `src/main_test.ts`
- Modify: `deno.json`（test task 加 `--allow-write`）

- [ ] **Step 1: `deno.json` test task 加 `--allow-write`**

把 `deno.json` 的 `tasks.test` 改為：
```json
"test": "deno test --allow-run --allow-env --allow-read --allow-write --allow-sys=uid",
```

- [ ] **Step 2: 新增 e2e（`main_test.ts` 末尾；含 settings fixture 助手）**

在 `src/main_test.ts` 末尾新增（沿用既有 `runHook`）。新增一個「在臨時專案寫 `.claude/settings.json`」的 helper 以測「不可升級」：

```typescript
/** 建臨時專案並寫 permissions.allow settings，回專案路徑。 */
async function projWithAllow(allow: string[]): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/.claude`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.claude/settings.json`, JSON.stringify({ permissions: { allow } }));
  return dir;
}

Deno.test("e2e: 閘②/③ 命中不可升級（settings 有 Bash(node *)/Bash(echo *)）", async () => {
  const proj = await projWithAllow(["Bash(node *)", "Bash(python *)", "Bash(echo *)", "Bash(cat *)"]);
  try {
    for (const command of [
      `node -e 'console.log("fake")'`,                                  // inline A
      `node <<'EOF'\nconsole.log("f")\nEOF`,                            // heredoc-stdin B
      `cat > ${proj}/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${proj}/x.mjs`, // write-exec
      `echo 'console.log(1)' | node`,                                   // pipe
      "echo a; echo b",                                                 // shell
      "f(){ :; }; echo done",                                           // 函式
      "alias grep=x; grep foo",                                        // alias
    ]) {
      const out = await runHook({ tool_name: "Bash", tool_input: { command }, cwd: proj }, proj);
      assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", command);
    }
    // 對照：真實運算 + Bash(node *) → allow（可升級）
    const ok = await runHook(
      { tool_name: "Bash", tool_input: { command: `node -e 'JSON.stringify(x)'` }, cwd: proj }, proj);
    assertEquals(JSON.parse(ok).hookSpecificOutput.permissionDecision, "allow");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test("e2e: 跨呼叫 migration 邊界", async () => {
  const bare = await Deno.makeTempDir();
  const withAllow = await projWithAllow(["Bash(node *)"]);
  try {
    // 呼叫1：寫檔（無 allow）→ ask
    const c1 = await runHook(
      { tool_name: "Bash", tool_input: { command: `cat > ${bare}/x.mjs <<'EOF'\nconsole.log("f")\nEOF` }, cwd: bare }, bare);
    assertEquals(JSON.parse(c1).hookSpecificOutput.permissionDecision, "ask");
    // 呼叫2：執行（無 allow）→ ask
    const c2 = await runHook(
      { tool_name: "Bash", tool_input: { command: `node ${bare}/x.mjs` }, cwd: bare }, bare);
    assertEquals(JSON.parse(c2).hookSpecificOutput.permissionDecision, "ask");
    // 呼叫2 + Bash(node *) → allow（使用者自負）
    const c3 = await runHook(
      { tool_name: "Bash", tool_input: { command: `node ${withAllow}/x.mjs` }, cwd: withAllow }, withAllow);
    assertEquals(JSON.parse(c3).hookSpecificOutput.permissionDecision, "allow");
    // 對照：同一 payload 單一呼叫 + Bash(node *) → 仍 deny
    const c4 = await runHook(
      { tool_name: "Bash", tool_input: { command: `cat > ${withAllow}/y.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${withAllow}/y.mjs` }, cwd: withAllow }, withAllow);
    assertEquals(JSON.parse(c4).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(withAllow, { recursive: true });
  }
});

Deno.test("e2e: pre-execution 無副作用（write-exec + cat-readback，內容/mtime 不變）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const [file, command] of [
      [`${dir}/x.mjs`, `cat > ${dir}/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${dir}/x.mjs`],
      [`${dir}/q.txt`, `cat > ${dir}/q.txt <<'EOF'\ndead\nEOF\ncat ${dir}/q.txt`],
    ] as const) {
      await Deno.writeTextFile(file, "ORIGINAL");
      const before = (await Deno.stat(file)).mtime?.getTime();
      const out = await runHook({ tool_name: "Bash", tool_input: { command }, cwd: dir }, dir);
      assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", command);
      assertEquals(await Deno.readTextFile(file), "ORIGINAL", command);      // 內容不變
      assertEquals((await Deno.stat(file)).mtime?.getTime(), before, command); // mtime 不變
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

> 註：`runHook` 目前僅設 `CLAUDE_PROJECT_DIR`。「不可升級」測試需 hook 讀到專案 `.claude/settings.json`——確認 `runHook` 的子行程以 `projectDir` 為 `CLAUDE_PROJECT_DIR` 且 `settings.ts` 會讀 `<root>/.claude/settings.json`（現有行為）。若 `runHook` 未把 cwd 設為 projectDir，settings 仍以 `CLAUDE_PROJECT_DIR` 為根讀取，符合。

- [ ] **Step 3: 跑 e2e 確認通過**

Run: `deno task test`（已含 `--allow-write`）
Expected: PASS。

- [ ] **Step 4: commit**

```bash
git add src/main_test.ts deno.json
git commit -m "test(e2e): unupgradeable deny (settings fixture) + migration + no-side-effect"
```

---

## Task 9: CLAUDE.md 同步 ＋ build ＋ operational verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md**

先讀 `CLAUDE.md` 定位以下既有段落再就地改：
- 「## 這是什麼」段：deny 三類 → 四類，加「④ 名稱重定義（函式定義＋alias 類）」；「整鏈 print-only 偽裝」定義擴充為跨載具。
- 「## 架構（評估管線）」段的管線圖：改為 `parse → walk → 閘① sleep → 閘② 名稱重定義 → no-op → 閘③ printDisguiseDeny → classify → combine`；`engine/` 檔案清單補 `static_output.ts`、`interp_payload.ts`，並更新 `print_only.ts` 職責描述（載具框架＋`printDisguiseDeny`）、`walk.ts` 補兩 helper。
- 「## 核心不變量」段：deny 由三類改四類；閘②③ classify 前返回、不可由 `permissions.allow` 升級。
- 「### hook 決策 vs settings.json 權限的優先序」與「已接受繞道」段：node/python 裸 all-static-print 改硬 deny；兩步偽裝（cat 讀回）改硬 deny（唯一 accepted over-deny）；混載具全 print 改 deny；`ls; echo 假`/`ls; node -e print` 洗白維持不 deny；函式定義＋alias → deny（取代函式遮蔽 ask）；其他 mutator（`hash`/`enable`/`PATH`/`source`）out-of-scope。

（就地融入既有章節，不新增重複章節。）

- [ ] **Step 2: check + lint + 全套測試**

```bash
deno task check && deno task lint && deno task test
```
Expected: 全綠。

- [ ] **Step 3: build**

```bash
deno task build
```
Expected: 產出 `dist/permission-checker`，無錯。

- [ ] **Step 4: operational verification（餵 JSON 給 binary）**

```bash
PROJ=$(mktemp -d)
# 逐項餵入並確認 hookSpecificOutput.permissionDecision：
run() { CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker; }

# 1) write-exec → deny
printf '{"tool_name":"Bash","tool_input":{"command":"cat > %s/v.mjs <<'\''EOF'\''\nconsole.log(\"f\")\nEOF\nnode %s/v.mjs"},"cwd":"%s"}' "$PROJ" "$PROJ" "$PROJ" | run
# 2) cat-readback → deny
printf '{"tool_name":"Bash","tool_input":{"command":"cat > %s/q.txt <<'\''EOF'\''\ndead\nEOF\ncat %s/q.txt"},"cwd":"%s"}' "$PROJ" "$PROJ" "$PROJ" | run
# 3) 函式 → deny
printf '{"tool_name":"Bash","tool_input":{"command":"f(){ :; }; echo done"},"cwd":"%s"}' "$PROJ" | run
# 4) alias → deny
printf '{"tool_name":"Bash","tool_input":{"command":"alias grep=x; grep foo"},"cwd":"%s"}' "$PROJ" | run
# 5) 真實運算 → 非 deny（ask）
printf '{"tool_name":"Bash","tool_input":{"command":"node -e '\''console.log(1+1)'\''"},"cwd":"%s"}' "$PROJ" | run
# 6) 洗白 → 非 deny
printf '{"tool_name":"Bash","tool_input":{"command":"ls; echo done"},"cwd":"%s"}' "$PROJ" | run
# 7) 寫含函式 shell script → 非 deny（寫入重導向 ask）
printf '{"tool_name":"Bash","tool_input":{"command":"cat > %s/d.sh <<'\''EOF'\''\ndeploy(){ echo hi; }\nEOF"},"cwd":"%s"}' "$PROJ" "$PROJ" | run

# 8) pre-execution 無副作用（binary 級）：預建檔、餵 write-exec、確認不變
echo ORIGINAL > "$PROJ/x.mjs"
printf '{"tool_name":"Bash","tool_input":{"command":"cat > %s/x.mjs <<'\''EOF'\''\nconsole.log(\"f\")\nEOF\nnode %s/x.mjs"},"cwd":"%s"}' "$PROJ" "$PROJ" "$PROJ" | run
test "$(cat "$PROJ/x.mjs")" = "ORIGINAL" && echo "NO-SIDE-EFFECT OK" || echo "FAIL: file changed"
rm -rf "$PROJ"
```
期望：1–4、8 為 `deny`；5–7 為非 deny；第 8 步印 `NO-SIDE-EFFECT OK`。任何不符即 regression，回對應 Task 修正後重跑。

- [ ] **Step 5: commit**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md - deny four categories, gate ②/③ pipeline, accepted bypasses"
```

---

## 完成準則

- `deno task check && deno task lint && deno task test` 全綠。
- `deno task build` 成功、operational verification 八項期望全符（含 no-side-effect）。
- spec §7 行為對照（allow/ask/deny 三面 + 邊界）於單元/整合/e2e 皆有斷言。
- deny 四類、閘②③ 不可由 `permissions.allow` 升級。
