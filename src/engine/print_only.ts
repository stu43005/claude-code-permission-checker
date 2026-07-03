import type { CommandInvocation } from "../types.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { isCatPassthrough, isEchoPrintOnly, isPrintfPrintOnly } from "./static_output.ts";
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
