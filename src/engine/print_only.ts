import type { CommandInvocation } from "../types.ts";
import type { Word } from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { staticValue } from "./word.ts";
import { payloadIsAllStaticPrint, printExprIsStaticString, type Lang } from "./interp_payload.ts";
import { heredocStdinText, isCatPassthrough, isEchoPrintOnly, isPrintfPrintOnly } from "./static_output.ts";
export { wordPrintEligible } from "./static_output.ts";   // 既有 print_only_test.ts 由 print_only 匯入

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
    case "cat":
    case "tac":
      return isCatPassthrough(inv);
    default:
      return false;
  }
}

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
