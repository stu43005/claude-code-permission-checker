import type { Decision } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";

/** 最弱環節：任一 deny → 整體 deny；否則任一 ask → ask；全部 allow → allow（取首個對應理由）。 */
export function combine(verdicts: RuleVerdict[]): Decision {
  for (const v of verdicts) {
    if (v.kind === "deny") return { verdict: "deny", reason: v.reason };
  }
  for (const v of verdicts) {
    if (v.kind === "ask") return { verdict: "ask", reason: v.reason };
  }
  return { verdict: "allow", reason: "全部指令均通過（唯讀放行或命中 permissions.allow）" };
}
