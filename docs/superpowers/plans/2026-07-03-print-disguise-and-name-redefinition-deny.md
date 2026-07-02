# 統一 print-only 載具偽裝 deny 閘 ＋ 名稱重定義 deny 閘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有「shell 層 print-only 偽裝 deny」升級為跨載具（echo/printf/cat + node/python 等直譯器）的統一閘③，並新增「函式定義＋alias 類名稱重定義 → deny」閘②，使本 hook 對 agent 常見的 print-only 假驗證與破壞 name-based 模型的構造回硬 deny。

**Architecture:** `evaluate` 於 `classify` 前依序過閘①(sleep)→閘②(名稱重定義)→no-op→閘③(printDisguiseDeny)。新增純函式模組 `interp_payload.ts`（直譯器 payload 述詞）、`static_output.ts`（shell 靜態輸出還原），改造 `print_only.ts` 為「print 載具框架＋單一自足 AST 走訪的聚合入口」，`walk.ts` 加兩個唯讀 helper。全程純詞法、不碰檔案系統、fail-safe（不確定 → 不 deny）。

**Tech Stack:** Deno + TypeScript；`unbash@4.0.1` 解析 Bash AST；`@std/assert` 測試；`deno compile` 打包單一 binary。

**規格來源：** `docs/superpowers/specs/2026-06-28-interpreter-print-disguise-deny-design.md`（HEAD b535f32，15 輪 dual review 定案）。實作時 spec 為權威；本 plan 的行為對照與測試取自 spec §4/§7。

**全域約定：**
- 每個 Task 完成後跑 `deno task check && deno task lint`，綠燈才 commit（測試步驟另列）。
- 工作目錄共用，**不使用 worktree 隔離**。
- commit 一律以具體檔案路徑 `git add <path>`，不用 `git add -A`。
- `deno task test` 已含 `--allow-run --allow-env --allow-read --allow-sys=uid`。

---

## File Structure

| 檔案 | 職責 | 動作 |
|---|---|---|
| `src/engine/interp_payload.ts` | 直譯器 payload 述詞：`payloadIsAllStaticPrint`、`printExprIsStaticString`（手寫 fail-safe tokenizer + 文法比對） | Create |
| `src/engine/interp_payload_test.ts` | 上者單元測試（deny/不-deny 兩面 + 邊界） | Create |
| `src/engine/static_output.ts` | shell 靜態吐字載具 → 具體輸出字串：`echoOutput`/`printfOutput`/`commandOutput`；並容納 `wordPrintEligible`/`isHeredocPrintEligible`/fd0 最後者勝 | Create |
| `src/engine/static_output_test.ts` | 上者單元測試 | Create |
| `src/engine/walk.ts` | 新增唯讀 helper `hasExecutableFunctionDefinition`、`hasAliasRedefinition` | Modify |
| `src/engine/walk_test.ts` | 上兩 helper 測試 | Modify |
| `src/rules/types.ts` | 新增 `nameRedefinitionDenyReason(kind)`、`printDisguiseDenyReason(kind)`；移除 `printOnlyDenyReason` | Modify |
| `src/engine/print_only.ts` | 改造為載具框架：直譯器旗標解析、葉載具（shell + 直譯器 inline/heredoc-stdin）、複合載具（WRITE→EXEC a/b、pipe）、聚合入口 `printDisguiseDeny(script, initialCwd)` | Modify |
| `src/engine/print_only_test.ts` | 既有 shell 測試保留 + 新增載具/聚合測試 | Modify |
| `src/engine/evaluate.ts` | 接線閘②/閘③、no-op allow 移到閘②之後 | Modify |
| `src/engine/evaluate_test.ts` | 閘②/閘③/排序整合測試 | Modify |
| `src/main_test.ts` | e2e：不可升級、no-side-effect、跨呼叫 migration | Modify |
| `CLAUDE.md` | deny 三類→四類、架構管線、已接受繞道同步 | Modify |

---

## Task 1: `interp_payload.ts` — 直譯器 payload 述詞

**Files:**
- Create: `src/engine/interp_payload.ts`
- Test: `src/engine/interp_payload_test.ts`

述詞判定「一段 source 是否整段只是一條以上的 print 敘述印死字串」（spec §4.1）。`lang`：`"js"`（node/nodejs/deno/bun/ts-node）/`"py"`（python/python3）。純函式、無我方其他相依。

- [ ] **Step 1: 寫失敗測試（deny 面 + 不-deny 面 + 邊界）**

Create `src/engine/interp_payload_test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { payloadIsAllStaticPrint, printExprIsStaticString } from "./interp_payload.ts";

Deno.test("payloadIsAllStaticPrint: js 命中（true）", () => {
  const t = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), true, s);
  t('console.log("fake")');
  t('console.log("a");\nconsole.log("b")');
  t('// comment\nconsole.log("x")');
  t('console.log("a", "b", 1)');           // 多字面量逗號 + 數字
  t('console.log(`plain`)');               // 無 ${} 模板
  t('console.error("e"); console.info("i")');
  t('process.stdout.write("fake")');       // write API STRING-only
  t('console.log(42)');                    // 數字（文字輸出 API 可帶）
});

Deno.test("payloadIsAllStaticPrint: js 不命中（false）", () => {
  const f = (s: string) => assertEquals(payloadIsAllStaticPrint(s, "js"), false, s);
  f('console.log(1+1)');                   // 運算
  f('console.log("a"+"b")');               // 串接
  f('console.log(JSON.stringify(x))');     // 呼叫
  f('console.log(x)');                     // 變數
  f('console.log(`${x}`)');                // 模板表示式
  f('import x from "y"; console.log("a")'); // import
  f('if (a) console.log("x")');            // 控制流
  f('console.log(');                       // 未閉合括號
  f('console.log("unterminated');          // 未閉合字串
  f('');                                   // 空
  f('console.log()');                      // 無引數
  f('process.stdout.write(42)');           // write API 數字引數 → 非純文字
  f('foo("x")');                           // 非 print 函式
});

Deno.test("payloadIsAllStaticPrint: py 命中/不命中", () => {
  assertEquals(payloadIsAllStaticPrint('print("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint("print('a')\nprint('b')", "py"), true);
  assertEquals(payloadIsAllStaticPrint('# c\nprint("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print("""multi""")', "py"), true); // 三引號
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write("x")', "py"), true);
  assertEquals(payloadIsAllStaticPrint('print(json.dumps(d))', "py"), false);
  assertEquals(payloadIsAllStaticPrint('print(f"{x}")', "py"), false);      // f-string
  assertEquals(payloadIsAllStaticPrint('print("x", end="")', "py"), false); // kwarg
  assertEquals(payloadIsAllStaticPrint('sys.stdout.write(1)', "py"), false); // write 數字
});

Deno.test("payloadIsAllStaticPrint: 資源上限超標 → false", () => {
  const huge = 'console.log("x");'.repeat(20000);
  assertEquals(payloadIsAllStaticPrint(huge, "js"), false);
});

Deno.test("printExprIsStaticString: 純字串字面量/串接 → true，其餘 false", () => {
  assertEquals(printExprIsStaticString('"fake"', "js"), true);
  assertEquals(printExprIsStaticString('"a" + "b"', "js"), true);
  assertEquals(printExprIsStaticString('1+1', "js"), false);
  assertEquals(printExprIsStaticString('os.cpus()', "js"), false);
  assertEquals(printExprIsStaticString('`x`', "js"), true);       // 無 ${} 模板
  assertEquals(printExprIsStaticString('`${x}`', "js"), false);   // 模板表示式
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/interp_payload_test.ts`
Expected: FAIL（`interp_payload.ts` 不存在 / 匯出未定義）。

- [ ] **Step 3: 實作 `interp_payload.ts`**

Create `src/engine/interp_payload.ts`:

```typescript
/**
 * 直譯器 payload 述詞（spec §4.1）：判定一段 source 是否「整段只是一條以上的 print
 * 敘述印死字串」。手寫 fail-safe tokenizer + 文法比對；任何不確定一律回 false（不 deny）。
 */

export type Lang = "js" | "py";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOKENS = 20000;

type TokKind = "STRING" | "NUMBER" | "NAME" | "PUNCT" | "DYNAMIC" | "OTHER";
interface Tok {
  kind: TokKind;
  value: string; // NAME 為識別字（含點號鏈）；PUNCT 為單一符號
}

/** 文字輸出 API：可帶 STRING 或 NUMBER。 */
const TEXT_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["console.log", "console.info", "console.warn", "console.error", "console.debug"]),
  py: new Set(["print"]),
};
/** write API：僅可帶 STRING。 */
const WRITE_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["process.stdout.write", "process.stderr.write"]),
  py: new Set(["sys.stdout.write", "sys.stderr.write"]),
};

const NAME_START = /[A-Za-z_$]/;
const NAME_CONT = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Tokenize。回傳 null 代表「無法可靠 tokenize」（未閉合引號、字串逸脫錯誤等）→ 呼叫端 false。
 */
function tokenize(src: string, lang: Lang): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 空白 / 換行
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    // shebang（行首 #!）
    if (c === "#" && src[i + 1] === "!" && (i === 0 || src[i - 1] === "\n")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // 註解
    if (lang === "py" && c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) return null; // 未閉合 block comment
      i += 2;
      continue;
    }
    // 字串
    if (c === '"' || c === "'" || c === "`") {
      const r = readString(src, i, lang);
      if (r === null) return null;
      out.push({ kind: r.dynamic ? "DYNAMIC" : "STRING", value: "" });
      i = r.next;
      if (out.length > MAX_TOKENS) return null;
      continue;
    }
    // 數字
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBnn._+\-eE]/.test(src[j])) {
        // 允許 0x/0o/0b/底線/指數/BigInt n；停在明顯非數字處
        if ((src[j] === "+" || src[j] === "-") && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      out.push({ kind: "NUMBER", value: src.slice(i, j) });
      i = j;
      if (out.length > MAX_TOKENS) return null;
      continue;
    }
    // 識別字（含點號鏈 console.log / process.stdout.write）
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && (NAME_CONT.test(src[j]) || (src[j] === "." && NAME_CONT.test(src[j + 1] ?? "")))) j++;
      out.push({ kind: "NAME", value: src.slice(i, j) });
      i = j;
      if (out.length > MAX_TOKENS) return null;
      continue;
    }
    // 標點
    if (c === "(" || c === ")" || c === "," || c === ";") {
      out.push({ kind: "PUNCT", value: c });
      i++;
      if (out.length > MAX_TOKENS) return null;
      continue;
    }
    // 其餘（運算子等）
    out.push({ kind: "OTHER", value: c });
    i++;
    if (out.length > MAX_TOKENS) return null;
  }
  return out;
}

/** 讀一個字串字面量。回傳 { next, dynamic } 或 null（未閉合）。dynamic：js 含 ${ 的模板、py f-string。 */
function readString(
  src: string,
  start: number,
  lang: Lang,
): { next: number; dynamic: boolean } | null {
  const n = src.length;
  const quote = src[start];
  // py 前綴（在呼叫端已把 NAME 讀走的情況不會進來；此處僅處理裸引號）；f-string 由呼叫端偵測前綴。
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
  // py 三引號
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
  // 一般單/雙引號
  let i = start + 1;
  while (i < n) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return { next: i + 1, dynamic: false };
    if (src[i] === "\n" && lang === "js") return null; // js 一般字串不可跨行
    i++;
  }
  return null;
}

/**
 * 步驟 1.5：把「識別字前綴的字串」處理成 STRING/DYNAMIC。
 * py f-string（f"..."）、js 無此前綴語法。r/b 前綴（py）視為普通 STRING。
 * 做法：tokenize 前先掃 NAME 緊鄰引號的情況——簡化為：若 NAME 恰為 f/F（py）且緊接引號 → 該字串為 DYNAMIC。
 * 本實作在 tokenize 後做一次線性修正。
 */
function applyStringPrefixes(toks: Tok[], _lang: Lang): Tok[] {
  // f-string：py 的 f"..." 在 tokenize 會成為 NAME("f") + STRING。標記為 DYNAMIC。
  const out: Tok[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === "NAME" && /^[fF]$/.test(t.value) && toks[k + 1]?.kind === "STRING") {
      out.push({ kind: "DYNAMIC", value: "" });
      k++; // 吃掉字串
      continue;
    }
    // r/b/rb 等前綴：吃掉前綴 NAME、保留 STRING（普通靜態）
    if (t.kind === "NAME" && /^(r|b|rb|br|R|B)$/.test(t.value) && toks[k + 1]?.kind === "STRING") {
      out.push(toks[k + 1]);
      k++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** 一個 ARG 是否合法。textApi=true 允許 NUMBER，否則僅 STRING。 */
function argOk(kind: TokKind, textApi: boolean): boolean {
  if (kind === "STRING") return true;
  if (kind === "NUMBER") return textApi;
  return false;
}

/**
 * 主述詞：整串須為「一條以上」print 敘述，每條 `PRINT_FN '(' ARG (',' ARG)* ')' ';'?`。
 * 任何不吻合 → false（fail-safe）。
 */
export function payloadIsAllStaticPrint(source: string, lang: Lang): boolean {
  if (source.length > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = applyStringPrefixes(raw, lang);
  const textFns = TEXT_PRINT_FNS[lang];
  const writeFns = WRITE_PRINT_FNS[lang];

  let i = 0;
  let stmtCount = 0;
  const n = toks.length;
  while (i < n) {
    const fn = toks[i];
    if (fn.kind !== "NAME") return false;
    const isText = textFns.has(fn.value);
    const isWrite = writeFns.has(fn.value);
    if (!isText && !isWrite) return false;
    i++;
    if (toks[i]?.kind !== "PUNCT" || toks[i]?.value !== "(") return false;
    i++;
    // 引數列：至少可為空？spec: console.log() 不命中 → 需 ≥1 個 ARG。
    if (toks[i]?.kind === "PUNCT" && toks[i]?.value === ")") return false; // 無引數
    // 第一個 ARG
    if (!argOk(toks[i]?.kind ?? "OTHER", isText)) return false;
    i++;
    // (',' ARG)*
    while (toks[i]?.kind === "PUNCT" && toks[i]?.value === ",") {
      i++;
      if (!argOk(toks[i]?.kind ?? "OTHER", isText)) return false;
      i++;
    }
    // ')'
    if (toks[i]?.kind !== "PUNCT" || toks[i]?.value !== ")") return false;
    i++;
    // 選擇性 ';'
    if (toks[i]?.kind === "PUNCT" && toks[i]?.value === ";") i++;
    stmtCount++;
  }
  return stmtCount >= 1;
}

/**
 * printExprIsStaticString（spec §4.1）：供 `-p`/`--print` 用——source 須為純字串字面量/字串串接
 * `STRING (('+') STRING)*`（js/py 同理），非算術/呼叫/變數/模板。
 */
export function printExprIsStaticString(source: string, lang: Lang): boolean {
  if (source.length > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = applyStringPrefixes(raw, lang);
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
Expected: PASS（全部）。若某邊界失敗，調 tokenizer/文法對齊 spec §4.1，**方向恆為 false（不確定 → 不命中）**。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/interp_payload.ts src/engine/interp_payload_test.ts
git commit -m "feat(engine): add interp_payload static-print predicate (gate ③ vector A/B/C/D)"
```

---

## Task 2: `static_output.ts` — shell 靜態輸出還原

**Files:**
- Create: `src/engine/static_output.ts`
- Test: `src/engine/static_output_test.ts`
- Modify: `src/engine/print_only.ts`（把 `wordPrintEligible`/`isHeredocPrintEligible`/fd0 邏輯移入 static_output 並 re-export）

把 shell 靜態吐字載具還原成具體輸出字串（spec §4.2）：`echoOutput`/`printfOutput`/`commandOutput`（cat 原序、tac 行反轉），回 `string | null`。這些同被葉載具判定、WRITE 內容還原、pipe producer 輸出還原共用。

- [ ] **Step 1: 寫失敗測試**

Create `src/engine/static_output_test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { commandOutput, echoOutput, printfOutput } from "./static_output.ts";

function cmd(src: string): Command {
  return parse(src).commands[0].command as Command;
}

Deno.test("echoOutput: 靜態 → 具體字串；不合格 → null", () => {
  assertEquals(echoOutput(cmd("echo hello world")), "hello world\n");
  assertEquals(echoOutput(cmd("echo -n hi")), "hi");            // -n 無換行
  assertEquals(echoOutput(cmd('echo "$VAR"')), null);           // 動態
});

Deno.test("printfOutput: 靜態 %s → 具體；格式化轉換符 → null", () => {
  assertEquals(printfOutput(cmd("printf '%s\\n' hi")), "hi\n");
  assertEquals(printfOutput(cmd("printf '%d' 5")), null);        // 數值轉換符 carve-out
});

Deno.test("commandOutput: cat 原序、tac 行反轉", () => {
  assertEquals(commandOutput(cmd("cat <<'EOF'\nA\nB\nEOF")), "A\nB\n");
  assertEquals(commandOutput(cmd("tac <<'EOF'\nA\nB\nEOF")), "B\nA\n");
  assertEquals(commandOutput(cmd("cat file.txt")), null);        // 有檔案操作元 → 非 passthrough
});
```

> 註：echo/printf 的精確輸出字串（換行、`-n`）以 bash 語意還原；若既有 `isEchoPrintOnly`/`isPrintfPrintOnly` 的合格判定與此不完全一致，實作以「合格才回字串、不合格回 null」為準，具體字串格式對齊上列斷言。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/static_output_test.ts`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `static_output.ts`（含自 print_only.ts 移入的共用判定）**

Create `src/engine/static_output.ts`。把 `print_only.ts` 現有的 `wordPrintEligible`、`isHeredocPrintEligible`、`isEchoPrintOnly`、`isPrintfPrintOnly`、`isCatPassthrough`、`hasFileOperand`、`hasFormatterConversion`、fd0「最後者勝」等**移入本檔並 export**（print_only.ts 改為 import）。新增三個還原函式：

```typescript
import type { CommandInvocation } from "../types.ts";
import type { Command, Redirect, Word, WordPart } from "../deps.ts";
import { isStatic, nestedPartIsDynamic, staticValue, topPartIsDynamic } from "./word.ts";
import { hasWriteRedirect } from "./redirect.ts";

// ── 以下 wordPrintEligible / heredocBodyEligible / isHeredocPrintEligible /
//    isEchoPrintOnly / isPrintfPrintOnly / hasFormatterConversion / isCatPassthrough /
//    hasFileOperand 由 print_only.ts 原封移入並 export（邏輯不變，見既有實作）。 ──
// export function wordPrintEligible(w: Word): boolean { … }
// export function isHeredocPrintEligible(r: Redirect): boolean { … }
// （其餘同）

/** 從 Command 建構最小 invocation 視圖（name/argv/redirects），供還原函式使用。 */
function toInv(cmd: Command): Pick<CommandInvocation, "name" | "argv" | "redirects" | "assignments"> {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
  };
}

/** echo 靜態輸出 → 具體字串（含 -n 無換行 / -e 反斜線詮釋）；不合格回 null。 */
export function echoOutput(cmd: Command): string | null {
  const inv = toInv(cmd);
  if (inv.name !== "echo" || inv.assignments.length > 0 || hasWriteRedirect(inv.redirects)) return null;
  let noNewline = false;
  let interpretEscapes = false;
  const parts: string[] = [];
  let seenOperand = false;
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null; // 動態
    if (!seenOperand && /^-[neE]+$/.test(v)) {
      if (v.includes("n")) noNewline = true;
      if (v.includes("e")) interpretEscapes = true;
      if (v.includes("E")) interpretEscapes = false;
      continue;
    }
    seenOperand = true;
    parts.push(v);
  }
  let s = parts.join(" ");
  if (interpretEscapes) s = applyEchoEscapes(s);
  return noNewline ? s : s + "\n";
}

/** 還原 echo -e 的常見反斜線跳脫（\n \t \\ 等）。 */
function applyEchoEscapes(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
}

/** printf 靜態輸出 → 具體字串（僅支援 %s/%b/%% 純字串樣式；含數值/日期等轉換符回 null）。 */
export function printfOutput(cmd: Command): string | null {
  const inv = toInv(cmd);
  if (inv.name !== "printf" || inv.assignments.length > 0 || hasWriteRedirect(inv.redirects)) return null;
  const args = inv.argv.map((w) => staticValue(w));
  if (args.some((a) => a === null)) return null;
  const vals = args as string[];
  // 略過前導 `--`
  let idx = 0;
  if (vals[0] === "--") idx = 1;
  const fmt = vals[idx];
  if (fmt === undefined) return "";
  if (fmt.startsWith("-") && fmt !== "--") return null; // 選項如 -v
  // 僅允許 %s / %b / %% 及字面；其餘轉換符 → null（carve-out）
  const stripped = fmt.replace(/%%/g, "");
  if (/%[^sb%]/.test(stripped) || /%[-+ 0#'0-9.*]*[diouxXeEfFgGaAcCqn]/.test(stripped)) return null;
  const operands = vals.slice(idx + 1);
  let out = "";
  let oi = 0;
  for (let k = 0; k < fmt.length; k++) {
    if (fmt[k] === "%" && fmt[k + 1] === "%") { out += "%"; k++; continue; }
    if (fmt[k] === "%" && (fmt[k + 1] === "s" || fmt[k + 1] === "b")) {
      out += operands[oi++] ?? "";
      k++;
      continue;
    }
    if (fmt[k] === "\\" && fmt[k + 1] === "n") { out += "\n"; k++; continue; }
    if (fmt[k] === "\\" && fmt[k + 1] === "t") { out += "\t"; k++; continue; }
    out += fmt[k];
  }
  return out;
}

/** cat/tac heredoc/here-string passthrough → 實際 stdout（cat 原序、tac 行反轉）；不合格回 null。 */
export function commandOutput(cmd: Command): string | null {
  const inv = toInv(cmd);
  if ((inv.name !== "cat" && inv.name !== "tac") || inv.assignments.length > 0) return null;
  if (hasWriteRedirect(inv.redirects)) return null;
  if (hasFileOperand(inv.name, inv.argv)) return null; // 有檔案操作元 → 讀真實檔
  const body = effectiveHeredocBody(inv.redirects);
  if (body === null) return null;
  if (inv.name === "tac") {
    // tac 逐行反轉（保留尾端換行語意的常見情形：以 \n 切、反轉、再接回）
    const hadTrailing = body.endsWith("\n");
    const lines = (hadTrailing ? body.slice(0, -1) : body).split("\n");
    lines.reverse();
    return lines.join("\n") + (hadTrailing ? "\n" : "");
  }
  return body;
}

/**
 * 取 fd0「最後者勝」的有效 heredoc/here-string body 原文（引號 heredoc 或無 $/反引號的純文字）。
 * 非 passthrough（有效 stdin 是 < file 或 <&fd）→ null。沿用既有 isCatPassthrough/isHeredocPrintEligible 的判定。
 */
function effectiveHeredocBody(redirects: Redirect[]): string | null {
  const fd0 = redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0.length === 0) return null;
  const eff = fd0[fd0.length - 1];
  if (eff.operator === "<<<") {
    return eff.target ? staticValue(eff.target) : "";
  }
  if (eff.operator !== "<<" && eff.operator !== "<<-") return null;
  if (!isHeredocPrintEligible(eff)) return null;
  // 還原 body 文字：引號分隔符 → content；未引號純文字 → content。含 $()（結構化 body）→ 由呼叫端另行；此處回 content。
  return eff.content ?? "";
}
```

> 實作備註：`effectiveHeredocBody` 對「未引號 heredoc 含 `$()`」的 body（結構化 Word）保守回 `content`（可能為空字串）；對 WRITE→EXEC(a) 的 payload 述詞而言，含 `$()` 的 body 本就非全靜態 print、方向 under-deny，可接受。`isHeredocPrintEligible`/`hasFileOperand`/`isCatPassthrough` 等直接沿用既有 print_only.ts 實作（移入本檔）。

- [ ] **Step 4: 改 `print_only.ts` 改 import 這些共用判定（暫時保留其餘既有邏輯不動）**

在 `src/engine/print_only.ts` 頂部，把原本定義於本檔的 `wordPrintEligible`/`isHeredocPrintEligible`/`isEchoPrintOnly`/`isPrintfPrintOnly`/`isCatPassthrough`/`hasFileOperand`/`hasFormatterConversion`/`heredocBodyEligible`/`hasLeadingTilde`/`topPartEligible` 刪除，改為：

```typescript
import { isHeredocPrintEligible, wordPrintEligible } from "./static_output.ts";
```

並確保 `print_only.ts` 仍 re-export 測試需要的 `wordPrintEligible`（既有 print_only_test.ts 由此匯入）：

```typescript
export { wordPrintEligible } from "./static_output.ts";
```

`isPrintOnlyForm`/`isAllPrintOnly` 暫時保留（Task 5/6 才由 `printDisguiseDeny` 取代）。

- [ ] **Step 5: 跑測試確認通過（含既有 print_only 回歸不破）**

Run: `deno test --allow-env src/engine/static_output_test.ts src/engine/print_only_test.ts`
Expected: PASS（static_output 新測試 + 既有 print_only 測試皆綠）。

- [ ] **Step 6: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/static_output.ts src/engine/static_output_test.ts src/engine/print_only.ts
git commit -m "feat(engine): add static_output reconstruction (echo/printf/cat·tac), share print-eligible helpers"
```

---

## Task 3: `walk.ts` — 名稱重定義偵測 helper

**Files:**
- Modify: `src/engine/walk.ts`
- Test: `src/engine/walk_test.ts`

新增兩個唯讀 helper（spec §4.6）：`hasExecutableFunctionDefinition(script)`（node-based fail-closed：任一可執行位置的 `Function` 節點即 true，忽略靜態名）、`hasAliasRedefinition(invocations)`（name-based：`alias`/`unalias`/`shopt -s expand_aliases`，並解 `builtin`/`command` 包裝）。不改攤平職責與 `CommandInvocation` 結構。

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/walk_test.ts` 末尾新增：

```typescript
import { hasAliasRedefinition, hasExecutableFunctionDefinition, walk } from "./walk.ts";
import { parseCommand } from "./parse.ts";
// （若檔案頂部已 import walk/相關，勿重複；以現有 import 為準）

const CWD0 = { kind: "known", path: "/proj" } as const;
function script(src: string) {
  return parseCommand(src).script;
}
function invsOf(src: string) {
  return walk(parseCommand(src).script, CWD0, "/proj");
}

Deno.test("hasExecutableFunctionDefinition: 可執行位置函式 → true", () => {
  assertEquals(hasExecutableFunctionDefinition(script("f(){ echo hi; }; f")), true);
  assertEquals(hasExecutableFunctionDefinition(script("f(){:;}")), true);
  assertEquals(hasExecutableFunctionDefinition(script("if false; then f(){:;}; fi; echo hi")), true);
  assertEquals(hasExecutableFunctionDefinition(script('echo "$(f(){:;}; f)"')), true);
  assertEquals(hasExecutableFunctionDefinition(script("cat <<EOF\n$(g(){:;}; g)\nEOF")), true);
});

Deno.test("hasExecutableFunctionDefinition: 函式文字為資料 → false", () => {
  assertEquals(hasExecutableFunctionDefinition(script("cat > x.sh <<'EOF'\nf(){ :; }\nEOF")), false);
  assertEquals(hasExecutableFunctionDefinition(script("cat > x.sh <<EOF\nf(){ :; }\nEOF")), false);
  assertEquals(hasExecutableFunctionDefinition(script("echo 'f(){ echo hi; }'")), false);
  assertEquals(hasExecutableFunctionDefinition(script("cat <<'EOF'\n$(f(){:;}; f)\nEOF")), false); // 引號 heredoc
  assertEquals(hasExecutableFunctionDefinition(script("ls -la")), false);
});

Deno.test("hasAliasRedefinition: alias/unalias/shopt 及 builtin/command 包裝 → true", () => {
  assertEquals(hasAliasRedefinition(invsOf("alias grep='rm -rf'; grep x")), true);
  assertEquals(hasAliasRedefinition(invsOf("unalias -a")), true);
  assertEquals(hasAliasRedefinition(invsOf("shopt -s expand_aliases; alias c=x")), true);
  assertEquals(hasAliasRedefinition(invsOf("builtin alias x=y")), true);
  assertEquals(hasAliasRedefinition(invsOf("command alias x=y")), true);
  assertEquals(hasAliasRedefinition(invsOf("command builtin alias x=y")), true);
  assertEquals(hasAliasRedefinition(invsOf("command -p alias x=y")), true);
  assertEquals(hasAliasRedefinition(invsOf("if true; then alias a=b; fi")), true);
});

Deno.test("hasAliasRedefinition: 非啟用/資料/非 alias → false", () => {
  assertEquals(hasAliasRedefinition(invsOf("shopt -s globstar")), false);
  assertEquals(hasAliasRedefinition(invsOf("shopt -u expand_aliases")), false);
  assertEquals(hasAliasRedefinition(invsOf("shopt expand_aliases")), false);
  assertEquals(hasAliasRedefinition(invsOf("command ls")), false);
  assertEquals(hasAliasRedefinition(invsOf("cat > setup.sh <<'EOF'\nalias grep=x\nEOF")), false);
  assertEquals(hasAliasRedefinition(invsOf("echo 'alias grep=x'")), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: FAIL（`hasExecutableFunctionDefinition`/`hasAliasRedefinition` 未匯出）。

- [ ] **Step 3: 實作兩 helper（`walk.ts` 末尾新增）**

`hasExecutableFunctionDefinition` 沿用既有 `collectFns` 走訪結構、遇 `Function` 節點即回 true：

```typescript
import type { CommandInvocation } from "../types.ts";
// （walk.ts 已 import 多數型別；ShFunction 由 collectFns 的 Function case 覆蓋，無需額外）

/** 是否存在任一「可執行位置」的函式定義（node-based、fail-closed；忽略函式名可否靜態還原）。 */
export function hasExecutableFunctionDefinition(script: Script): boolean {
  return script.commands.some((s) =>
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
      return seqHasFn(node.body.commands);
    case "Case":
      return node.items.some((it) => it.pattern.some(wordHasFn) || seqHasFn(it.body.commands));
    case "Statement":
      return node.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(node.command);
    case "Coproc":
      return nodeHasFn(node.body);
    default:
      return false;
  }
}

function seqHasFn(statements: Statement[]): boolean {
  return statements.some((s) =>
    s.redirects.some((r) => wordHasFn(r.target) || wordHasFn(r.body)) || nodeHasFn(s.command)
  );
}

/** Word 內的 $()/<() 內層腳本是否含 Function 節點。 */
function wordHasFn(word: Word | undefined): boolean {
  if (!word?.parts) return false;
  return word.parts.some(partHasFn);
}

function partHasFn(part: WordPart): boolean {
  if ((part.type === "CommandExpansion" || part.type === "ProcessSubstitution") && part.script) {
    return seqHasFn(part.script.commands);
  }
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    return part.parts.some(partHasFn);
  }
  return false;
}

const ALIAS_BUILTINS = new Set(["alias", "unalias"]);

/** 是否存在 alias 類名稱重定義：alias/unalias、或 shopt -s expand_aliases（含 builtin/command 包裝）。 */
export function hasAliasRedefinition(invocations: CommandInvocation[]): boolean {
  return invocations.some((inv) => {
    const eff = unwrapDispatcher(inv.name, inv.argv);
    if (eff === null) return false;
    if (ALIAS_BUILTINS.has(eff.name)) return true;
    if (eff.name === "shopt") return shoptEnablesAliases(eff.argv);
    return false;
  });
}

/** 解 builtin/command 分派器包裝，取有效名 + 其後 argv；非分派器則原樣回。動態名 → null。 */
function unwrapDispatcher(name: string | null, argv: Word[]): { name: string; argv: Word[] } | null {
  if (name === null) return null;
  if (name !== "builtin" && name !== "command") return { name, argv };
  // 略過 command/builtin 自身旗標（如 command -p / -v / -V），取第一個非旗標位置 token 為有效名
  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null; // 動態 → 不可判定
    if (v.startsWith("-") && v !== "-") { i++; continue; }
    // 遞迴解多層（command builtin alias …）
    return unwrapDispatcher(v, argv.slice(i + 1));
  }
  return null;
}

/** shopt argv 是否為「-s（set）且含 expand_aliases」。 */
function shoptEnablesAliases(argv: Word[]): boolean {
  const vals = argv.map((w) => staticValue(w));
  const hasSet = vals.includes("-s");
  const hasExpand = vals.includes("expand_aliases");
  return hasSet && hasExpand;
}
```

> 註：`unwrapDispatcher` 對 `command`/`builtin` 需 `Word[]` 的 `slice`；`staticValue` 已 import 於 walk.ts。`ALIAS_BUILTINS`/helpers 置於檔案末尾與其他 helper 同區。

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/walk_test.ts`
Expected: PASS。

- [ ] **Step 5: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/walk.ts src/engine/walk_test.ts
git commit -m "feat(engine): add hasExecutableFunctionDefinition + hasAliasRedefinition (gate ②)"
```

---

## Task 4: `rules/types.ts` — 新 deny 理由

**Files:**
- Modify: `src/rules/types.ts`

新增 `nameRedefinitionDenyReason(kind)`（function/alias）與 `printDisguiseDenyReason(kind)`（shell-print/interp-inline/write-exec/cat-readback/pipe），移除 `printOnlyDenyReason`（spec §4.5/§4.6.3）。

- [ ] **Step 1: 新增理由函式、移除舊函式**

在 `src/rules/types.ts` 中**刪除** `printOnlyDenyReason`，新增：

```typescript
export type PrintDisguiseKind =
  | "shell-print"
  | "interp-inline"
  | "write-exec"
  | "cat-readback"
  | "pipe";

/** 統一 print-only 載具偽裝的 deny 理由（依命中形態客製；共用「被禁的事＋原因＋替代」骨架）。 */
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

- [ ] **Step 2: 暫時保留 evaluate.ts 對 printOnlyDenyReason 的 import（下一 Task 才改）**

因 `evaluate.ts` 仍 import `printOnlyDenyReason`，本步驟先**保留** `functionShadowReason`（Task 7 才移除其使用）與其他既有函式；僅移除 `printOnlyDenyReason` 會使 `deno check` 失敗。故本 Task **先不刪** `printOnlyDenyReason`，只**新增**兩個新函式。刪除 `printOnlyDenyReason` 併入 Task 7（evaluate 改線時一起處理），避免中間狀態編譯失敗。

> 修正上一步：本 Task 只**新增** `printDisguiseDenyReason` / `nameRedefinitionDenyReason` 與 `PrintDisguiseKind` type，**不刪** `printOnlyDenyReason` / `functionShadowReason`。

- [ ] **Step 3: check + lint**

Run: `deno task check && deno task lint`
Expected: PASS（新增函式，未破壞既有 import）。

- [ ] **Step 4: commit**

```bash
git add src/rules/types.ts
git commit -m "feat(rules): add printDisguiseDenyReason + nameRedefinitionDenyReason"
```

---

## Task 5: `print_only.ts` — 直譯器旗標解析 ＋ 葉載具（inline A / heredoc-stdin B）

**Files:**
- Modify: `src/engine/print_only.ts`
- Test: `src/engine/print_only_test.ts`

實作直譯器葉的旗標分類（保守 arity，spec §4.3.3）與葉載具識別：shell 靜態吐字（沿用既有 `isPrintOnlyForm`）＋直譯器 inline（向量 A）＋直譯器 heredoc-stdin（向量 B）。本 Task 產出一個純函式 `leafCarrier(inv)`，回 `"shell" | "interp" | null`（供 Task 6 聚合使用）。

- [ ] **Step 1: 寫失敗測試（葉載具識別，直接測 `leafCarrier`）**

在 `src/engine/print_only_test.ts` 末尾新增：

```typescript
import { leafCarrier } from "./print_only.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";

const CWD = { kind: "known", path: "/proj" } as const;
function inv0(src: string) {
  return walk(parseCommand(src).script, CWD, "/proj")[0];
}

Deno.test("leafCarrier: shell 靜態吐字", () => {
  assertEquals(leafCarrier(inv0("echo hi")), "shell");
  assertEquals(leafCarrier(inv0("printf '%s\\n' hi")), "shell");
  assertEquals(leafCarrier(inv0("cat <<'EOF'\nhi\nEOF")), "shell");
  assertEquals(leafCarrier(inv0("ls")), null);
});

Deno.test("leafCarrier: 直譯器 inline（A）", () => {
  assertEquals(leafCarrier(inv0(`node -e 'console.log("fake")'`)), "interp");
  assertEquals(leafCarrier(inv0(`python -c 'print("x")'`)), "interp");
  assertEquals(leafCarrier(inv0(`node -p '"fake"'`)), "interp");
  assertEquals(leafCarrier(inv0(`deno eval 'console.log("x")'`)), "interp");
  assertEquals(leafCarrier(inv0(`node -e 'console.log(1+1)'`)), null);       // 運算
  assertEquals(leafCarrier(inv0(`node -p '1+1'`)), null);
  assertEquals(leafCarrier(inv0(`node --no-warnings -e 'console.log("x")'`)), "interp"); // 已知 nullary
  assertEquals(leafCarrier(inv0(`node --title -e 'console.log("x")'`)), null); // 分離未知旗標 → 放棄
  assertEquals(leafCarrier(inv0(`node --require ./p.js -e 'console.log("x")'`)), null); // 注入旗標
  assertEquals(leafCarrier(inv0(`node --require=./p.js -e 'console.log("x")'`)), null);  // =value 注入
  assertEquals(leafCarrier(inv0(`X=1 node -e 'console.log("x")'`)), null);    // 賦值前綴
});

Deno.test("leafCarrier: 直譯器 heredoc-stdin（B）", () => {
  assertEquals(leafCarrier(inv0(`node <<'EOF'\nconsole.log("x")\nEOF`)), "interp");
  assertEquals(leafCarrier(inv0(`python <<'EOF'\nprint("x")\nEOF`)), "interp");
  assertEquals(leafCarrier(inv0(`deno run -`)), null);   // 無 heredoc → 繼承 stdin，不可判
  assertEquals(leafCarrier(inv0(`node`)), null);         // 裸 node 無 fd0 → 非載具
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`leafCarrier` 未匯出）。

- [ ] **Step 3: 實作旗標解析 + `leafCarrier`（`print_only.ts` 新增）**

在 `src/engine/print_only.ts` 新增（可放在檔案上半，`isAllPrintOnly` 附近）：

```typescript
import type { CommandInvocation } from "../types.ts";
import type { Word } from "../deps.ts";
import { staticValue } from "./word.ts";
import { commandOutput, echoOutput, isHeredocPrintEligible, printfOutput } from "./static_output.ts";
import { payloadIsAllStaticPrint, printExprIsStaticString, type Lang } from "./interp_payload.ts";
// isPrintOnlyForm 既有（本檔）；若已移入 static_output 則改 import。

const INTERPRETERS: Record<string, Lang> = {
  node: "js", nodejs: "js", deno: "js", bun: "js", "ts-node": "js",
  python: "py", python3: "py",
};

const INLINE_EVAL_FLAGS = new Set(["-e", "--eval", "-c"]);       // 取值為 payload（payloadIsAllStaticPrint）
const PRINT_EXPR_FLAGS = new Set(["-p", "--print"]);             // 取值為運算式（printExprIsStaticString）
const INJECT_FLAGS = new Set([
  "-r", "--require", "--import", "-m", "--preload", "--env-file", "--loader", "--experimental-loader",
]);
const KNOWN_NULLARY = new Set([
  "--no-warnings", "--no-check", "-A", "--esm", "--transpile-only",
]);
/** 前綴式已知 nullary（如 --experimental-*、deno --allow-*）。 */
function isKnownNullaryPrefix(flag: string): boolean {
  return flag.startsWith("--experimental-") || flag.startsWith("--allow-");
}

/** 把 `--name=value` 正規化為 `--name`（分離形原樣回）。 */
function flagName(tok: string): string {
  const eq = tok.indexOf("=");
  return eq > 0 && tok.startsWith("-") ? tok.slice(0, eq) : tok;
}

/** 結果：inline payload / print-expr / heredoc-stdin / script-exec / 非載具。 */
type InterpForm =
  | { kind: "inline"; payload: string }
  | { kind: "print-expr"; expr: string }
  | { kind: "stdin" }
  | { kind: "script"; entrypoint: string | null }
  | { kind: "none" };

/**
 * 解析直譯器葉的形態（spec §4.3.1/§4.3.3）。fail-safe：任何不確定 → { kind: "none" }。
 * 賦值前綴由呼叫端先擋（此函式假設 inv.assignments 為空）。
 */
export function recognizeInterpreter(inv: CommandInvocation): { lang: Lang; form: InterpForm } | null {
  if (inv.name === null) return null;
  let name = inv.name;
  let argv = inv.argv;
  // deno 子指令：eval → inline；run → script/stdin
  if (name === "deno") {
    const sub = argv.length > 0 ? staticValue(argv[0]) : null;
    if (sub === "eval") {
      const payload = argv.length > 1 ? staticValue(argv[1]) : null;
      return payload === null ? null : { lang: "js", form: { kind: "inline", payload } };
    }
    if (sub === "run") { argv = argv.slice(1); name = "deno-run"; }
    else return null; // 其他 deno 子指令不處理
  }
  const lang = INTERPRETERS[name === "deno-run" ? "deno" : name];
  if (lang === undefined) return null;

  // 掃旗標（保守 arity）：找 inline-eval / print / script 進入點；遇注入旗標 → none；遇分離未知裸旗標 → none
  let i = 0;
  while (i < argv.length) {
    const v = staticValue(argv[i]);
    if (v === null) return null; // 動態 token
    if (!v.startsWith("-") || v === "-") {
      // 位置參數：進入點（script-exec 形態）；deno-run - 為 stdin 標記
      if (name === "deno-run" && v === "-") return { lang, form: { kind: "stdin" } };
      return { lang, form: { kind: "script", entrypoint: v } };
    }
    const fn = flagName(v);
    // inline-eval
    if (INLINE_EVAL_FLAGS.has(fn)) {
      const val = v.includes("=") ? v.slice(v.indexOf("=") + 1) : (argv[i + 1] ? staticValue(argv[i + 1]) : null);
      return val === null ? null : { lang, form: { kind: "inline", payload: val } };
    }
    if (PRINT_EXPR_FLAGS.has(fn)) {
      const val = v.includes("=") ? v.slice(v.indexOf("=") + 1) : (argv[i + 1] ? staticValue(argv[i + 1]) : null);
      return val === null ? null : { lang, form: { kind: "print-expr", expr: val } };
    }
    // 注入旗標（黏值/分離皆算）→ 非載具
    if (INJECT_FLAGS.has(fn)) return { lang, form: { kind: "none" } };
    // 良性旗標
    if (v.includes("=")) { i++; continue; }          // --flag=value → arity 0
    if (KNOWN_NULLARY.has(fn) || isKnownNullaryPrefix(fn)) { i++; continue; } // 已知 nullary
    return { lang, form: { kind: "none" } };          // 分離未知裸旗標 → 保守放棄
  }
  // 無位置參數、無 inline → 可能是 stdin 形態（配 heredoc）
  return { lang, form: { kind: "stdin" } };
}

/** 直譯器葉是否為 print 載具（inline A / heredoc-stdin B）。 */
function interpLeafCarrier(inv: CommandInvocation): boolean {
  if (inv.assignments.length > 0) return false; // 賦值前綴
  const r = recognizeInterpreter(inv);
  if (r === null) return false;
  const { lang, form } = r;
  if (form.kind === "inline") return payloadIsAllStaticPrint(form.payload, lang);
  if (form.kind === "print-expr") return printExprIsStaticString(form.expr, lang);
  if (form.kind === "stdin") {
    // heredoc-stdin：fd0 為靜態 heredoc/here-string，body 過 payload 述詞
    const body = interpStdinBody(inv);
    return body !== null && payloadIsAllStaticPrint(body, lang);
  }
  return false; // script-exec 由複合載具處理，非葉載具
}

/** 取直譯器葉 fd0 的靜態 heredoc/here-string body（最後者勝 + isHeredocPrintEligible）；否則 null。 */
function interpStdinBody(inv: CommandInvocation): string | null {
  const fd0 = inv.redirects.filter((r) =>
    (r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  // 需確認無被 < file / <&fd 蓋過（最後者勝）
  const allFd0 = inv.redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
      r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (allFd0.length === 0) return null;
  const eff = allFd0[allFd0.length - 1];
  if (eff.operator !== "<<" && eff.operator !== "<<-" && eff.operator !== "<<<") return null;
  if (!isHeredocPrintEligible(eff)) return null;
  if (eff.operator === "<<<") return eff.target ? staticValue(eff.target) : "";
  void fd0;
  return eff.content ?? "";
}

/** 葉載具總判定：shell 靜態吐字 → "shell"；直譯器 inline/stdin → "interp"；否則 null。 */
export function leafCarrier(inv: CommandInvocation): "shell" | "interp" | null {
  if (isPrintOnlyForm(inv)) return "shell";
  if (interpLeafCarrier(inv)) return "interp";
  return null;
}
```

> 註：`isPrintOnlyForm` 為既有（本檔）判定 echo/printf/cat·tac heredoc 的 shell 載具，直接沿用。`interpStdinBody` 對含 `$()` 的未引號 heredoc 保守回 `content`（under-deny，可接受）。

- [ ] **Step 4: 跑測試確認通過**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS（含既有 shell 測試 + 新 leafCarrier 測試）。

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

實作單一自足 AST 走訪：分類每葉（葉載具 / 複合成員 write-exec / 複合成員 pipe / setup 白名單 / 皆非），偵測 WRITE→EXEC(a)(b)、pipe 複合，再依 spec §4.4 兩階段判定回 `{ kind } | null`。kind 優先序 write-exec > cat-readback > pipe > interp-inline > shell-print。

- [ ] **Step 1: 寫失敗測試（`printDisguiseDeny` 全行為對照，取自 spec §4.4 表與 §7.4）**

在 `src/engine/print_only_test.ts` 末尾新增：

```typescript
import { printDisguiseDeny } from "./print_only.ts";

function deny(src: string): string | null {
  const hit = printDisguiseDeny(parseCommand(src).script, CWD);
  return hit ? hit.kind : null;
}

Deno.test("printDisguiseDeny: 純 shell / 混載具全 print → deny", () => {
  assertEquals(deny("echo a; echo b"), "shell-print");
  assertEquals(deny(`echo a; node -e 'console.log("b")'`), "interp-inline");
  assertEquals(deny("for x in a b; do echo 假; done"), "shell-print");
});

Deno.test("printDisguiseDeny: 整鏈洗白（含非載具葉）→ 不 deny", () => {
  assertEquals(deny(`ls; node -e 'console.log("假")'`), null);
  assertEquals(deny("ls; echo 假"), null);
  assertEquals(deny("pwd; echo 假"), null);
  assertEquals(deny("true && echo 已驗證"), null);
  assertEquals(deny("mkdir build && echo done"), null);
  assertEquals(deny("echo 假; ls"), null);           // 兩階段前綴 false-deny
  assertEquals(deny(`node -e 'console.log("x")'; ls`), null);
});

Deno.test("printDisguiseDeny: WRITE→EXEC(a) 直譯器", () => {
  assertEquals(deny(`cat > /tmp/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode /tmp/x.mjs`), "write-exec");
  assertEquals(deny(`echo 'console.log("f")' > f; node f`), "write-exec");
  // 進入點負面：P 為程式 argv
  assertEquals(deny(`echo 'console.log("f")' > fixture.js; node runner.js fixture.js`), null);
  // 進入點負面：P 為吃值旗標的值
  assertEquals(deny(`echo 'console.log("x")' > fixture.js; node --loader fixture.js runner.js`), null);
  // 良性 nullary/=value 旗標 → deny
  assertEquals(deny(`echo 'console.log("f")' > x.mjs; node --experimental-default-type=module x.mjs`), "write-exec");
});

Deno.test("printDisguiseDeny: WRITE→EXEC(b) cat 讀回", () => {
  assertEquals(deny(`cat > /tmp/q.txt <<'EOF'\ndead\nEOF\ncat /tmp/q.txt`), "cat-readback");
  assertEquals(deny(`printf 'x\\n' > q; tac q`), "cat-readback");
  // 不 deny 面
  assertEquals(deny(`cat > q <<'EOF'\nx\nEOF\necho hi; cat q`), null);   // 非緊鄰
  assertEquals(deny(`cat > a <<'EOF'\nx\nEOF\ncat b`), null);            // 非同檔
});

Deno.test("printDisguiseDeny: setup 豁免 / false / ! true", () => {
  assertEquals(deny(`mkdir -p /tmp && cat > x <<'EOF'\nconsole.log("f")\nEOF\n&& node x`), "write-exec");
  assertEquals(deny(`cd /tmp; cat > x <<'EOF'\nconsole.log("f")\nEOF\nnode x`), "write-exec");
  assertEquals(deny(`false && cat > x && node x`), null);
  assertEquals(deny(`! true && cat > x <<'EOF'\nconsole.log("f")\nEOF\n&& node x`), null);
});

Deno.test("printDisguiseDeny: pipe（D）", () => {
  assertEquals(deny(`echo 'console.log(1)' | node`), "pipe");
  assertEquals(deny(`grep x f | node`), null);
  assertEquals(deny(`echo 'console.log(1)' | node < real.js`), null);   // fd0 蓋過
  assertEquals(deny(`node`), null);                                     // 裸 node 非 pipe → 非載具
});
```

> 註：heredoc 換行/續行以 unbash 實際解析為準；若某案例的 AST 形狀致 `deny` 結果不符，優先確認 spec §4.4 意圖，再對齊實作（fail-safe：不確定 → null）。setup 案例的 `&&\n` 換行寫法若解析異常，改為單行 `&&` 連接。

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: FAIL（`printDisguiseDeny` 未匯出）。

- [ ] **Step 3: 實作自足走訪 + 複合偵測 + 兩階段判定**

在 `src/engine/print_only.ts` 新增（走訪結構鏡射 `walk.ts`；只做碳基分類、不改 walk）：

```typescript
import type {
  AndOr, Command, CompoundList, Node, Pipeline, Script, Statement, Word,
} from "../deps.ts";
import type { CwdState } from "../types.ts";
import { applyCd, isCd } from "./cwd.ts";
import { normalizeAbsolute } from "./scope.ts";
import type { PrintDisguiseKind } from "../rules/types.ts";
import { commandOutput, echoOutput, printfOutput } from "./static_output.ts";

type Role = "leaf" | "write-exec" | "pipe" | "setup" | "none";
const SETUP = new Set(["mkdir", "cd", "true", ":"]);

interface Leaf {
  inv: CommandInvocation;
  role: Role;
  carrier: "shell" | "interp" | null; // 供 kind 判定
}

interface WriteInfo { path: string; content: string | null; cwd: CwdState; } // content=null → cat-readback 內容用

/** 聚合入口（spec §4.4）：回命中 kind 或 null。單一自足走訪、兩階段。 */
export function printDisguiseDeny(
  script: Script,
  initialCwd: CwdState,
): { kind: PrintDisguiseKind } | null {
  const leaves: Leaf[] = [];
  let hasWriteExecComposite = false;

  // ── 階段 1：走訪分類 ──
  const walkSeq = (statements: Statement[], startCwd: CwdState): CwdState => {
    let cwd = startCwd;
    let prevWrite: WriteInfo | null = null;
    for (const stmt of statements) {
      const negated = stmt.negated === true; // unbash Statement.negated（若無此欄則恆 false）
      cwd = walkNode(stmt.command, cwd, negated, () => prevWrite, (w) => { prevWrite = w; });
    }
    return cwd;
  };

  const walkNode = (
    node: Node,
    cwd: CwdState,
    negated: boolean,
    getPrev: () => WriteInfo | null,
    setPrev: (w: WriteInfo | null) => void,
  ): CwdState => {
    switch (node.type) {
      case "Command": {
        const inv = toInv(node, cwd);
        const leaf = classifyLeaf(inv, negated, getPrev());
        if (leaf.role === "write-exec") hasWriteExecComposite ||= isWriteExecInterp(leaf);
        leaves.push(leaf);
        // 更新 prevWrite：此葉若為靜態 WRITE 則設，否則清（非緊鄰即斷）
        setPrev(detectWrite(inv, cwd));
        return isCd(node) ? applyCd(node, cwd) : cwd;
      }
      case "AndOr": {
        // && / ; 同序列傳 prevWrite；|| 邊界重置 adjacency（但覆蓋照納）
        let cur = cwd;
        let localPrev: WriteInfo | null = getPrev();
        for (let k = 0; k < node.commands.length; k++) {
          const isOr = k > 0 && node.operators?.[k - 1] === "||"; // 若 unbash 提供 operators
          if (isOr) localPrev = null;
          cur = walkNode(node.commands[k], cur, negated, () => localPrev, (w) => { localPrev = w; });
        }
        setPrev(localPrev);
        return cur;
      }
      case "Pipeline": {
        detectPipe(node, cwd);           // 標記 producer/consumer 複合成員
        setPrev(null);                   // pipe 不參與 WRITE→EXEC adjacency
        return cwd;
      }
      case "Subshell":
        walkSeq(node.body.commands, cwd);
        setPrev(null);
        return cwd;
      case "BraceGroup":
        setPrev(null);
        return walkSeq(node.body.commands, cwd);
      case "CompoundList":
        return walkSeq((node as CompoundList).commands, cwd);
      case "If":
        walkSeq(node.clause.commands, cwd);
        walkSeq(node.then.commands, cwd);
        if (node.else) node.else.type === "If"
          ? walkNode(node.else, cwd, false, () => null, () => {})
          : walkSeq(node.else.commands, cwd);
        setPrev(null);
        return cwd;
      case "For":
      case "Select":
        walkSeq(node.body.commands, cwd);
        setPrev(null);
        return cwd;
      case "While":
        walkSeq(node.clause.commands, cwd);
        walkSeq(node.body.commands, cwd);
        setPrev(null);
        return cwd;
      case "Case":
        for (const it of node.items) walkSeq(it.body.commands, cwd);
        setPrev(null);
        return cwd;
      case "Statement":
        return walkNode(node.command, cwd, node.negated === true || negated, getPrev, setPrev);
      default:
        setPrev(null);
        return cwd;
    }
  };

  walkSeq(script.commands, initialCwd);

  // ── 階段 2：判定 ──
  if (leaves.length === 0) return null;
  let sawCarrier = false;
  for (const lf of leaves) {
    const covered = lf.role === "leaf" || lf.role === "write-exec" || lf.role === "pipe" ||
      (lf.role === "setup" && hasWriteExecComposite);
    if (!covered) return null;                      // (a) 覆蓋失敗
    if (lf.carrier !== null || lf.role === "write-exec" || lf.role === "pipe") sawCarrier = true;
  }
  if (!sawCarrier) return null;                     // (b) 至少一 print 載具
  return { kind: pickKind(leaves) };

  // ── 內部 helper ──
  function classifyLeaf(inv: CommandInvocation, negated: boolean, prev: WriteInfo | null): Leaf {
    // WRITE→EXEC(a)(b)：此葉為 EXEC、prev 為緊鄰 WRITE、同檔
    const exec = matchExec(inv, prev);
    if (exec) return { inv, role: "write-exec", carrier: null };
    const carrier = leafCarrier(inv);
    if (carrier) return { inv, role: "leaf", carrier };
    if (!negated && inv.name !== null && SETUP.has(inv.name) && inv.assignments.length === 0) {
      return { inv, role: "setup", carrier: null };
    }
    return { inv, role: "none", carrier: null };
  }

  function isWriteExecInterp(_leaf: Leaf): boolean { return true; } // 任一 write-exec 皆觸發 setup 豁免

  /** EXEC 配對：直譯器執行同檔（a，內容過 payload）或 cat/tac 讀回同檔（b，任意靜態文字）。 */
  function matchExec(inv: CommandInvocation, prev: WriteInfo | null): boolean {
    if (prev === null || inv.assignments.length > 0) return false;
    // (a) 直譯器 script-exec、進入點 == P、WRITE 內容過 payloadIsAllStaticPrint
    const r = recognizeInterpreter(inv);
    if (r && r.form.kind === "script" && r.form.entrypoint !== null) {
      if (!sameFile(r.form.entrypoint, inv.cwd, prev.path, prev.cwd)) return false;
      return prev.content !== null && payloadIsAllStaticPrint(prev.content, r.lang);
    }
    // (b) cat/tac 讀回：唯一操作元 == P、無蓋過 fd0；WRITE 內容任意可還原（content 非 null 即可）
    if ((inv.name === "cat" || inv.name === "tac") && prev.content !== null) {
      const operand = soleReadOperand(inv);
      if (operand !== null && sameFile(operand, inv.cwd, prev.path, prev.cwd)) return true;
    }
    return false;
  }

  /** 偵測此葉是否為靜態 WRITE（cat/tac/echo/printf、唯一有效 fd1 截斷 `>`/`>|` 到靜態路徑、內容可還原）。 */
  function detectWrite(inv: CommandInvocation, cwd: CwdState): WriteInfo | null {
    if (inv.name === null || inv.assignments.length > 0) return null;
    if (inv.name !== "cat" && inv.name !== "tac" && inv.name !== "echo" && inv.name !== "printf") return null;
    const wr = soleTruncWrite(inv.redirects);
    if (wr === null) return null;
    const content = writeContent(inv);
    return { path: wr, content, cwd };
  }

  /** WRITE 內容還原：cat/tac 從 heredoc body；echo/printf 從輸出。回 null（無法還原）→ 仍可作 cat-readback 的 WRITE？
   *  spec：cat-readback 只需「可靜態還原文字」；故 content=null 代表不可還原 → 不成對。 */
  function writeContent(inv: CommandInvocation): string | null {
    const cmd = invToCommand(inv);
    if (inv.name === "echo") return echoOutput(cmd);
    if (inv.name === "printf") return printfOutput(cmd);
    // cat/tac 寫檔：body 即寫入內容（原序，因為是「寫」不是「印」；tac 的反轉只在其 stdout，寫檔時 tac 也反轉）
    return commandOutput(cmd);
  }

  function detectPipe(node: Pipeline, cwd: CwdState): void {
    const stmts = node.commands;
    if (stmts.length !== 2) {
      // 多段：全部當一般葉走訪（非 pipe 複合）
      for (const s of stmts) walkNode(s.command, cwd, false, () => null, () => {});
      return;
    }
    const prodCmd = leafCommandOf(stmts[0]);
    const consCmd = leafCommandOf(stmts[1]);
    if (prodCmd && consCmd) {
      const prodInv = toInv(prodCmd, cwd);
      const consInv = toInv(consCmd, cwd);
      const source = producerOutput(prodInv);
      const r = recognizeInterpreter(consInv);
      const consStdinClean = consInv.assignments.length === 0 && r !== null &&
        r.form.kind === "stdin" && !hasFd0Override(consInv);
      if (source !== null && consStdinClean && payloadIsAllStaticPrint(source, r.lang)) {
        leaves.push({ inv: prodInv, role: "pipe", carrier: null });
        leaves.push({ inv: consInv, role: "pipe", carrier: null });
        return;
      }
    }
    // 不成對：兩段當一般葉分類
    for (const s of stmts) walkNode(s.command, cwd, false, () => null, () => {});
  }

  function pickKind(all: Leaf[]): PrintDisguiseKind {
    // 優先序 write-exec > cat-readback > pipe > interp-inline > shell-print
    const hasWE = all.some((l) => l.role === "write-exec" && weIsInterp(l));
    if (hasWE) return "write-exec";
    if (all.some((l) => l.role === "write-exec")) return "cat-readback";
    if (all.some((l) => l.role === "pipe")) return "pipe";
    if (all.some((l) => l.carrier === "interp")) return "interp-inline";
    return "shell-print";
  }
  function weIsInterp(l: Leaf): boolean {
    const r = recognizeInterpreter(l.inv);
    return r !== null && r.form.kind === "script";
  }
}
```

補上本檔會用到的小 helper（若尚未存在）：

```typescript
/** 從 Pipeline 段取葉 Command（僅單一簡單指令，否則 null）。 */
function leafCommandOf(stmt: Statement): Command | null {
  return stmt.command.type === "Command" ? stmt.command as Command : null;
}

/** producer 靜態輸出（echo/printf 靜態 或 cat/tac heredoc）。 */
function producerOutput(inv: CommandInvocation): string | null {
  const cmd = invToCommand(inv);
  if (inv.name === "echo") return echoOutput(cmd);
  if (inv.name === "printf") return printfOutput(cmd);
  if (inv.name === "cat" || inv.name === "tac") return commandOutput(cmd);
  return null;
}

/** 唯一「有效 fd1 截斷寫」目標路徑（`>`/`>|` 靜態路徑；`>>`/多重/`1>&2` → null）。 */
function soleTruncWrite(redirects: CommandInvocation["redirects"]): string | null {
  const fd1 = redirects.filter((r) =>
    (r.operator === ">" || r.operator === ">|" || r.operator === ">>" || r.operator === "&>" || r.operator === ">&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 1)
  );
  if (fd1.length !== 1) return null;
  const r = fd1[0];
  if (r.operator !== ">" && r.operator !== ">|") return null; // append/其他 → 非 WRITE
  const p = r.target ? staticValue(r.target) : null;
  return p;
}

/** cat/tac 的唯一讀取操作元（無旗標、恰一個靜態路徑）；否則 null。 */
function soleReadOperand(inv: CommandInvocation): string | null {
  const ops: string[] = [];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    if (v.startsWith("-") && v !== "--") continue; // 略過旗標
    ops.push(v);
  }
  return ops.length === 1 ? ops[0] : null;
}

/** 消費端是否有蓋過 pipe 的 fd0 重導向。 */
function hasFd0Override(inv: CommandInvocation): boolean {
  return inv.redirects.some((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
}

/** 同檔比對：以各自 cwd 快照 normalizeAbsolute 後字面相等。 */
function sameFile(pathA: string, cwdA: CwdState, pathB: string, cwdB: CwdState): boolean {
  const a = resolveForCompare(pathA, cwdA);
  const b = resolveForCompare(pathB, cwdB);
  if (a === null || b === null) return a === b && a !== null;
  return a === b;
}
function resolveForCompare(p: string, cwd: CwdState): string | null {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return normalizeAbsolute(p);
  if (cwd.kind === "known") return normalizeAbsolute(cwd.path + "/" + p);
  return "REL:" + p; // cwd unknown：相同相對字串視為同檔（同 cwd）；一絕對一相對 → 不等
}

/** 把 CommandInvocation 還原成 Command 視圖供 static_output 使用（借重原 AST；此處以最小欄位重建）。 */
function invToCommand(inv: CommandInvocation): Command {
  return { type: "Command", name: undefined, suffix: inv.argv, prefix: inv.assignments, redirects: inv.redirects } as unknown as Command;
}

/** 由 Command 建 CommandInvocation（供走訪；含 name/argv/prefix/redirects/cwd）。 */
function toInv(cmd: Command, cwd: CwdState): CommandInvocation {
  return {
    name: cmd.name ? staticValue(cmd.name) : null,
    argv: cmd.suffix,
    assignments: cmd.prefix,
    redirects: cmd.redirects,
    cwd,
  };
}
```

> 實作備註（**務必核對 unbash 型別**）：
> - `Statement.negated`、`AndOr.operators` 若 unbash 未提供，改用 `parse` 出來的實際欄位；`negated` 缺失時 `! true` 排除可退化為「`!` 前綴的 leaf 不算 setup」的其他偵測，或先讓對應測試標記為已知邊界（但 spec 要求 `! true` 排除，需確認欄位）。**動手前先 `deno test --allow-env` 一支小探針印出 `parse("! true && x").commands[0]` 結構確認欄位名。**
> - `echoOutput`/`printfOutput`/`commandOutput` 需能吃「以 argv/redirects 重建的 Command」；若 `static_output` 的函式簽名是 `Command`，`invToCommand` 的最小重建須含 `suffix`/`prefix`/`redirects`。若不便重建，改為讓 `static_output` 也提供吃 `CommandInvocation` 的多載，二擇一、以能通過測試為準。
> - `invToCommand` 的 `name: undefined` 會讓 `echoOutput` 內 `toInv(cmd).name` 為 null → 誤判。**修正：`invToCommand` 應保留原 `cmd.name`**；實作時直接把走訪中的原 `Command` 節點傳給 `writeContent`/`producerOutput`（保留原 AST 節點引用），而非用 `invToCommand` 丟失 name。在 `walkNode` 的 Command case 與 `detectPipe` 中把原 `node`/`prodCmd`/`consCmd` 一併帶入 helper。

- [ ] **Step 4: 先寫欄位探針、確認 unbash 結構，再實作**

Run（探針，確認 `negated`/`operators`/redirect `fileDescriptor` 欄位）:
```bash
deno eval 'import {parse} from "npm:unbash@4.0.1"; console.log(JSON.stringify(parse("! true && cat > x <<EOF\nA\nEOF\ncat x"), null, 1))' 2>&1 | head -80
```
依實際欄位名調整 `walkNode`/`detectWrite`/`matchExec` 的欄位存取（redirect 的 fd 欄位、Statement 否定、AndOr 運算子）。

- [ ] **Step 5: 跑測試確認通過**

Run: `deno test --allow-env src/engine/print_only_test.ts`
Expected: PASS。逐案對照 spec §4.4 表；fail-safe 方向錯（誤 deny）必須修正，漏 deny（under）可接受但盡量對齊。

- [ ] **Step 6: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(engine): composite carriers + printDisguiseDeny two-phase aggregate (gate ③)"
```

---

## Task 7: `evaluate.ts` — 接線閘②/閘③、no-op 重排、移除舊 reason

**Files:**
- Modify: `src/engine/evaluate.ts`
- Modify: `src/rules/types.ts`（移除 `printOnlyDenyReason`、`functionShadowReason`）
- Test: `src/engine/evaluate_test.ts`

把 evaluate 改為：閘①(sleep) → 閘②(名稱重定義 deny) → no-op allow → 閘③(printDisguiseDeny) → combine。移除舊閘②(isAllPrintOnly)、舊閘③(函式遮蔽 ask)。

- [ ] **Step 1: 寫失敗/回歸測試**

在 `src/engine/evaluate_test.ts` 末尾新增（沿用檔案既有 `evaluate` 呼叫 helper；若無，仿造）：

```typescript
import { evaluate } from "./evaluate.ts";
const ROOT = "/proj";
const CWD_E = { kind: "known", path: "/proj" } as const;
function verdict(src: string) {
  return evaluate(src, ROOT, CWD_E).verdict;
}

Deno.test("evaluate 閘②：名稱重定義 → deny", () => {
  assertEquals(verdict("f(){ :; }; echo 假"), "deny");
  assertEquals(verdict("f(){:;}"), "deny");           // 純函式定義（no-op 之後）
  assertEquals(verdict("alias grep=x; grep y"), "deny");
  assertEquals(verdict("builtin alias x=y"), "deny");
});

Deno.test("evaluate 閘③：print 偽裝 → deny；洗白 → 非 deny", () => {
  assertEquals(verdict("echo a; echo b"), "deny");
  assertEquals(verdict(`node -e 'console.log("f")'`), "deny");
  assertEquals(verdict("ls; echo 假"), "ask");         // 洗白：落既有判定（ls 非 allowlist → ask）
});

Deno.test("evaluate：no-op 空指令仍 allow", () => {
  assertEquals(verdict(""), "allow");
});

Deno.test("evaluate：函式資料寫檔不誤 deny（落寫入重導向 ask）", () => {
  assertEquals(verdict("cat > x.sh <<'EOF'\nf(){ :; }\nEOF"), "ask");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/engine/evaluate_test.ts`
Expected: FAIL（`f(){:;}` 目前回 allow(no-op) 或 ask，`node -e` 目前非 deny）。

- [ ] **Step 3: 改寫 `evaluate.ts`**

Replace `src/engine/evaluate.ts` 內容為：

```typescript
import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { hasAliasRedefinition, hasExecutableFunctionDefinition } from "./walk.ts";
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
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    // 閘①（deny）：任何字面 sleep 葉
    if (invocations.some((inv) => inv.name === "sleep")) {
      return { verdict: "deny", reason: pollingDenyReason() };
    }
    // 閘②（deny）：名稱重定義（函式定義 node-based / alias 類 name-based）
    if (hasExecutableFunctionDefinition(script)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("function") };
    }
    if (hasAliasRedefinition(invocations)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("alias") };
    }
    // no-op：閘②之後才判（純函式定義已於閘② deny）
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    // 閘③（deny）：統一 print-only 載具偽裝
    const hit = printDisguiseDeny(script, initialCwd);
    if (hit) {
      return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

- [ ] **Step 4: 移除 `rules/types.ts` 的 `printOnlyDenyReason` 與 `functionShadowReason`**

在 `src/rules/types.ts` 刪除 `printOnlyDenyReason`、`functionShadowReason` 兩個函式（已無使用者）。

- [ ] **Step 5: 移除 `print_only.ts` 的 `isAllPrintOnly` 死碼（若已無使用者）**

grep 確認：`grep -rn "isAllPrintOnly\|isPrintOnlyForm" src/`。若 `isPrintOnlyForm` 仍被 `leafCarrier` 使用則保留；`isAllPrintOnly` 若無人用則刪除，並移除 print_only_test.ts 中僅測 `isAllPrintOnly` 的案例（改由 `printDisguiseDeny` 覆蓋）。

- [ ] **Step 6: 跑測試確認通過（全套）**

Run: `deno task test`
Expected: PASS（全部；含既有 classify/main/walk 等）。若既有 print_only_test.ts 有斷言 `f(){:;}; echo 假` 為 deny 的舊案例，改斷言仍 deny（現由閘②）；斷言 `echo 假` deny 者仍 deny（閘③）。

- [ ] **Step 7: check + lint + commit**

```bash
deno task check && deno task lint
git add src/engine/evaluate.ts src/engine/evaluate_test.ts src/rules/types.ts src/engine/print_only.ts src/engine/print_only_test.ts
git commit -m "feat(engine): wire gate ② (name redefinition) + gate ③ (printDisguiseDeny); reorder no-op"
```

---

## Task 8: `main_test.ts` — e2e（不可升級 / no-side-effect / migration）

**Files:**
- Modify: `src/main_test.ts`

驗證 spec §7.6/§7.7：閘②/③ 命中不可由 settings 升級；deny 為 pre-execution、無檔案副作用；跨呼叫拆分邊界。

- [ ] **Step 1: 新增 e2e 測試**

在 `src/main_test.ts` 末尾新增（沿用既有 `runHook` helper）：

```typescript
Deno.test("e2e: print 偽裝 / 名稱重定義 → deny，exit 0", async () => {
  for (const command of [
    `node -e 'console.log("fake")'`,
    "echo a; echo b",
    "f(){ :; }; echo done",
    "alias grep=x; grep foo",
    `cat > /tmp/q.txt <<'EOF'\ndead\nEOF\ncat /tmp/q.txt`,
  ]) {
    const out = await runHook({ tool_name: "Bash", tool_input: { command }, cwd: "/proj" }, "/proj");
    assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", command);
  }
});

Deno.test("e2e: 真實運算不 deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: `node -e 'console.log(1+1)'` }, cwd: "/proj" },
    "/proj",
  );
  const d = JSON.parse(out).hookSpecificOutput.permissionDecision;
  assertEquals(d !== "deny", true);
});

Deno.test("e2e: pre-execution 無副作用（deny 時預建檔不變）", async () => {
  const dir = await Deno.makeTempDir();
  const f = `${dir}/x.mjs`;
  await Deno.writeTextFile(f, "ORIGINAL");
  const before = (await Deno.stat(f)).mtime?.getTime();
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: `cat > ${f} <<'EOF'\nconsole.log("f")\nEOF\nnode ${f}` }, cwd: dir },
    dir,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  assertEquals(await Deno.readTextFile(f), "ORIGINAL");           // 內容不變（hook 不執行 leaf）
  assertEquals((await Deno.stat(f)).mtime?.getTime(), before);    // mtime 不變
  await Deno.remove(dir, { recursive: true });
});
```

> 註：no-side-effect 測試須用真實可寫的臨時目錄作 `cwd`/`CLAUDE_PROJECT_DIR`，使 cat-write 落專案內（否則落中央前置 ask 而非閘③ deny——但即使 ask，hook 仍不執行、檔案照樣不變；此測試核心是「檔案不變」，deny/ask 皆可，斷言改為 `!== undefined` 亦可。以能穩定綠燈為準）。

- [ ] **Step 2: 跑 e2e 測試確認通過**

Run: `deno test --allow-run --allow-env --allow-read --allow-write --allow-sys=uid src/main_test.ts`
Expected: PASS。（no-side-effect 測試需 `--allow-write` 建臨時檔；若 `deno task test` 未含 `--allow-write`，此檔單獨跑時補上，或改用 scratchpad 既有路徑。）

- [ ] **Step 3: commit**

```bash
git add src/main_test.ts
git commit -m "test(e2e): unupgradeable deny + pre-execution no-side-effect for gate ②/③"
```

---

## Task 9: CLAUDE.md 同步 ＋ build ＋ operational verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md（deny 三類→四類、架構管線、已接受繞道）**

依 spec §6 改 `CLAUDE.md`：
- 「這是什麼」：deny 由三類擴為四類，加入「④ 名稱重定義（函式定義＋alias 類）」；「整鏈 print-only 偽裝」定義擴充為跨載具（直譯器 inline/heredoc/pipe/寫檔→執行、cat 讀回兩步偽裝）。
- 「架構（評估管線）」：閘序改 `① sleep → ② 名稱重定義 → no-op → ③ 統一 print 載具 → classify`；列出新模組 `static_output.ts`／`interp_payload.ts`／`print_only.ts`（載具框架）與 walk.ts 兩 helper。
- 「核心不變量」：deny 四類；閘②/③ classify 前短路、不可升級。
- 「已接受繞道」：node/python 裸 all-static-print 改硬 deny；兩步偽裝改硬 deny（cat 讀回，唯一 over-deny）；混載具全 print 改 deny；`ls; echo 假`/`ls; node -e print` 洗白維持不 deny（使用者定案）；函式定義＋alias → deny（取代函式遮蔽 ask）；其他 mutator（hash/enable/PATH/source）為 out-of-scope。

（依 CLAUDE.md 既有結構就地融入，不新增與現有重複的章節。）

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

- [ ] **Step 4: operational verification（餵 JSON 給 binary，確認真實行為）**

依序執行並確認 `permissionDecision`（`CLAUDE_PROJECT_DIR` 指向臨時可寫目錄，設 `PROJ=$(mktemp -d)`）：

```bash
PROJ=$(mktemp -d)
# 1) 直譯器痛點 → deny
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cat > '"$PROJ"'/v.mjs <<'"'"'EOF'"'"'\nconsole.log(\"fake\")\nEOF\nnode '"$PROJ"'/v.mjs"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：deny、reason 為 write-exec；exit 0

# 2) 兩步偽裝 → deny（cat-readback）
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cat > '"$PROJ"'/q.txt <<'"'"'EOF'"'"'\ndead\nEOF\ncat '"$PROJ"'/q.txt"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：deny、reason cat-readback

# 3) 函式定義 → deny
echo '{"tool_name":"Bash","tool_input":{"command":"f(){ :; }; echo done"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：deny（function）

# 4) alias → deny
echo '{"tool_name":"Bash","tool_input":{"command":"alias grep=x; grep foo"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：deny（alias）

# 5) 真實運算 → 非 deny
echo '{"tool_name":"Bash","tool_input":{"command":"node -e '"'"'console.log(1+1)'"'"'"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：非 deny（ask，除非 settings 有 Bash(node *)）

# 6) 洗白維持不 deny
echo '{"tool_name":"Bash","tool_input":{"command":"ls; echo done"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：非 deny

# 7) 寫含函式的 shell script 不誤 deny
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"cat > '"$PROJ"'/d.sh <<'"'"'EOF'"'"'\ndeploy(){ echo hi; }\nEOF"},"cwd":"'"$PROJ"'"}' \
  | CLAUDE_PROJECT_DIR="$PROJ" ./dist/permission-checker
# 期望：非 deny（落寫入重導向 ask）
rm -rf "$PROJ"
```

逐項比對期望；任何「危險形式未 deny」或「安全形式被 deny」都是 regression，回對應 Task 修正後重跑。

- [ ] **Step 5: commit**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md - deny four categories, gate ②/③ pipeline, accepted bypasses"
```

---

## 完成準則

- `deno task check && deno task lint && deno task test` 全綠。
- `deno task build` 成功、operational verification 七項期望全符。
- spec §7 的行為對照（allow/ask/deny 三面 + 邊界）於單元/整合/e2e 測試皆有對應斷言。
- deny 四類（遞迴根 / sleep / 名稱重定義 / print 偽裝）、閘②③ 不可由 `permissions.allow` 升級。
