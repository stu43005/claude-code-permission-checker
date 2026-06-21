import type { CommandInvocation } from "../types.ts";
import type { Redirect, Word, WordPart } from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { isStatic, nestedPartIsDynamic, staticValue, topPartIsDynamic } from "./word.ts";

/**
 * 未引號的前導 tilde（`~`、`~/x`、`~user`）是家目錄展開——unbash 不結構化表示它
 * （無 parts、或首個 part 為以 `~` 開頭的 Literal），`isStatic` 只擋 glob 故漏判。
 * 它是動態展開，非靜態吐字 → print 不合格（與命令替換不同，不豁免）。
 */
function hasLeadingTilde(w: Word): boolean {
  if (!w.parts) return w.value.startsWith("~");
  const first = w.parts[0];
  return first?.type === "Literal" && first.value.startsWith("~");
}

/**
 * Word 是否「print 合格」：靜態，或其唯一動態成分為命令替換 $( … )。
 * 變數展開、算術、brace、未引號 glob 字元的 Literal、process substitution → 不合格。
 */
export function wordPrintEligible(w: Word): boolean {
  if (hasLeadingTilde(w)) return false;  // 家目錄展開 → 非靜態吐字
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

/**
 * format 是否含「會做格式化轉換」的轉換符（排除 %s / %b 純字串、字面 %%）。
 * 涵蓋：數值/字元轉換（含 length modifier 如 %ld/%lld/%hd）、Bash 的 %q（shell 引用）、
 * %n（寫入）、以及 %(...)T（strftime 日期）。
 */
function hasFormatterConversion(fmt: string): boolean {
  const stripped = fmt.replace(/%%/g, "");
  return /%[-+ 0#']*[0-9*]*(\.[0-9*]*)?(hh|h|ll|l|L|j|z|t)?[diouxXeEfFgGaAcCqn]/.test(stripped) ||
    /%\([^)]*\)T/.test(stripped);
}

function isCatPassthrough(inv: CommandInvocation): boolean {
  if (hasFileOperand(inv.name, inv.argv)) return false;        // 有檔案操作元 → 讀真實檔
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

/**
 * argv 是否含檔案操作元：考慮 POSIX `--`（其後一律為操作元）。
 * tac 的 `-s` / `--separator` 會吃下一個 token 當分隔符值（cat 的 `-s` 是無值旗標，
 * 故僅對 tac 跳過該值），避免把分隔符值誤判為檔名而漏掉 print-only 的 deny。
 */
function hasFileOperand(name: string | null, argv: Word[]): boolean {
  const skipsValue = name === "tac";
  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i++) {
    const v = staticValue(argv[i]);
    if (!afterDoubleDash && v === "--") { afterDoubleDash = true; continue; }
    if (afterDoubleDash) return true;                          // `--` 之後任何 token = 檔名
    if (v === null || !v.startsWith("-")) return true;         // 動態或非旗標 → 視為檔名
    if (skipsValue && (v === "-s" || v === "--separator")) i++; // 跳過分隔符值 token
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
