import type { CommandInvocation } from "../types.ts";
import { staticValue } from "../engine/word.ts";
import type { PermissionRules } from "./settings.ts";

/** 解析後的 Bash(...) 規則。prefix / text 經 parseBashRule 保證非空。 */
export type BashPattern =
  | { kind: "exact"; text: string }
  | { kind: "prefix-boundary"; prefix: string }
  | { kind: "prefix-loose"; prefix: string };

/** 解析 "Bash(...)" 規則字串；非 Bash(...) 或無法可靠解析的形式 → null。 */
export function parseBashRule(rule: string): BashPattern | null {
  if (!rule.startsWith("Bash(") || !rule.endsWith(")")) return null;
  const inner = rule.slice("Bash(".length, -1);
  if (inner === "") return null;

  if (inner.endsWith(":*")) {
    const p = inner.slice(0, -2);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-boundary", prefix: p };
  }
  if (inner.endsWith(" *")) {
    const p = inner.slice(0, -2);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-boundary", prefix: p };
  }
  if (inner.endsWith("*")) {
    const p = inner.slice(0, -1);
    if (p === "" || p.includes("*")) return null;
    return { kind: "prefix-loose", prefix: p };
  }
  if (!inner.includes("*")) {
    return { kind: "exact", text: inner };
  }
  return null;
}

/** 單一指令字串是否命中某 pattern。 */
export function matchesPattern(cmd: string, pat: BashPattern): boolean {
  switch (pat.kind) {
    case "exact":
      return cmd === pat.text;
    case "prefix-boundary":
      return cmd === pat.prefix || cmd.startsWith(pat.prefix + " ");
    case "prefix-loose":
      return cmd.startsWith(pat.prefix);
  }
}

/** 是否命中任一 pattern。 */
export function matchesAny(cmd: string, pats: BashPattern[]): boolean {
  return pats.some((p) => matchesPattern(cmd, p));
}

/**
 * 把 invocation 還原成單一可比對指令字串。
 * - name === null（動態指令名）→ null
 * - 有賦值前綴（VAR=val）→ null（env 前綴可改變行為，且 Claude Code 字面比對亦不會命中 cmd:*）
 * - 任一 argv 動態（變數 / $() / 未引號 glob，staticValue 回 null）→ null
 * 否則回 [name, ...argv 靜態值].join(" ")。引號值已去引號、不重新加引號；不含重導向。
 */
export function reconstructCommand(inv: CommandInvocation): string | null {
  if (inv.name === null) return null;
  if (inv.assignments.length > 0) return null;
  const parts: string[] = [inv.name];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    parts.push(v);
  }
  return parts.join(" ");
}

/**
 * 綜合判定：此 invocation 是否應依 settings 升級為 allow。
 *   cmd = reconstructCommand(inv)；null → false
 *   matchesAny(cmd, deny) 或 matchesAny(cmd, ask) → false（完整優先序）
 *   matchesAny(cmd, allow) → true；否則 false
 */
export function settingsAllows(inv: CommandInvocation, rules: PermissionRules): boolean {
  const cmd = reconstructCommand(inv);
  if (cmd === null) return false;
  if (matchesAny(cmd, rules.deny)) return false;
  if (matchesAny(cmd, rules.ask)) return false;
  return matchesAny(cmd, rules.allow);
}
