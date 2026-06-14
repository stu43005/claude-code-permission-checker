import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { allow, ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { dangerousRoot, isReadScoped, normalizeAbsolute, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";

/** 既有的中央前置規則 + allowlist 規則判定。 */
function classifyBuiltin(inv: CommandInvocation, scope: ScopeConfig): RuleVerdict {
  if (inv.name === null) return ask("動態指令名，無法判定");

  const rule = lookupRule(inv.name);
  if (!rule) return ask(`未列入 allowlist 的指令：${inv.name}`);

  // 中央前置規則之一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）
  if (inv.cwd.kind === "known" && !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // 中央前置規則之二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }
  // 中央前置規則之三：環境變數賦值前綴（LD_PRELOAD/BASH_ENV 等）可改變執行行為
  if (inv.assignments.length > 0) {
    return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);
  }

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
    isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
  });
}

/** 對單一指令呼叫判定 allow / ask；builtin 判 ask 時，命中 settings allow（未被 deny/ask 命中）則升級。 */
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
): RuleVerdict {
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: [],
  };
  const v = classifyBuiltin(inv, scope);
  if (v.kind === "deny") return v; // 硬 deny：不經 settingsAllows 升級層
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
}
