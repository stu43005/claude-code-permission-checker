import type { CommandInvocation } from "../types.ts";
import type { RuleVerdict } from "../rules/types.ts";
import { allow, ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { dangerousRoot, isReadScoped, normalizeAbsolute, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { resolveUrl } from "../permissions/domain_scope.ts";

/**
 * 四條中央前置安全規則（對所有指令通用、不可由 permissions.allow 升級）。
 * 命中任一回不可升級的 `ask`，否則回 `null`。純函式、不碰檔案系統。
 * 呼叫端保證 inv.name !== null（動態指令名已於 classify 先行處理）。
 *
 * 順序安全性：本前置覆寫指令規則的 allow/ask，唯一能越過它先行返回的是指令規則的 deny
 * （更嚴格、安全方向）。指令規則的 evaluate 為純函式、無副作用（已於 2026-06-27 以 grep 稽核
 * src/rules/ 確認無 Deno 檔案系統/子行程 API），故步驟 2 在「危險 cwd/redirect」情境下呼叫
 * rule.evaluate 無 runtime 危害；任何帶中央前置觸發條件的指令永不可能成為 allow。
 */
function centralPreflightAsk(inv: CommandInvocation, scope: ScopeConfig): RuleVerdict | null {
  // 一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）
  if (inv.cwd.kind === "known" && !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  // 二：寫入型重導向
  if (hasWriteRedirect(inv.redirects)) {
    return ask(`${inv.name}：寫入型重導向`);
  }
  // 三：環境變數賦值前綴（LD_PRELOAD/BASH_ENV 等）可改變執行行為
  if (inv.assignments.length > 0) {
    return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);
  }
  // 四：輸入重導向 `<` 的目標路徑須落在允許讀取範圍
  for (const r of inv.redirects) {
    if (r.operator !== "<") continue; // 只查讀檔 `<`；heredoc/here-string 與 fd 複製不在此
    if (!r.target) continue;
    if (resolvePath(r.target, inv.cwd, scope) !== "in-project") {
      return ask(`${inv.name}：輸入重導向讀取超出專案範圍或無法靜態解析（${r.target.value}）`);
    }
  }
  return null;
}

/**
 * 對單一指令呼叫判定 allow / ask / deny。
 *
 * 決策順序：
 *  1. 動態指令名 → 不可升級 ask。
 *  2. 指令規則評估；其硬 deny（遞迴遍歷磁碟根/家目錄根）最優先，不經中央前置、不經升級層。
 *  3. 四條中央前置（通用、不可升級）任一命中 → ask。
 *  4. 可升級 ask：未列入 allowlist、或指令規則自身 ask → 命中 settings allow（未被 deny/ask 命中）則升級。
 *  5. 指令規則 allow → allow。
 */
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
): RuleVerdict {
  const scope: ScopeConfig = {
    root,
    home,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
    trusted: trustedReadRoots,
  };

  // 步驟 1：動態指令名
  if (inv.name === null) return ask("動態指令名，無法判定");

  // 步驟 2：指令規則評估 + 硬 deny 短路（deny 最優先，先於中央前置與升級層）
  const rule = lookupRule(inv.name);
  const ruleVerdict: RuleVerdict | null = rule
    ? rule.evaluate({
      name: inv.name,
      argv: inv.argv,
      redirects: inv.redirects,
      assignments: inv.assignments,
      cwd: inv.cwd,
      resolvePath: (w) => resolvePath(w, inv.cwd, scope),
      resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
      resolveUrl: (v) => resolveUrl(v, rules.webFetch),
      isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
    })
    : null;
  if (ruleVerdict?.kind === "deny") return ruleVerdict;

  // 步驟 3：四條中央前置（通用、不可升級）
  const central = centralPreflightAsk(inv, scope);
  if (central) return central;

  // 步驟 4：可升級 ask（未列入 allowlist 或指令規則自身 ask）
  if (ruleVerdict === null || ruleVerdict.kind === "ask") {
    if (settingsAllows(inv, rules, scope.home)) return allow();
    return ruleVerdict ?? ask(`未列入 allowlist 的指令：${inv.name}`);
  }

  // 步驟 5：指令規則 allow
  return ruleVerdict;
}
