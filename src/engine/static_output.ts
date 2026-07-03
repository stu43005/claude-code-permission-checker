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
