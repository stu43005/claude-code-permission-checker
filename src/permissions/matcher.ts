import type { CommandInvocation } from "../types.ts";
import { staticValue } from "../engine/word.ts";
import { canonicalizeExecPath } from "../engine/scope.ts";
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

/** 以 nameOf 轉換執行檔名後還原指令字串；null 條件與原 reconstructCommand 相同。 */
function reconstructWith(inv: CommandInvocation, nameOf: (name: string) => string): string | null {
  if (inv.name === null) return null;
  if (inv.assignments.length > 0) return null;
  const parts: string[] = [nameOf(inv.name)];
  for (const w of inv.argv) {
    const v = staticValue(w);
    if (v === null) return null;
    parts.push(v);
  }
  return parts.join(" ");
}

/**
 * 把 invocation 還原成單一可比對指令字串。
 * - name === null（動態指令名）→ null
 * - 有賦值前綴（VAR=val）→ null（env 前綴可改變行為，且 Claude Code 字面比對亦不會命中 cmd:*）
 * - 任一 argv 動態（變數 / $() / 未引號 glob，staticValue 回 null）→ null
 * 否則回 [name, ...argv 靜態值].join(" ")。引號值已去引號、不重新加引號；不含重導向。
 */
export function reconstructCommand(inv: CommandInvocation): string | null {
  return reconstructWith(inv, (name) => name);
}

/**
 * 正規化執行檔名後的指令字串（canonCmd）。argv 不正規化。
 * 指令側一律以 home=null 呼叫 canonicalizeExecPath：絕不展開指令側的 `~`。指令字串無法
 * 區分引號與否，而引號 `"~/x"` 在 bash 不展開；展開會把字面 `~` 檔名誤當成家目錄絕對路徑
 * 而誤升級（permission bypass）。`//` 折疊與 `.` 段移除不需 home，故指令側等價正規化照常運作。
 */
function reconstructCanonical(inv: CommandInvocation): string | null {
  return reconstructWith(inv, (name) => canonicalizeExecPath(name, null));
}

/** 對 pattern 的第一個空白前 head token 套 canonicalizeExecPath，其餘原樣。 */
function canonicalizeHead(s: string, home: string | null): string {
  const sp = s.indexOf(" ");
  if (sp === -1) return canonicalizeExecPath(s, home);
  return canonicalizeExecPath(s.slice(0, sp), home) + s.slice(sp);
}

/** 產生 pattern 的正規化版本（canonPat），head token 正規化、其餘原樣。 */
function canonicalizePattern(pat: BashPattern, home: string | null): BashPattern {
  switch (pat.kind) {
    case "exact":
      return { kind: "exact", text: canonicalizeHead(pat.text, home) };
    case "prefix-boundary":
      return { kind: "prefix-boundary", prefix: canonicalizeHead(pat.prefix, home) };
    case "prefix-loose":
      return { kind: "prefix-loose", prefix: canonicalizeHead(pat.prefix, home) };
  }
}

/** canonPat 的「執行檔比對長度」：exact 取 text、prefix 類取 prefix 的長度。 */
function patternMatchLen(pat: BashPattern): number {
  return pat.kind === "exact" ? pat.text.length : pat.prefix.length;
}

/**
 * union 命中：(rawCmd vs rawPat) ∨ (canonCmd vs canonPat)，跨整組 patterns。
 * canon 分支加「執行檔邊界閘」：canonPat 的比對長度不得超過 canon 執行檔名長度
 * （canonExecLen），使 canon 匹配侷限於 exec token、不跨入 argv。否則 exec 名的 `//`
 * 折疊後與後續 argv 拼接，會讓含空白的執行檔路徑 pattern 跨越 exec/argv 邊界誤配
 * （指令實際執行的是較短的 exec）。raw 分支不受閘影響、完整保留；閘對 deny/ask/allow
 * 對稱施加，只移除 canon 跨界匹配，相對官方 baseline 既不弱化 deny 也不放寬 allow。
 */
function matchesRuleSet(
  rawCmd: string,
  canonCmd: string,
  canonExecLen: number,
  pats: BashPattern[],
  home: string | null,
): boolean {
  return pats.some((p) => {
    if (matchesPattern(rawCmd, p)) return true;
    const cp = canonicalizePattern(p, home);
    return patternMatchLen(cp) <= canonExecLen && matchesPattern(canonCmd, cp);
  });
}

/**
 * 綜合判定：此 invocation 是否應依 settings 升級為 allow。
 * union 比對：指令與 pattern 各保留 raw / canon 兩形式，命中 ⟺ (rawCmd vs rawPat) ∨ (canonCmd vs canonPat)。
 * 三組 deny/ask/allow 對稱套用；raw↔raw 完整重現現行行為，正規化只增不減命中，故不弱化任何 deny/ask。
 * canon 分支加「執行檔邊界閘」：canonPat 長度不得超過 canonExecLen，使 canon 匹配侷限於 exec token。
 */
export function settingsAllows(
  inv: CommandInvocation,
  rules: PermissionRules,
  home: string | null,
): boolean {
  const rawCmd = reconstructCommand(inv);
  if (rawCmd === null) return false;
  if (inv.name === null) return false; // rawCmd 非 null 已蘊含，但讓 canonExecName 取值型別安全
  const canonCmd = reconstructCanonical(inv);
  if (canonCmd === null) return false; // 與 rawCmd 同步，理論上不會發生
  const canonExecLen = canonicalizeExecPath(inv.name, null).length;
  if (matchesRuleSet(rawCmd, canonCmd, canonExecLen, rules.bash.deny, home)) return false;
  if (matchesRuleSet(rawCmd, canonCmd, canonExecLen, rules.bash.ask, home)) return false;
  return matchesRuleSet(rawCmd, canonCmd, canonExecLen, rules.bash.allow, home);
}
