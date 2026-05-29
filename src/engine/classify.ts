import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { isWithin, resolvePath } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";

/** 對單一指令呼叫判定 allow / ask。 */
export function classify(inv: CommandInvocation, root: string): RuleVerdict {
  if (inv.name === null) return ask("動態指令名，無法判定");

  const rule = lookupRule(inv.name);
  if (!rule) return ask(`未列入 allowlist 的指令：${inv.name}`);

  // 中央前置規則之一：cwd 範圍（known 但落在專案外）
  if (inv.cwd.kind === "known" && !isWithin(root, inv.cwd.path)) {
    return ask(`工作目錄超出專案範圍：${inv.cwd.path}`);
  }
  // 中央前置規則之二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, root),
  });
}
