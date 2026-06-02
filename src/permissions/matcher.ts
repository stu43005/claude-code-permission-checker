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
