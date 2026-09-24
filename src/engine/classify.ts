import type { CommandInvocation } from "../types.ts";
import type { RuleContext, RuleVerdict } from "../rules/types.ts";
import { allow, ask } from "../rules/types.ts";
import { lookupRule } from "../rules/allowlist.ts";
import { buildScopeConfig, dangerousRoot, globMaySelectDangerousRoot, isReadScoped, normalizeAbsolute, resolveGlobPath, resolvePath, resolvePathValue, type ScopeConfig } from "./scope.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { resolveUrl } from "../permissions/domain_scope.ts";
import { staticValue } from "./word.ts";

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
function centralPreflightAsk(
  inv: CommandInvocation,
  scope: ScopeConfig,
  skipCwdCheck: boolean,
): RuleVerdict | null {
  // 一：cwd 範圍。skipCwdCheck 由 classify 依五道護欄算出；規則二/三/四不受影響。
  if (!skipCwdCheck) {
    // 初始 cwd 恆為 known（main.ts 的 initialCwd 缺欄位時 fallback 到專案根），
    // 故 unknown 必然源自鏈內 cd 或 git -C <動態>——即「將在本工具無法確定的目錄執行」。
    // 這正是規則一要防的情形；不擋的話，把 cd 目標寫成動態就能整個跳過範圍檢查。
    if (inv.cwd.kind === "unknown") {
      return ask(`${inv.name}：工作目錄無法靜態確定（鏈內 cd 目標為動態）`);
    }
    if (!isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
      return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
    }
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
  // 缺省 false = 起點不可信 → 永不豁免（fail-safe；既有呼叫端行為不變）
  sessionCwdInScope = false,
  shellHome: string | null = null,
): RuleVerdict {
  const scope: ScopeConfig = buildScopeConfig(root, rules, home, trustedReadRoots, shellHome);

  // 步驟 1：動態指令名
  if (inv.name === null) return ask("動態指令名，無法判定");

  // 步驟 2：指令規則評估 + 硬 deny 短路（deny 最優先，先於中央前置與升級層）
  const rule = lookupRule(inv.name);
  const ctx: RuleContext = {
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
    resolveUrl: (v) => resolveUrl(v, rules.webFetch),
    isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
    resolveGlobPath: (w) => resolveGlobPath(w, inv.cwd, scope),
    globMaySelectDangerousRoot: (w) => globMaySelectDangerousRoot(w, inv.cwd, scope.home),
  };
  const ruleVerdict: RuleVerdict | null = rule ? rule.evaluate(ctx) : null;
  if (ruleVerdict?.kind === "deny") return ruleVerdict;

  // 護欄 4：argv 必須全為靜態 token。唯一例外是規則自身以 toleratesNonStaticOperand
  // 認定的操作元（本工具的判定完全不讀其內容）。
  const allArgvStatic = inv.argv.every((w) => staticValue(w) !== null);
  const cwdExempt = ruleVerdict?.kind === "allow" && // 護欄 1
    sessionCwdInScope && // 護欄 2（起點可信）
    inv.cwd.kind === "known" &&
    inv.cwd.origin === "chain-cd" && // 護欄 2（鏈內 cd）
    (allArgvStatic || (rule?.toleratesNonStaticOperand?.(ctx) ?? false)) && // 護欄 4
    (rule?.cwdIndependent?.(ctx) ?? false);

  // 步驟 3：四條中央前置（通用、不可升級）
  const central = centralPreflightAsk(inv, scope, cwdExempt);
  if (central) return central;

  // 步驟 4：可升級 ask（未列入 allowlist 或指令規則自身 ask）
  if (ruleVerdict === null || ruleVerdict.kind === "ask") {
    if (settingsAllows(inv, rules, scope.home)) return allow();
    return ruleVerdict ?? ask(`未列入 allowlist 的指令：${inv.name}`);
  }

  // 步驟 5：指令規則 allow
  return ruleVerdict;
}
