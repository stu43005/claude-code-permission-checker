import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { hasAliasRedefinition, hasExecutableFunctionDefinition, walk } from "./walk.ts";
import { printDisguiseDeny } from "./print_only.ts";
import { classify } from "./classify.ts";
import { combine } from "./combine.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { nameRedefinitionDenyReason, pollingDenyReason, printDisguiseDenyReason } from "../rules/types.ts";
import { buildScopeConfig, isReadScoped, normalizeAbsolute } from "./scope.ts";

/**
 * 主流程：parse → walk → 四閘 → 合併。任何例外 → ask（fail-safe）。
 * 閘序：① sleep → ② 名稱重定義 → no-op → ③ print 偽裝 → classify。
 */
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
  shellHome: string | null = null,
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) return { verdict: "ask", reason: "指令語法無法可靠解析" };
    const invocations = walk(script, initialCwd, root, shellHome);
    if (invocations.some((inv) => inv.name === "sleep")) {
      return { verdict: "deny", reason: pollingDenyReason() };
    }
    if (hasExecutableFunctionDefinition(script)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("function") };
    }
    if (hasAliasRedefinition(invocations)) {
      return { verdict: "deny", reason: nameRedefinitionDenyReason("alias") };
    }
    if (invocations.length === 0) return { verdict: "allow", reason: "無可執行指令（no-op）" };
    const hit = printDisguiseDeny(script, initialCwd);
    if (hit) return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
    const scope = buildScopeConfig(root, rules, home, trustedReadRoots, shellHome);
    const sessionCwdInScope = initialCwd.kind === "known" &&
      isReadScoped(normalizeAbsolute(initialCwd.path), scope);
    return combine(
      invocations.map((inv) =>
        classify(inv, root, rules, home, trustedReadRoots, sessionCwdInScope, shellHome)
      ),
    );
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
