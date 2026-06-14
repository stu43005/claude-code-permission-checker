import type { AssignmentPrefix, Redirect, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import type { PathScope } from "../engine/scope.ts";

/** 由 CommandInvocation 投影建構；name 已確認非 null。 */
export interface RuleContext {
  name: string;
  argv: Word[];
  redirects: Redirect[];
  assignments: AssignmentPrefix[];
  cwd: CwdState;
  /** 對某參數做範圍檢查（內部已綁定 cwd 與 root）。 */
  resolvePath(arg: Word): PathScope;
  /** 對 flag 的路徑值（字串）做範圍檢查。 */
  resolvePathValue(value: string | null): PathScope;
  /** 此參數是否指向磁碟根 / 家目錄根（用於遞迴指令的 deny 判定）。 */
  isDangerousRoot(arg: Word): boolean;
}

export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
}

/** 便利建構子。 */
export const allow = (): RuleVerdict => ({ kind: "allow" });
export const ask = (reason: string): RuleVerdict => ({ kind: "ask", reason });
export const deny = (reason: string): RuleVerdict => ({ kind: "deny", reason });

/** 產生「遞迴遍歷磁碟根/家目錄根」的 deny 理由（會回饋給 agent，故須解釋原因 + 替代）。 */
export function recursiveRootDenyReason(name: string, target: string): string {
  return `已禁止：${name} 會遞迴遍歷磁碟根或家目錄根（${target}）。` +
    `此操作會掃描跨專案、跨使用者的大量檔案，屬資料外洩 / 偵察的高風險行為。` +
    `請改為指定專案內的具體子目錄（例如 ./src），而非 / 或 ~。`;
}
