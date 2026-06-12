import type { AssignmentPrefix, Redirect, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import type { PathScope } from "../engine/scope.ts";
import type { UrlScope } from "../permissions/domain_scope.ts";

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
  /** 對 URL 字串做網域範圍三態判定（內部已綁定 settings 的 WebFetch 規則與 preapproved 清單）。 */
  resolveUrl(value: string): UrlScope;
}

export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
}

/** 便利建構子。 */
export const allow = (): RuleVerdict => ({ kind: "allow" });
export const ask = (reason: string): RuleVerdict => ({ kind: "ask", reason });
