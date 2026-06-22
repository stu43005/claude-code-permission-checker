import type { CwdState, Decision } from "../types.ts";
import { parseCommand } from "./parse.ts";
import { walk } from "./walk.ts";
import { definedFunctionNames } from "./walk.ts";
import { isAllPrintOnly } from "./print_only.ts";
import { classify } from "./classify.ts";
import { combine } from "./combine.ts";
import { EMPTY_RULES, type PermissionRules } from "../permissions/settings.ts";
import { functionShadowReason, pollingDenyReason, printOnlyDenyReason } from "../rules/types.ts";

/**
 * 主流程：parse → walk → 逐指令判定 → 合併。
 * 任何例外 → ask（fail-safe）。root 必為有效專案根。
 */
export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
  home: string | null = null,
  trustedReadRoots: string[] = [],
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    // 閘①（deny）：任何字面 sleep 葉指令（含控制流內、命令替換內層）—— 不因遮蔽而豁免
    if (invocations.some((inv) => inv.name === "sleep")) {
      return { verdict: "deny", reason: pollingDenyReason() };
    }
    // 閘②（deny）：整鏈皆 print 形態 —— 不因遮蔽而豁免
    if (isAllPrintOnly(invocations)) {
      return { verdict: "deny", reason: printOnlyDenyReason() };
    }
    // 閘③（ask）：被呼叫的名被同腳本函式遮蔽 → name 分析不可信 → 人工確認
    const fnNames = definedFunctionNames(script);
    if (fnNames.size > 0 && invocations.some((inv) => inv.name !== null && fnNames.has(inv.name))) {
      return { verdict: "ask", reason: functionShadowReason() };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
