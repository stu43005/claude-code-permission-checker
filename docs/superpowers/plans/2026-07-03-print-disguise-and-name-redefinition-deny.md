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
- `bun run <file>` / `deno run <file>`：`suffix = [run, <file>]`（子指令 `run` 後接進入點）；`deno eval <payload>` 為 inline；**`deno run -` 的 `-` 為 stdin 標記**（配 heredoc/here-string → heredoc-stdin 載具）；**`bun run -` 不特案**（保守 under-deny）。

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
  f('console.log(r"x")');                    // js 無 r 前綴 → r 為識別字 → 非法
  f('console.log("a")console.log("b")');     // 兩敘述無分隔符 → 非法
  f('console.log(0x)');                       // 基底前綴無數字 → 非法
  f('console.log(0b2)');                       // 二進位含 2 → 非法
  f('console.log(0o9)');                       // 八進位含 9 → 非法
});

Deno.test("payloadIsAllStaticPrint: py 邊界（前綴需緊鄰、單行、無 js 專屬形式）", () => {
  assertEquals(payloadIsAllStaticPrint('print(1n)', "py"), false);     // BigInt 僅 js
  assertEquals(payloadIsAllStaticPrint('print(r "x")', "py"), false);  // 前綴與引號間有空白 → 非法
  assertEquals(payloadIsAllStaticPrint('print("a\nb")', "py"), false); // 非三引號字串跨行 → 非法
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
  assertEquals(payloadIsAllStaticPrint("print(`x`)", "py"), false);   // py 無反引號字串
  assertEquals(payloadIsAllStaticPrint('print(r"x")', "py"), true);   // py r 前綴 → 靜態字串
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

type TokKind = "STRING" | "NUMBER" | "NAME" | "PUNCT" | "SIGN" | "SEP" | "DYNAMIC" | "OTHER";
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

// UTF-8 位元組長度（DoS 上限用；有界，超標即回值 > 上限）。
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function tokenize(src: string, lang: Lang): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (t: Tok) => { out.push(t); };
  while (i < n) {
    if (out.length > MAX_TOKENS) return null;
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") {                                    // 換行 = 敘述分隔符（去重）
      if (out.length > 0 && out[out.length - 1].kind !== "SEP") push({ kind: "SEP", value: "\n" });
      i++;
      continue;
    }
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
    if (c === '"' || c === "'" || (c === "`" && lang === "js")) {   // 反引號模板僅 js
      const r = readString(src, i, lang);
      if (r === null) return null;
      push({ kind: r.dynamic ? "DYNAMIC" : "STRING", value: "" });
      i = r.next;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i;
      if (src[j] === "0" && /[xXoObB]/.test(src[j + 1] ?? "")) {
        const base = src[j + 1].toLowerCase();
        const cls = base === "x" ? /[0-9a-fA-F_]/ : base === "o" ? /[0-7_]/ : /[01_]/;  // 依基底限定數字
        j += 2;
        const s = j;
        while (j < n && cls.test(src[j])) j++;
        if (j === s) return null;                          // 基底前綴後無合法數字（0x_/0b2/0o9）→ 非法
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;         // 整數部
        if (src[j] === ".") { j++; while (j < n && /[0-9_]/.test(src[j])) j++; } // 小數
        if (src[j] === "e" || src[j] === "E") {             // 指數（可帶號）
          let k = j + 1;
          if (src[k] === "+" || src[k] === "-") k++;
          if (DIGIT.test(src[k] ?? "")) { j = k; while (j < n && /[0-9_]/.test(src[j])) j++; }
        }
      }
      if (lang === "js" && src[j] === "n") j++;             // BigInt 僅 js
      push({ kind: "NUMBER", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && (NAME_CONT.test(src[j]) || (src[j] === "." && NAME_CONT.test(src[j + 1] ?? "")))) j++;
      const nameVal = src.slice(i, j);
      // py 字串前綴：**必須緊鄰引號、無空白**（`f"…"` / `r'…'`）。f → DYNAMIC；r/b → STRING。
      if (lang === "py" && /^(f|F|r|b|rb|br|R|B)$/.test(nameVal) && (src[j] === '"' || src[j] === "'")) {
        const rr = readString(src, j, lang);
        if (rr === null) return null;
        push({ kind: /^[fF]$/.test(nameVal) ? "DYNAMIC" : "STRING", value: "" });
        i = rr.next;
        continue;
      }
      push({ kind: "NAME", value: nameVal });
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
    if (src[i] === "\n") return null;   // 一般（非三引號）字串不可跨行（js/py 皆然）
    i++;
  }
  return null;
}

// 消費一個 ARG：STRING，或（僅文字輸出 API）選擇性 SIGN + NUMBER。回下一個索引或 -1（不合法）。
// SIGN 只對 NUMBER 合法（不允許 -"x" 這種帶號字串）。
function consumeArg(toks: Tok[], i: number, textApi: boolean): number {
  if (toks[i]?.kind === "SIGN") {
    if (textApi && toks[i + 1]?.kind === "NUMBER") return i + 2;
    return -1;
  }
  const k = toks[i]?.kind;
  if (k === "STRING") return i + 1;
  if (k === "NUMBER" && textApi) return i + 1;
  return -1;
}

export function payloadIsAllStaticPrint(source: string, lang: Lang): boolean {
  if (byteLen(source) > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = raw;   // 前綴/模板動態性已於 tokenize 處理
  const textFns = TEXT_PRINT_FNS[lang];
  const writeFns = WRITE_PRINT_FNS[lang];

  let i = 0;
  let stmts = 0;
  const n = toks.length;
  while (toks[i]?.kind === "SEP") i++;               // 跳過前導分隔
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
    stmts++;
    // 敘述間必須有分隔符（`;` 或換行 SEP）；消費之
    let sep = false;
    while (toks[i]?.value === ";" || toks[i]?.kind === "SEP") { sep = true; i++; }
    if (i < n && !sep) return false;                 // 兩敘述緊貼、無分隔 → 非法
  }
  return stmts >= 1;
}

export function printExprIsStaticString(source: string, lang: Lang): boolean {
  if (byteLen(source) > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = raw;   // 前綴/模板動態性已於 tokenize 處理
  if (toks.length === 0) return false;
  let i = 0;
  if (toks[i]?.kind !== "STRING") return false;
  i++;
  while (i < toks.length) {
    if (toks[i]?.kind !== "SIGN" || toks[i]?.value !== "+") return false;  // `+` 詞法為 SIGN
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

把 `print_only.ts` 現有的低層判定移入 `static_output.ts` 並 `export`，再新增還原函式。**還原函式吃原 `Command` 節點**（保留 `name`）。分兩種語意：`producerStdout`（純 stdout，stdout 被任何重導向轉走 → null，供 pipe producer）與 `writtenContent`（寫檔內容，忽略 fd1 寫入重導向，供 WRITE 葉）。

> **API 命名（相對 spec §4.2 的刻意調整）**：spec §4.2 概念上命名 `echoOutput`/`printfOutput`/`commandOutput`。本實作改為 `echoText`/`printfText`/`catTacText`（**redirect-agnostic 的底層還原**，吃 `Command`）＋兩個對外語意包裝 `producerStdout`（stdout 語意）/`writtenContent`（寫檔語意）。此拆分是為滿足「pipe producer 要純 stdout、WRITE 葉要寫檔內容」兩種不同 redirect 語意（見 round-1/2 review）——語意等價、只是把單一函式拆成「底層還原＋語意包裝」。

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

Deno.test("echoText: 靜態 → 字串；動態/carve-out/~展開 → null", () => {
  assertEquals(echoText(cmd("echo hello world")), "hello world\n");
  assertEquals(echoText(cmd("echo -n hi")), "hi");
  assertEquals(echoText(cmd('echo "$VAR"')), null);
  assertEquals(echoText(cmd('echo -e "a\\tb"')), null);   // -e + 反斜線 → 探測 carve-out
  assertEquals(echoText(cmd("echo ~")), null);            // ~ 家目錄展開 → 非靜態
  assertEquals(printfText(cmd("printf '%s\\n' ~")), null);
  assertEquals(catTacText(cmd("cat <<<~")), null);        // here-string ~ 展開 → 非靜態
});

Deno.test("printfText: 裸 %s/%b → 還原；數值/帶寬度轉換 → null", () => {
  assertEquals(printfText(cmd("printf '%s\\n' hi")), "hi\n");
  assertEquals(printfText(cmd("printf '%s%s' a b")), "ab");     // 循環套用
  assertEquals(printfText(cmd("printf '%d' 5")), null);         // 數值
  assertEquals(printfText(cmd("printf '%10s\\n' hi")), null);   // 帶寬度 → 無法精確還原
});

Deno.test("catTacText: cat 原序、tac 行反轉；here-string 補換行、<<- 去 tab", () => {
  assertEquals(catTacText(cmd("cat <<'EOF'\nA\nB\nEOF")), "A\nB\n");
  assertEquals(catTacText(cmd("tac <<'EOF'\nA\nB\nEOF")), "B\nA\n");
  assertEquals(catTacText(cmd("cat <<<hi")), "hi\n");           // here-string 補換行
  assertEquals(catTacText(cmd("cat file.txt")), null);
});

Deno.test("producerStdout: stdout 被轉走 → null；純 stdout → 字串", () => {
  assertEquals(producerStdout(cmd("echo hi")), "hi\n");
  assertEquals(producerStdout(cmd("echo hi > f")), null);          // 寫檔
  assertEquals(producerStdout(cmd("echo hi >/dev/null")), null);   // null 裝置：stdout 不進 pipe
  assertEquals(producerStdout(cmd("echo hi >&2")), null);          // 轉 stderr
});

Deno.test("catTacText / writtenContent: 含 $() 的 heredoc body → null（無法具體還原）", () => {
  assertEquals(catTacText(cmd("cat <<EOF\n$(ls)\nEOF")), null);
  assertEquals(writtenContent(cmd("cat > f <<EOF\n$(ls)\nEOF")), null);
  assertEquals(writtenContent(cmd("cat > f <<'EOF'\n$(ls)\nEOF")), "$(ls)\n");  // 引號 → 字面
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

- [ ] **Step 3: 建立 `static_output.ts` 的低層判定（自 `print_only.ts` 移入，加 `export`）**

`src/engine/static_output.ts` 開頭寫入以下 import 與判定函式（這些是**現有** `print_only.ts` 的內容，逐字搬入；`wordPrintEligible`/`isEchoPrintOnly`/`isPrintfPrintOnly`/`isCatPassthrough`/`isHeredocPrintEligible`/`hasFileOperand`/`hasFormatterConversion` 加 `export`）：

```typescript
import type { CommandInvocation } from "../types.ts";
import type { Command, Redirect, Word, WordPart } from "../deps.ts";
import { isStatic, nestedPartIsDynamic, staticValue, topPartIsDynamic } from "./word.ts";

function hasLeadingTilde(w: Word): boolean {
  if (!w.parts) return w.value.startsWith("~");
  const first = w.parts[0];
  return first?.type === "Literal" && first.value.startsWith("~");
}

export function wordPrintEligible(w: Word): boolean {
  if (hasLeadingTilde(w)) return false;
  if (isStatic(w)) return true;
  if (!w.parts) return false;
  return w.parts.every(topPartEligible);
}

function topPartEligible(p: WordPart): boolean {
  if (p.type === "CommandExpansion") return true;
  if (!topPartIsDynamic(p)) return true;
  if (p.type === "DoubleQuoted" || p.type === "LocaleString") {
    return p.parts.every((np) => np.type === "CommandExpansion" || !nestedPartIsDynamic(np));
  }
  return false;
}

export function isEchoPrintOnly(inv: CommandInvocation): boolean {
  let hasEscapeFlag = false;
  let hasBackslashPayload = false;
  for (const w of inv.argv) {
    if (!wordPrintEligible(w)) return false;
    const v = staticValue(w);
    if (v === null) continue;
    if (/^-[neE]*[eE][neE]*$/.test(v)) { hasEscapeFlag = true; continue; }
    if (v.includes("\\")) hasBackslashPayload = true;
  }
  if (hasEscapeFlag && hasBackslashPayload) return false;
  return true;
}

export function isPrintfPrintOnly(inv: CommandInvocation): boolean {
  const first = inv.argv.length > 0 ? staticValue(inv.argv[0]) : null;
  if (first !== null && first !== "--" && first.startsWith("-")) return false;
  if (inv.argv.length > 0 && first === null) return false;
  for (const w of inv.argv) if (!wordPrintEligible(w)) return false;
  const fmtWord = inv.argv.find((w) => staticValue(w) !== "--");
  if (!fmtWord) return true;
  const fmt = staticValue(fmtWord);
  if (fmt !== null && hasFormatterConversion(fmt)) return false;
  return true;
}

export function hasFormatterConversion(fmt: string): boolean {
  const stripped = fmt.replace(/%%/g, "");
  return /%[-+ 0#']*[0-9*]*(\.[0-9*]*)?(hh|h|ll|l|L|j|z|t)?[diouxXeEfFgGaAcCqn]/.test(stripped) ||
    /%\([^)]*\)T/.test(stripped);
}

export function isCatPassthrough(inv: CommandInvocation): boolean {
  if (hasFileOperand(inv.name, inv.argv)) return false;
  const fd0Inputs = inv.redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0Inputs.length === 0) return false;
  const effective = fd0Inputs[fd0Inputs.length - 1];
  if (effective.operator !== "<<" && effective.operator !== "<<-" && effective.operator !== "<<<") {
    return false;
  }
  return isHeredocPrintEligible(effective);
}

export function hasFileOperand(name: string | null, argv: Word[]): boolean {
  const skipsValue = name === "tac";
  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i++) {
    const v = staticValue(argv[i]);
    if (!afterDoubleDash && v === "--") { afterDoubleDash = true; continue; }
    if (afterDoubleDash) return true;
    if (v === null || !v.startsWith("-")) return true;
    if (skipsValue && (v === "-s" || v === "--separator")) {
      if (argv[i + 1] !== undefined && staticValue(argv[i + 1]) !== null) i++;
    }
  }
  return false;
}

function heredocBodyEligible(body: Word): boolean {
  if (!body.parts) return true;
  return body.parts.every((p) => p.type === "Literal" || p.type === "CommandExpansion");
}

export function isHeredocPrintEligible(r: Redirect): boolean {
  if (r.operator === "<<<") {
    return r.target ? wordPrintEligible(r.target) : true;
  }
  if (r.heredocQuoted === true) return true;
  if (r.body) return heredocBodyEligible(r.body);
  return !/[$`]/.test(r.content ?? "");
}
```

> `isEchoPrintOnly`/`isPrintfPrintOnly`/`isCatPassthrough` 加 `export`（供 print_only 的 `isPrintOnlyForm` 使用）；`hasFileOperand`/`isHeredocPrintEligible` 加 `export`（供 Task 5/6 使用）；`hasFormatterConversion`/`wordPrintEligible` 加 `export`。`hasLeadingTilde`/`topPartEligible`/`heredocBodyEligible` 保持 module-private。

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
    if (!wordPrintEligible(w)) return null;   // 排除 ~ 展開 / glob / 變數等（非靜態吐字）
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
  if (c.argv.some((w) => !wordPrintEligible(w))) return null;   // 排除 ~ / glob / 變數
  const vals = c.argv.map((w) => staticValue(w));
  if (vals.some((v) => v === null)) return null;
  const args = vals as string[];
  let idx = 0;
  if (args[0] === "--") idx = 1;
  const fmt = args[idx];
  if (fmt === undefined) return "";
  if (fmt.startsWith("-") && fmt !== "--") return null;
  if (hasFormatterConversion(fmt)) return null;        // 數值/日期/%q/%n 等 → null
  // 只能具體還原「裸」%s/%b/%%；帶旗標/寬度/精度（如 %10s、%-5b）無法精確重建 → null（保守）。
  if (/%[^sb%]/.test(fmt.replace(/%%/g, ""))) return null;
  const operands = args.slice(idx + 1);
  // printf 會循環套用 format 直到 operands 用盡（POSIX）；至少套一次。
  const applyOnce = (start: number): { text: string; used: number } => {
    let out = "";
    let used = 0;
    for (let k = 0; k < fmt.length; k++) {
      if (fmt[k] === "%" && fmt[k + 1] === "%") { out += "%"; k++; continue; }
      if (fmt[k] === "%" && fmt[k + 1] === "s") { out += operands[start + used] ?? ""; used++; k++; continue; }
      if (fmt[k] === "%" && fmt[k + 1] === "b") { out += interpBackslash(operands[start + used] ?? ""); used++; k++; continue; }
      if (fmt[k] === "\\" && fmt[k + 1] === "n") { out += "\n"; k++; continue; }
      if (fmt[k] === "\\" && fmt[k + 1] === "t") { out += "\t"; k++; continue; }
      out += fmt[k];
    }
    return { text: out, used };
  };
  let result = "";
  let pos = 0;
  do {
    const r = applyOnce(pos);
    result += r.text;
    if (r.used === 0) break;                            // 無轉換符 → 不循環
    pos += r.used;
  } while (pos < operands.length);
  return result;
}

function interpBackslash(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
}

/** cat/tac 的 stdin passthrough 文字（cat 原序、tac 行反轉）；有檔案操作元/非合格 heredoc → null。 */
export function catTacText(cmd: Command): string | null {
  const c = inv(cmd);
  if (c.name !== "cat" && c.name !== "tac") return null;
  if (hasFileOperand(c.name, c.argv)) return null;
  const body = heredocStdinText(c.redirects);
  if (body === null) return null;
  if (c.name === "tac") {
    const trailing = body.endsWith("\n");
    const lines = (trailing ? body.slice(0, -1) : body).split("\n");
    lines.reverse();
    return lines.join("\n") + (trailing ? "\n" : "");
  }
  return body;
}

/** fd0 最後者勝的有效 heredoc/here-string 靜態文字（含 `<<<` 補換行、`<<-` 去 tab、拒結構化 body）；否則 null。
 *  供 cat/tac passthrough 與直譯器 heredoc-stdin 共用，確保兩處還原規則一致。 */
export function heredocStdinText(redirects: Redirect[]): string | null {
  const fd0 = redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0.length === 0) return null;
  const eff = fd0[fd0.length - 1];
  if (!isHeredocPrintEligible(eff)) return null;    // 沿用既有合格判定（擋 ~/glob/變數/含 $ 的 content）
  // here-string（`<<<`）：bash 於內容後補一個換行。
  if (eff.operator === "<<<") {
    const s = eff.target ? staticValue(eff.target) : "";
    return s === null ? null : s + "\n";
  }
  if (eff.operator !== "<<" && eff.operator !== "<<-") return null;
  // print-eligible 但 body 為結構化 Word（含 $() 展開）→ 無法靜態知實際輸出 → null。
  if (eff.body) return null;
  const body = eff.content ?? "";
  return eff.operator === "<<-" ? body.replace(/^\t+/gm, "") : body;   // `<<-` 去每行前導 tab
}

/** fd1（stdout）是否被任何重導向轉走（含 >/dev/null、>&2）——這類 stdout 不進 pipe。 */
function stdoutDiverted(cmd: Command): boolean {
  return cmd.redirects.some((r) =>
    (r.operator === ">" || r.operator === ">>" || r.operator === ">|" || r.operator === "&>" ||
      r.operator === "&>>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
}

/** 純 stdout（供 pipe producer）：stdout 被轉走 / 有賦值前綴 → null；否則依名還原。 */
export function producerStdout(cmd: Command): string | null {
  if (stdoutDiverted(cmd) || cmd.prefix.length > 0) return null;
  return echoText(cmd) ?? printfText(cmd) ?? catTacText(cmd);
}

/** 寫檔內容（供 WRITE 葉；忽略寫入重導向，因重導向正是寫入目標）。 */
export function writtenContent(cmd: Command): string | null {
  return echoText(cmd) ?? printfText(cmd) ?? catTacText(cmd);
}
```

- [ ] **Step 5: 改 `print_only.ts` import 移出的判定**

在 `src/engine/print_only.ts` **刪除**已移入 static_output 的十個函式定義（`hasLeadingTilde`/`wordPrintEligible`/`topPartEligible`/`heredocBodyEligible`/`isHeredocPrintEligible`/`isEchoPrintOnly`/`isPrintfPrintOnly`/`hasFormatterConversion`/`isCatPassthrough`/`hasFileOperand`）。頂部改為**只 import 本檔此刻用得到的**（`isPrintOnlyForm` 需 echo/printf/cat 三判定 + 既有 `hasWriteRedirect`；`wordPrintEligible` re-export 給既有測試）：

```typescript
import type { CommandInvocation } from "../types.ts";   // isAllPrintOnly / isPrintOnlyForm 仍需
import { hasWriteRedirect } from "./redirect.ts";       // isPrintOnlyForm 需（原本應已 import）
import { isCatPassthrough, isEchoPrintOnly, isPrintfPrintOnly } from "./static_output.ts";
export { wordPrintEligible } from "./static_output.ts";   // 既有 print_only_test.ts 由 print_only 匯入
```

**保留** print_only.ts 原有仍被使用的型別 import（尤其 `CommandInvocation`）。`isPrintOnlyForm` 與 `isAllPrintOnly` **保留在 print_only.ts**、改用 import 的三判定。**不在 Task 2 import `hasFileOperand`/`isHeredocPrintEligible`**（Task 5/6 需要時才 import，避免此刻 lint 報未使用）。確認無重複定義（否則 `deno check` 重複宣告錯誤）。

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
  assertEquals(hasAliasRedefinition(nrInvs("command shopt -s expand_aliases")), true);
  assertEquals(hasAliasRedefinition(nrInvs("builtin shopt -s expand_aliases")), true);
  assertEquals(hasAliasRedefinition(nrInvs("command -- alias x=y")), true);          // 選項終止符
  assertEquals(hasAliasRedefinition(nrInvs("command -p -- alias x=y")), true);
  assertEquals(hasAliasRedefinition(nrInvs("command -- shopt -s expand_aliases")), true);
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
      return (node.name ? wordHasFn(node.name) : false) ||
        node.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) ||
        nodeHasFn(node.body);
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
    if (v === "--") {                                    // 選項終止符：其後第一個 token 即有效名（不論是否 -）
      const rest = argv.slice(i + 1);
      const nm = rest.length > 0 ? staticValue(rest[0]) : null;
      return nm === null ? null : unwrapDispatcher(nm, rest.slice(1));
    }
    if (v.startsWith("-")) { i++; continue; }
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
>
> **動態函式名 fail-closed（回應 coverage）**：`hasExecutableFunctionDefinition` 遇 `case "Function"` **一律回 true、完全不看 `node.name`**，故即使某 `Function` 節點的名字動態/無法靜態還原也照樣 deny（不像 name-based 的 `definedFunctionNames` 會漏收）。實務上 bash 函式名恆為字面（無 `$x(){…}` 語法），unbash 不會產生動態名 `Function` 節點，故此為「不依賴名稱可還原性」的 fail-closed 保證、無需（也無法用 bash 語法構造）額外測試。

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
    "interp-inline": "你正用直譯器（-e/-c/-p inline 或 heredoc 餵 stdin）跑一段每行都只是 console.log/print 印死字串的程式",
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
  assertEquals(lc(`deno run - <<'EOF'\nconsole.log("x")\nEOF`), "interp");   // deno run - 為 stdin
  assertEquals(lc(`bun <<'EOF'\nconsole.log("x")\nEOF`), "interp");          // 裸 bun heredoc
  assertEquals(lc(`bun -e 'console.log("x")'`), "interp");
  assertEquals(lc(`ts-node -e 'console.log("x")'`), "interp");
  assertEquals(lc(`node`), null);
  assertEquals(lc(`node < real.js`), null);                                 // fd0 為檔案 → 非靜態 heredoc
  assertEquals(lc(`python < f.py`), null);
  assertEquals(lc(`node <<EOF\n$(ls)\nEOF`), null);                          // 未引號 $() body → 不可具體還原 → 非載具
  assertEquals(lc(`bun run - <<'EOF'\nconsole.log("x")\nEOF`), null);        // bun run - 不特案
});

Deno.test("leafCarrier: 非 deno 的 --allow-* 為未知旗標 → 放棄；deno --allow-* 為 nullary", () => {
  assertEquals(lc(`node --allow-read -e 'console.log("x")'`), null);         // node 無 --allow-read → 放棄
  assertEquals(lc(`deno run --allow-read - <<'EOF'\nconsole.log("x")\nEOF`), "interp"); // deno --allow-read nullary
});

Deno.test("leafCarrier: run 子指令不吃 inline；未知/注入旗標放棄", () => {
  assertEquals(lc(`deno run -e 'console.log("x")'`), null);   // run 模式：-e 非 inline（-e 被當 script 前的未知旗標）
  assertEquals(lc(`bun run -e 'console.log("x")'`), null);
  assertEquals(lc(`bun run -p '"x"'`), null);
  assertEquals(lc(`node --unknown-flag val -e 'console.log("x")'`), null);   // 未知分離旗標 → 放棄
  assertEquals(lc(`node --import=./m.mjs -e 'console.log("x")'`), null);     // =value 注入
  assertEquals(lc(`node --experimental-loader=./l.mjs -e 'console.log("x")'`), null);
  assertEquals(lc(`node --env-file=.env -e 'console.log("x")'`), null);
  assertEquals(lc(`python -m pytest -c 'print("x")'`), null);               // -m 注入
});

Deno.test("leafCarrier: 已知 nullary 為 per-interpreter（別家的旗標 → 放棄）", () => {
  assertEquals(lc(`node --esm -e 'console.log("x")'`), null);        // --esm 非 node nullary → 放棄
  assertEquals(lc(`python --no-warnings -c 'print("x")'`), null);    // --no-warnings 非 python nullary → 放棄
  assertEquals(lc(`ts-node --esm -e 'console.log("x")'`), "interp"); // --esm 是 ts-node nullary → 仍偵測
  assertEquals(lc(`node --no-warnings -e 'console.log("x")'`), "interp"); // node 自家 nullary
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`leafCarrier` 未匯出）。

- [ ] **Step 3: 實作旗標解析 + `leafCarrier`（`print_only.ts` 新增；合併既有 import，勿重複宣告 `CommandInvocation`/`Word`/`staticValue`）**

在 `src/engine/print_only.ts` 頂部**補上**以下 import（Task 2 移出低層判定後，print_only 已不再 import `staticValue` 等；此處明確補回本 Task/Task 6 需要的）。與既有 import 合併、同一模組的 import 合成一行、勿重複：

```typescript
import type { CommandInvocation } from "../types.ts";
import type { Word } from "../deps.ts";
import { staticValue } from "./word.ts";
import { payloadIsAllStaticPrint, printExprIsStaticString, type Lang } from "./interp_payload.ts";
import { heredocStdinText } from "./static_output.ts";
```

> 把此處 `./static_output.ts` 的 `heredocStdinText` 與 Task 2 已加的 `./static_output.ts` import（`isCatPassthrough`/`isEchoPrintOnly`/`isPrintfPrintOnly`）**合併成同一行 import**，避免同模組重複 import。

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
// 每個直譯器各自的「已知 nullary（不吃值）良性旗標」小集合；集合外的分離裸旗標 → 保守放棄。
const NULLARY_BY_INTERP: Record<string, Set<string>> = {
  node: new Set(["--no-warnings"]),
  nodejs: new Set(["--no-warnings"]),
  bun: new Set(["--no-warnings"]),
  "ts-node": new Set(["--transpile-only", "--esm", "--no-check", "--no-warnings"]),
  deno: new Set(["--no-check"]),
  python: new Set<string>(),
  python3: new Set<string>(),
};
function isKnownNullary(name: string, fn: string, isDeno: boolean): boolean {
  if (NULLARY_BY_INTERP[name]?.has(fn)) return true;
  // --experimental-* 僅 js 家族（node/bun/ts-node）；--allow-*/-A 僅 deno。
  if ((name === "node" || name === "nodejs" || name === "bun" || name === "ts-node") &&
    fn.startsWith("--experimental-")) return true;
  if (isDeno && (fn.startsWith("--allow-") || fn === "-A")) return true;
  return false;
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
  const name = inv.name;
  let argv = inv.argv;
  const lang = INTERP_LANG[name];
  if (lang === undefined) return null;
  const isDeno = name === "deno";
  // 子指令模式：deno 必為 eval 或 run；bun run 為 run；其餘裸指令為 normal。
  let mode: "normal" | "eval" | "run" = "normal";
  if (name === "deno") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "eval") { mode = "eval"; argv = argv.slice(1); }
    else if (sub === "run") { mode = "run"; argv = argv.slice(1); }
    else return null;
  } else if (name === "bun") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "run") { mode = "run"; argv = argv.slice(1); }
  }
  // run 模式（deno run / bun run）不吃 inline/-e/-p；只認 script/stdin。
  const inlineFlags = mode === "run" ? new Set<string>() : (lang === "py" ? PY_INLINE : JS_INLINE);
  const printFlags = (mode === "normal" && lang === "js" && name !== "deno") ? JS_PRINT : new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null;
    if (v === "-") {
      // deno run - 為 stdin；其餘（bun run -、eval 模式）不特案 → none
      return (mode === "run" && isDeno) ? { lang, form: { kind: "stdin" } } : { lang, form: { kind: "none" } };
    }
    if (!v.startsWith("-")) {
      // eval 模式第一個位置參數為 payload；run/normal 為 script entrypoint
      return mode === "eval"
        ? { lang, form: { kind: "inline", payload: v } }
        : { lang, form: { kind: "script", entrypoint: v } };
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
    if (isKnownNullary(name, fn, isDeno)) { i++; continue; }
    return { lang, form: { kind: "none" } };   // 分離未知裸旗標 → 保守放棄
  }
  // 掃完無位置參數：eval 無 payload → none；否則可能配 heredoc → stdin
  return mode === "eval" ? { lang, form: { kind: "none" } } : { lang, form: { kind: "stdin" } };
}

// 直譯器葉 fd0 的靜態 heredoc/here-string 文字沿用 static_output 的 heredocStdinText（同一還原規則：
// isHeredocPrintEligible 合格判定、`<<<` 補換行、`<<-` 去 tab、結構化 body（含 $()）→ null）。

/** 直譯器葉的 stdout 是否被 fd1 重導向轉走（→ 非「印到 stdout」吐字，不算載具）。 */
function interpStdoutDiverted(inv: CommandInvocation): boolean {
  return inv.redirects.some((r) =>
    (r.operator === ">" || r.operator === ">>" || r.operator === ">|" ||
      r.operator === "&>" || r.operator === "&>>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
}

/** 葉載具：shell 靜態吐字 → "shell"；直譯器 inline/stdin → "interp"；否則 null。 */
export function leafCarrier(inv: CommandInvocation): "shell" | "interp" | null {
  if (isPrintOnlyForm(inv)) return "shell";
  if (inv.assignments.length > 0) return null;
  if (interpStdoutDiverted(inv)) return null;   // 直譯器輸出寫檔/轉走 → 非 stdout 吐字
  const r = recognizeInterpreter(inv);
  if (r === null) return null;
  if (r.form.kind === "inline") return payloadIsAllStaticPrint(r.form.payload, r.lang) ? "interp" : null;
  if (r.form.kind === "print-expr") return printExprIsStaticString(r.form.expr, r.lang) ? "interp" : null;
  if (r.form.kind === "stdin") {
    const body = heredocStdinText(inv.redirects);
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
  assertEquals(pd(`printf 'x\\n' > fixture.py; python runner.py fixture.py`), null);               // python P=argv
  assertEquals(pd(`echo 'x' > f.ts; deno run runner.ts f.ts`), null);                              // deno P=argv
  assertEquals(pd(`echo 'console.log("x")' > fixture.js; node --loader fixture.js runner.js`), null); // P=旗標值
  assertEquals(pd(`echo 'x' > cfg.json; ts-node --project cfg.json runner.ts`), null);             // ts-node 吃值旗標
  assertEquals(pd(`echo 'x' > im.json; deno run --import-map im.json runner.ts`), null);           // deno 吃值旗標
  assertEquals(pd(`echo 'console.log("f")' > x.mjs; node --experimental-default-type=module x.mjs`), "write-exec");
  assertEquals(pd(`echo 'console.log("f")' > x.ts; ts-node --transpile-only x.ts`), "write-exec"); // 已知 nullary
  assertEquals(pd(`echo 'console.log("f")' > x.ts; deno run --allow-read x.ts`), "write-exec");    // deno --allow-read nullary
});

Deno.test("printDisguiseDeny: cat-readback 邊界 + config over-deny + 控制流", () => {
  assertEquals(pd(`cat >> q <<'EOF'\nx\nEOF\ncat q`), null);                    // append → 非 WRITE
  assertEquals(pd(`if c; then cat > q <<'EOF'\nx\nEOF\nfi; cat q`), null);      // 跨控制流
  assertEquals(pd(`cat > config.yaml <<'EOF'\nk: v\nEOF\ncat config.yaml`), "cat-readback"); // accepted over-deny
  assertEquals(pd(`if command -v node; then node -e 'console.log("f")'; else echo 假; fi`), null); // guard 非載具
  assertEquals(pd(`if true; then echo 假; fi`), null);                          // clause true 非載具
});

Deno.test("printDisguiseDeny: WRITE→EXEC(b) cat 讀回", () => {
  assertEquals(pd(`cat > /tmp/q.txt <<'EOF'\ndead\nEOF\ncat /tmp/q.txt`), "cat-readback");
  assertEquals(pd(`printf 'x\\n' > q; tac q`), "cat-readback");
  assertEquals(pd(`cat > q <<'EOF'\nx\nEOF\necho hi; cat q`), null);   // 非緊鄰
  assertEquals(pd(`cat > a <<'EOF'\nx\nEOF\ncat b`), null);            // 非同檔
});

Deno.test("printDisguiseDeny: setup 豁免 / false / ! true", () => {
  // heredoc 之後以換行分隔下一指令（`&&` 接在 heredoc 終止行後非法；換行序列同樣傳遞 prevWrite）
  assertEquals(pd(`mkdir -p /tmp && cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(pd(`cd /tmp; cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(pd("false && cat > x && node x"), null);              // false 非 setup/載具 → (a) 失敗
  assertEquals(pd(`! true\ncat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), null); // 否定 true 為非載具葉 → (a) 失敗
});

Deno.test("printDisguiseDeny: pipe（D）", () => {
  assertEquals(pd(`echo 'console.log(1)' | node`), "pipe");
  assertEquals(pd("grep x f | node"), null);
  assertEquals(pd("echo a | cat | node"), null);                      // 三段 → 不配對
  assertEquals(pd("echo 'console.log(1)' | node < real.js"), null);   // fd0 蓋過
  assertEquals(pd("node"), null);
  assertEquals(pd("echo 'console.log(1)' | node &"), null);           // 背景 → 跳過 pipe
  assertEquals(pd("{ echo 'console.log(1)' | node; } &"), null);      // 背景複合 → 內層 pipe 亦跳過
  assertEquals(pd("{ echo a | echo b; } > out"), null);               // 整體重導向 → 葉非載具（不誤 deny）
});

Deno.test("printDisguiseDeny: 注入旗標 EXEC → 不配對", () => {
  assertEquals(pd(`echo 'console.log("f")' > x; node --require=./p.js x`), null); // 注入 → EXEC 非 script
  assertEquals(pd(`echo 'console.log("f")' > x; node --require ./p.js x`), null);
});

Deno.test("printDisguiseDeny: 直譯器輸出被轉走 → 非載具、不 deny", () => {
  assertEquals(pd(`node -e 'console.log("x")' > out`), null);        // stdout 寫檔 → 非 stdout 吐字
  assertEquals(pd(`{ node -e 'console.log("x")'; } > out`), null);   // 整體重導向繼承
});
```

> 註：所有 fixture 均以 `parseCommand(...).errors.length === 0` 為前提；heredoc 之後接續指令一律用**換行序列**（`;`/newline，seq 會跨換行傳遞 `prevWrite`），不要在 heredoc 終止行後放 `&&`（bash 語法上非法）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`printDisguiseDeny` 未匯出）。

- [ ] **Step 3: 實作（`print_only.ts` 新增；合併既有 import）**

在 `src/engine/print_only.ts` 頂部**合併** import（勿重複）：

```typescript
import type {
  AndOr, ArithmeticExpression, Command, CompoundList, Node, Pipeline, Redirect,
  Script, Statement, TestExpression, Word, WordPart,
} from "../deps.ts";
import type { CwdState } from "../types.ts";
import { applyCd, isCd } from "./cwd.ts";
import { normalizeAbsolute } from "./scope.ts";
import type { PrintDisguiseKind } from "../rules/types.ts";
import { producerStdout, writtenContent } from "./static_output.ts";
```

新增（走訪完整鏡射 `walk.ts`：相同的節點下降、`$()`/`<()` 列舉、繼承重導向）：

```typescript
type Role = "leaf" | "write-exec" | "pipe" | "setup" | "none";
const SETUP_NAMES = new Set(["mkdir", "cd", "true", ":"]);

interface Leaf {
  inv: CommandInvocation;
  cmd: Command;
  role: Role;
  carrier: "shell" | "interp" | null;
}
interface WriteRef {
  leaf: Leaf;
  path: string;
  content: string | null;
  cwd: CwdState;
}

/** 聚合入口：單一自足走訪（鏡射 walk.ts）、兩階段。回命中 kind 或 null。 */
export function printDisguiseDeny(script: Script, initialCwd: CwdState): { kind: PrintDisguiseKind } | null {
  const leaves: Leaf[] = [];
  let hasWriteExecComposite = false;

  // 序列：thread cwd + prevWrite；` ` / `;` / `&&` 連接的 sibling 傳遞 prev；背景/控制流重置。
  // bg：外層是否處於背景（`&`/coproc）——背景時整個子序列停用 pipe 配對、不傳 adjacency。
  const seq = (statements: Statement[], startCwd: CwdState, inherited: Redirect[], persistent: boolean, bg: boolean): CwdState => {
    let cwd = startCwd;
    let prev: WriteRef | null = null;
    for (const stmt of statements) {
      for (const r of stmt.redirects) enumRedirect(r, cwd);        // 繼承 heredoc 內 $()
      const merged = [...inherited, ...stmt.redirects];
      if (bg || stmt.background === true) {
        node(stmt.command, cwd, merged, false, true, null);        // 背景：不參與 adjacency、跳過 pipe 配對
        prev = null;
        continue;
      }
      const r = node(stmt.command, cwd, merged, false, false, prev);
      if (persistent) cwd = r.cwd;
      prev = r.prev;
    }
    return cwd;
  };

  // 回 { cwd, prev }。bg=true → 停用 pipe 配對；negated 傳給單成員否定 Pipeline。
  const node = (n: Node, cwd: CwdState, inherited: Redirect[], negated: boolean, bg: boolean, prev: WriteRef | null): { cwd: CwdState; prev: WriteRef | null } => {
    switch (n.type) {
      case "Command": {
        const cmd = n as Command;
        const inv = toInv(cmd, cwd, inherited);
        const leaf = classify(inv, cmd, negated, prev);
        leaves.push(leaf);
        descendCmdSubstitutions(cmd, cwd);
        const nextPrev = detectWrite(inv, cmd, cwd, leaf);
        const nextCwd = isCd(cmd) ? applyCd(cmd, cwd) : cwd;
        return { cwd: nextCwd, prev: nextPrev };
      }
      case "AndOr": {
        const ao = n as AndOr;
        let cur = cwd;
        let p = prev;
        for (let k = 0; k < ao.commands.length; k++) {
          if (k > 0 && ao.operators[k - 1] === "||") p = null;      // || 重置 adjacency
          const r = node(ao.commands[k], cur, inherited, negated, bg, p);
          cur = r.cwd;
          p = r.prev;
        }
        return { cwd: cur, prev: p };
      }
      case "Pipeline": {
        detectPipe(n as Pipeline, cwd, inherited, bg);
        return { cwd, prev: null };
      }
      case "Subshell":
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd, prev: null };
      case "BraceGroup":
        return { cwd: seq(n.body.commands, cwd, inherited, true, bg), prev: null };
      case "CompoundList":
        return { cwd: seq((n as CompoundList).commands, cwd, inherited, true, bg), prev: null };
      case "If":
        seq(n.clause.commands, cwd, inherited, false, bg);
        seq(n.then.commands, cwd, inherited, false, bg);
        if (n.else) n.else.type === "If" ? node(n.else, cwd, inherited, false, bg, null) : seq(n.else.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "For":
      case "Select":
        for (const w of n.wordlist) descendWord(w, cwd);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "While":
        seq(n.clause.commands, cwd, inherited, false, bg);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "ArithmeticFor":
        descendArith(n.initialize, cwd);
        descendArith(n.test, cwd);
        descendArith(n.update, cwd);
        seq(n.body.commands, cwd, inherited, false, bg);
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "Case":
        descendWord(n.word, cwd);
        for (const it of n.items) {
          for (const p of it.pattern) descendWord(p, cwd);
          seq(it.body.commands, cwd, inherited, false, bg);
        }
        return { cwd: afterControlFlow(cwd, n), prev: null };
      case "ArithmeticCommand":
        descendArith(n.expression, cwd);
        return { cwd, prev: null };
      case "TestCommand":
        if (n.expression) descendTest(n.expression, cwd);
        return { cwd, prev: null };
      case "Coproc":
        if (n.name) descendWord(n.name, cwd);
        for (const r of n.redirects) enumRedirect(r, cwd);
        node(n.body, cwd, [...inherited, ...n.redirects], false, true, null);   // coproc 非同步 → 跳過 pipe 配對
        return { cwd, prev: null };
      case "Statement": {
        const st = n as Statement;
        for (const r of st.redirects) enumRedirect(r, cwd);
        if (st.background === true) { node(st.command, cwd, [...inherited, ...st.redirects], false, true, null); return { cwd, prev: null }; }
        return node(st.command, cwd, [...inherited, ...st.redirects], negated, bg, prev);
      }
      default:
        return { cwd, prev: null };
    }
  };

  // 控制流後：僅當子樹含 cd 才標 unknown（與 walk.ts 一致）。
  const afterControlFlow = (cwd: CwdState, n: Node): CwdState =>
    cwd.kind === "known" && subtreeContainsCd(n) ? { kind: "unknown" } : cwd;

  const detectPipe = (pl: Pipeline, cwd: CwdState, inherited: Redirect[], bg: boolean): void => {
    const members = pl.commands;
    if (members.length === 1) { node(members[0], cwd, inherited, pl.negated === true, bg, null); return; }
    // 恰兩段、非背景、無整體 pipeline（繼承）重導向 → 嘗試配對；否定不影響資料流、照常判。
    const canPair = members.length === 2 && !bg && inherited.length === 0;
    if (canPair) {
      const prod = members[0].type === "Command" ? members[0] as Command : null;
      const cons = members[1].type === "Command" ? members[1] as Command : null;
      if (prod && cons) {
        const consInv = toInv(cons, cwd, []);
        const source = producerStdout(prod);
        const r = recognizeInterpreter(consInv);
        const clean = consInv.assignments.length === 0 && r !== null && r.form.kind === "stdin" && !hasFd0Override(consInv);
        if (source !== null && clean && payloadIsAllStaticPrint(source, r.lang)) {
          leaves.push({ inv: toInv(prod, cwd, []), cmd: prod, role: "pipe", carrier: null });
          leaves.push({ inv: consInv, cmd: cons, role: "pipe", carrier: null });
          descendCmdSubstitutions(prod, cwd);   // 兩端 word 內 $()/<() 仍納入覆蓋葉集
          descendCmdSubstitutions(cons, cwd);
          return;
        }
      }
    }
    // 不配對：各段當一般葉；保留 inherited（整體 pipeline 重導向使葉成非載具）、negated、bg。
    for (const m of members) node(m, cwd, inherited, pl.negated === true, bg, null);
  };

  seq(script.commands, initialCwd, [], true, false);

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
      prev!.leaf.role = "write-exec";
      hasWriteExecComposite = true;
      return { inv, cmd, role: "write-exec", carrier: null };
    }
    const carrier = leafCarrier(inv);
    if (carrier) return { inv, cmd, role: "leaf", carrier };
    if (!negated && inv.name !== null && SETUP_NAMES.has(inv.name) && inv.assignments.length === 0) {
      return { inv, cmd, role: "setup", carrier: null };
    }
    return { inv, cmd, role: "none", carrier: null };
  }

  function matchExec(inv: CommandInvocation, prev: WriteRef | null): "interp" | "cat" | null {
    if (prev === null || prev.content === null || inv.assignments.length > 0) return null;
    const r = recognizeInterpreter(inv);
    if (r && r.form.kind === "script") {
      if (!sameFile(r.form.entrypoint, inv.cwd, prev.path, prev.cwd)) return null;
      return payloadIsAllStaticPrint(prev.content, r.lang) ? "interp" : null;
    }
    if ((inv.name === "cat" || inv.name === "tac") && !hasFd0Override(inv)) {   // cat 讀回：無 fd0 覆蓋
      const op = soleReadOperand(inv);
      if (op !== null && sameFile(op, inv.cwd, prev.path, prev.cwd)) return "cat";
    }
    return null;
  }

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

  // $()/<() 列舉：Command 的所有 word（name/suffix/prefix 值/redirect target·body）
  function descendCmdSubstitutions(cmd: Command, cwd: CwdState): void {
    if (cmd.name) descendWord(cmd.name, cwd);
    for (const w of cmd.suffix) descendWord(w, cwd);
    for (const a of cmd.prefix) if (a.value) descendWord(a.value, cwd);
    for (const r of cmd.redirects) enumRedirect(r, cwd);
  }
  function enumRedirect(r: Redirect, cwd: CwdState): void {
    if (r.target) descendWord(r.target, cwd);
    if (r.body) descendWord(r.body, cwd);
  }
  function descendWord(w: Word, cwd: CwdState): void {
    if (!w.parts) return;
    for (const part of w.parts) descendPart(part, cwd);
  }
  function descendPart(part: WordPart, cwd: CwdState): void {
    if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
      seq(part.script.commands, cwd, [], false, false);   // 內層葉（prev/cwd 不外洩）
    } else if (part.type === "ArithmeticExpansion") {
      descendArith(part.expression, cwd);
    } else if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
      for (const child of part.parts) descendPart(child, cwd);
    }
  }
  function descendArith(expr: ArithmeticExpression | undefined, cwd: CwdState): void {
    if (!expr) return;
    switch (expr.type) {
      case "ArithmeticCommandExpansion": if (expr.script) seq(expr.script.commands, cwd, [], false, false); return;
      case "ArithmeticBinary": descendArith(expr.left, cwd); descendArith(expr.right, cwd); return;
      case "ArithmeticUnary": descendArith(expr.operand, cwd); return;
      case "ArithmeticTernary": descendArith(expr.test, cwd); descendArith(expr.consequent, cwd); descendArith(expr.alternate, cwd); return;
      case "ArithmeticGroup": descendArith(expr.expression, cwd); return;
      default: return;
    }
  }
  function descendTest(expr: TestExpression, cwd: CwdState): void {
    switch (expr.type) {
      case "TestUnary": descendWord(expr.operand, cwd); return;
      case "TestBinary": descendWord(expr.left, cwd); descendWord(expr.right, cwd); return;
      case "TestLogical": descendTest(expr.left, cwd); descendTest(expr.right, cwd); return;
      case "TestNot": descendTest(expr.operand, cwd); return;
      case "TestGroup": descendTest(expr.expression, cwd); return;
      default: return;
    }
  }
}

// ── module-level helpers ──
// 子樹是否含 cd（鏡射 walk.ts containsCd）。
function subtreeContainsCd(node: Node): boolean {
  switch (node.type) {
    case "Command": return isCd(node as Command);
    case "AndOr":
    case "Pipeline": return node.commands.some(subtreeContainsCd);
    case "Subshell":
    case "BraceGroup": return node.body.commands.some((s: Statement) => subtreeContainsCd(s.command));
    case "CompoundList": return (node as CompoundList).commands.some((s) => subtreeContainsCd(s.command));
    case "If": return node.clause.commands.some((s) => subtreeContainsCd(s.command)) ||
      node.then.commands.some((s) => subtreeContainsCd(s.command)) ||
      (node.else ? (node.else.type === "If" ? subtreeContainsCd(node.else) : node.else.commands.some((s) => subtreeContainsCd(s.command))) : false);
    case "For":
    case "Select":
    case "ArithmeticFor": return node.body.commands.some((s: Statement) => subtreeContainsCd(s.command));
    case "While": return node.clause.commands.some((s) => subtreeContainsCd(s.command)) ||
      node.body.commands.some((s) => subtreeContainsCd(s.command));
    case "Case": return node.items.some((it) => it.body.commands.some((s) => subtreeContainsCd(s.command)));
    case "Statement": return subtreeContainsCd((node as Statement).command);
    default: return false;
  }
}
function toInv(cmd: Command, cwd: CwdState, inherited: Redirect[]): CommandInvocation {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: [...inherited, ...cmd.redirects],
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
  if (r.operator !== ">" && r.operator !== ">|") return null;
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
  return "REL:" + p;
}
```

> 實作備註：
> - 走訪鏡射 `walk.ts`：每個節點型別與 `$()`/`<()` 列舉、繼承重導向、`cd` cwd 穿透皆比照，確保**葉集與 walk 一致**（一個藏在 `$()`/guard 的非載具葉會納入覆蓋、避免誤 deny）。
> - cat-readback（b）與直譯器（a）配對皆設 `hasWriteExecComposite = true`（皆屬 WRITE→EXEC 複合、吃 setup 豁免）。
> - `descendPart` 的參數型別為 `WordPart`（已 import）。

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

- [ ] **Step 1b: 更新既有 `evaluate_test.ts` 的「函式遮蔽 → ask」斷言為 deny（現由閘②）**

既有測試假設舊「函式遮蔽 → ask/allow」語意，本版改為「任何可執行函式定義 → deny」。就地修改以下既有斷言（行號依現況、以字串內容為準）：
- `assertEquals(vd("if false; then echo(){ :; }; fi; echo fake"), "ask");` → 改 `"deny"`（dead branch 函式定義亦 deny）。
- 整個 `Deno.test("閘③ 函式遮蔽 → ask（不可升級）", …)` 區塊：
  - `vd("date(){ sleep 5; }; date")`、`vd("pwd(){ echo fake; }; pwd")`、`vd("waiter(){ sleep 5; }; waiter")`、
    `vd("date(){ sleep 5; }; date", rulesOf({ allow: ["Bash(date *)"] }))`、`vd('echo "$(date(){ rm x; }; date)"')`、
    `vd("f(){ :; }; ls -la")`、`vd("ls -la; ls(){ :; }")`、`vd("ls(){ :; }; ls -la")`、`vd("ls -la; cd(){ :; }")`
    → 全部改斷言 `"deny"`（皆含可執行函式定義）。
    （其中含 `sleep` 者本來就 deny，改後仍 deny；測試名稱改為「閘② 名稱重定義 → deny（不可升級）」。）
- `assertEquals(vd('echo "fake"; echo(){ :; }'), "deny");` → 保持 `"deny"`（已是 deny，reason 由函式遮蔽 ask 改函式定義 deny，verdict 不變）。
- 若有 `sleep(){ :; }; sleep 5` / `sleep 5; sleep(){ :; }` → 仍 `"deny"`（閘① sleep 先命中；不需改）。

**做法**：逐一比對 `evaluate_test.ts` 現有含 `(){` 的斷言，凡 verdict 為 `"ask"`/`"allow"` 者改為 `"deny"`；含 `sleep` 的維持 `"deny"`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL（新斷言 `f(){:;}` 期望 deny 但實作未改、`node -e` 期望 deny）。

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
      `cat > ${proj}/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${proj}/x.mjs`, // write-exec C(a)
      `cat > ${proj}/q.txt <<'EOF'\ndead\nEOF\ncat ${proj}/q.txt`,      // cat-readback C(b)
      `echo 'console.log(1)' | node`,                                   // pipe D
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

> 已查證的既有行為（無需再確認）：`runHook` 以 `env: { CLAUDE_PROJECT_DIR: projectDir }` 起子行程；`main.ts` 的 `resolveProjectRoot(Deno.env)` 取 `CLAUDE_PROJECT_DIR` 為 root；`settings.ts` 的 `loadPermissionRules` 讀 `${root}/.claude/settings.json` 與 `.local.json`（見 `src/permissions/settings.ts:168-169`）。故在 `projectDir/.claude/settings.json` 寫 `permissions.allow` 即被 hook 載入——fixture 有效。

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
- 「### hook 決策 vs settings.json 權限的優先序」與「已接受繞道」段：`node`/`python`/`deno`/`bun`/`ts-node` 的裸 all-static-print 改硬 deny；混載具全 print 改 deny；`ls; echo 假`/`ls; node -e print` 洗白維持不 deny（使用者定案）；函式定義＋alias 類 → deny（取代函式遮蔽 ask）；其他 mutator（`hash`/`enable`/`PATH`/`source`）out-of-scope。**兩處 accepted over-deny 明列**：(1) 名稱重定義（函式/alias），(2) cat 讀回兩步偽裝（`cat > x <<EOF…EOF; cat x` 由寫入重導向 ask 改硬 deny）。
- **「## 指令」段的測試指令**：`deno task test` 註記改為「已含 `--allow-run --allow-env --allow-read --allow-write --allow-sys=uid`」（Task 8 已在 `deno.json` 加 `--allow-write`，e2e 建臨時檔需要）；若有列出單獨跑 `main_test.ts` 的指令，同步補 `--allow-write`。

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

用 python 建構 JSON（正確跳脫），再餵 binary。單一腳本印出每項 decision＋exit code＋reason 片段，並做 no-side-effect 檢查：

```bash
PROJ=$(mktemp -d)
BIN=./dist/permission-checker
python3 - "$PROJ" "$BIN" <<'PY'
import json, subprocess, os, sys, time
PROJ, BIN = sys.argv[1], sys.argv[2]
def run(cmd):
    payload = json.dumps({"tool_name":"Bash","tool_input":{"command":cmd},"cwd":PROJ})
    p = subprocess.run([BIN], input=payload, capture_output=True, text=True,
                       env={**os.environ, "CLAUDE_PROJECT_DIR":PROJ})
    try: out = json.loads(p.stdout)["hookSpecificOutput"]
    except Exception: out = {"permissionDecision":"<parse-fail>","permissionDecisionReason":p.stdout[:80]}
    return p.returncode, out["permissionDecision"], out.get("permissionDecisionReason","")

cases = [
  ("write-exec deny",  f'cat > {PROJ}/v.mjs <<\'EOF\'\nconsole.log("f")\nEOF\nnode {PROJ}/v.mjs', "deny", "執行同檔"),
  ("cat-readback deny", f'cat > {PROJ}/q.txt <<\'EOF\'\ndead\nEOF\ncat {PROJ}/q.txt', "deny", "cat 讀回"),
  ("function deny",    'f(){ :; }; echo done', "deny", "shell 函式"),
  ("alias deny",       'alias grep=x; grep foo', "deny", "alias"),
  ("real compute",     'node -e \'console.log(1+1)\'', "!deny", ""),
  ("washed",           'ls; echo done', "!deny", ""),
  ("write fn script",  f'cat > {PROJ}/d.sh <<\'EOF\'\ndeploy(){ echo hi; }\nEOF', "!deny", ""),
  ("shopt globstar",   'shopt -s globstar; ls', "!deny", ""),   # 非 alias 的 shopt → 不觸發閘②
]
ok = True
for name, cmd, want, frag in cases:
    rc, dec, reason = run(cmd)
    good = (dec != "deny") if want == "!deny" else (dec == "deny" and frag in reason)
    good = good and rc == 0
    print(f"[{'OK' if good else 'FAIL'}] {name}: decision={dec} exit={rc}")
    ok = ok and good

# no-side-effect：預建檔、餵 deny 指令、確認內容與 mtime 不變
for f, cmd in [(f"{PROJ}/x.mjs", f'cat > {PROJ}/x.mjs <<\'EOF\'\nconsole.log("f")\nEOF\nnode {PROJ}/x.mjs'),
               (f"{PROJ}/q2.txt", f'cat > {PROJ}/q2.txt <<\'EOF\'\ndead\nEOF\ncat {PROJ}/q2.txt')]:
    open(f, "w").write("ORIGINAL"); st0 = os.stat(f)
    rc, dec, _ = run(cmd)
    st1 = os.stat(f)
    good = dec == "deny" and rc == 0 and open(f).read() == "ORIGINAL" and st0.st_mtime == st1.st_mtime
    print(f"[{'OK' if good else 'FAIL'}] no-side-effect {os.path.basename(f)} (decision={dec} exit={rc})")
    ok = ok and good
sys.exit(0 if ok else 1)
PY
status=$?
rm -rf "$PROJ"
echo "exit=$status  (0 = 全部 OK)"
```
所有行印 `[OK]` 且 `exit=0`。任何 `[FAIL]` 即 regression，回對應 Task 修正後重跑。

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
