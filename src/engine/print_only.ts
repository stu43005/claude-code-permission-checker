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
