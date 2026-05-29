import type { AssignmentPrefix, Redirect, Word } from "./deps.ts";

export type Verdict = "allow" | "ask";

/** 指令執行時的有效工作目錄狀態。 */
export type CwdState =
  | { kind: "known"; path: string } // 已正規化的絕對 posix 路徑
  | { kind: "unknown" }; // 無法靜態確定

/** 從 AST 抽取出的單一葉指令呼叫（已附上其執行 cwd）。 */
export interface CommandInvocation {
  /** 靜態解析出的指令名；動態（如 $CMD）為 null。 */
  name: string | null;
  /** unbash 的 suffix（argv）。 */
  argv: Word[];
  /** var=val 前綴。 */
  assignments: AssignmentPrefix[];
  /** 此指令承載的重導向（含繼承自外層 Statement / 複合結構者）。 */
  redirects: Redirect[];
  /** 此指令執行時的有效工作目錄。 */
  cwd: CwdState;
}

/** 引擎最終判定。 */
export interface Decision {
  verdict: Verdict;
  reason: string;
}
