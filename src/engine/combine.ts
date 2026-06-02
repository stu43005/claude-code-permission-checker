import type { Decision } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";

/** 最弱環節：任一 ask → 整體 ask（取首個 ask 原因）；全部 allow → allow。 */
export function combine(verdicts: RuleVerdict[]): Decision {
  for (const v of verdicts) {
    if (v.kind === "ask") return { verdict: "ask", reason: v.reason };
  }
  return { verdict: "allow", reason: "全部指令均通過（唯讀放行或命中 permissions.allow）" };
}
