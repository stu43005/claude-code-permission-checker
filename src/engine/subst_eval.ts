import type { Command, Script, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import { staticValue } from "./word.ts";
import { hasUnquotedLeadingTilde } from "./tilde.ts";

/**
 * 單一指令的靜態求值器。必須是純函式、不碰檔案系統、不丟例外。
 * 任何「輸出可能取決於檔案系統狀態、環境變數或執行期 shell 選項」的情形一律回 null。
 */
export interface SubstEvaluator {
  names: string[];
  /**
   * @param argv 呼叫端已確認全部靜態、且無未加引號 tilde 的引數字串
   * @param cwd  該指令執行時的 cwd（unknown 時需要 cwd 的求值器應回 null）
   */
  evaluate(argv: string[], cwd: CwdState): string | null;
}

/** 已註冊的求值器。指令名重複註冊會在載入時丟錯。 */
const EVALUATORS: SubstEvaluator[] = [];

const INDEX = new Map<string, SubstEvaluator>();
for (const e of EVALUATORS) {
  for (const n of e.names) {
    if (INDEX.has(n)) throw new Error(`duplicate substitution evaluator for: ${n}`);
    INDEX.set(n, e);
  }
}

/** 內層 Script 若恰為「單一簡單指令、無重導向、無賦值前綴、非背景」則回該 Command。 */
function loneSimpleCommand(script: Script | undefined): Command | null {
  if (!script) return null;
  if (script.commands.length !== 1) return null;
  const stmt = script.commands[0];
  if (stmt.background) return null;
  if (stmt.redirects.length > 0) return null;
  const cmd = stmt.command;
  if (cmd.type !== "Command") return null; // pipeline / 控制流 / subshell 一律不求值
  if (cmd.redirects.length > 0) return null;
  if (cmd.prefix.length > 0) return null; // 賦值前綴可改變執行行為
  return cmd;
}

/**
 * 整個 Word 恰為單一 `"$(…)"` 且內層可靜態求值時回結果字串，否則 null。
 *
 * **只接受加了雙引號的形態**：未加引號的 `$(…)` 會被 bash 施以 word splitting 與
 * 空值移除，語義與「求值成單一字串」不同——`cd $(echo -n)` 展開後是零個參數，
 * 實際執行 `cd`（→ $HOME），而非 cd 到空字串。
 */
export function evalSubstitutionWord(word: Word, cwd: CwdState): string | null {
  const parts = word.parts;
  // 資格 1 + 2：恰一個 DoubleQuoted，其內恰一個 CommandExpansion
  if (!parts || parts.length !== 1) return null;
  const quoted = parts[0];
  if (quoted.type !== "DoubleQuoted") return null;
  if (quoted.parts.length !== 1) return null;
  const expansion = quoted.parts[0];
  if (expansion.type !== "CommandExpansion") return null;

  // 資格 3：內層是單一簡單指令
  const cmd = loneSimpleCommand(expansion.script);
  if (cmd === null) return null;

  // 資格 4：指令名靜態且已註冊
  if (!cmd.name) return null;
  const name = staticValue(cmd.name);
  if (name === null) return null;
  const evaluator = INDEX.get(name);
  if (!evaluator) return null;

  // 資格 5：argv 全靜態，且無未加引號 tilde
  const argv: string[] = [];
  for (const w of cmd.suffix) {
    if (hasUnquotedLeadingTilde(w)) return null;
    const v = staticValue(w);
    if (v === null) return null;
    argv.push(v);
  }

  // 資格 6～8
  const out = evaluator.evaluate(argv, cwd);
  if (out === null) return null;
  return resultIsUsable(out) ? out : null;
}

/**
 * 求值結果是否可用。
 * 空字串沒有安全的解釋（bash 語義依引號與否而異：加引號是 cd 到空字串、未加引號是 cd 到 $HOME）；
 * 含換行的多行輸出作為 cd 目標無意義。兩者一律放棄。
 */
export function resultIsUsable(out: string): boolean {
  if (out === "") return false;
  return !out.includes("\n") && !out.includes("\r");
}
