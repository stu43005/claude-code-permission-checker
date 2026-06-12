/** WebFetch(domain:...) 規則化約而來的網域範圍（host 皆已 lowercase、去尾端 `.`）。 */
export interface DomainScope {
  /** 精確 hostname（無萬用字元的規則）。 */
  exact: Set<string>;
  /** `*.suffix` 規則的 suffix：匹配一層或多層子網域，不含裸域本身。 */
  suffixes: string[];
  /** `domain:*`：匹配一切。 */
  all: boolean;
}

/** 空 DomainScope 常數（唯讀共用；要可變的空 scope 請用 emptyDomainScope()）。 */
export const EMPTY_DOMAIN_SCOPE: DomainScope = { exact: new Set(), suffixes: [], all: false };

/** 建立全新可變的空 DomainScope。 */
export function emptyDomainScope(): DomainScope {
  return { exact: new Set(), suffixes: [], all: false };
}

/** settings permissions 三位置的 WebFetch 網域範圍。 */
export interface WebFetchRules {
  allow: DomainScope;
  deny: DomainScope;
  ask: DomainScope;
}

export type DomainRuleEntry =
  | { kind: "exact"; host: string }
  | { kind: "subdomains"; suffix: string }
  | { kind: "all" };

/**
 * 解析 "WebFetch(domain:...)" 規則。比對語意對齊 Claude Code 2.1.173 實際行為：
 * 無萬用字元 = 精確 host；`*.x` = 僅子網域（不含裸域）；`*` = 一切。
 * 其他形式（中段 `*`、含 `/`、含 `:`——涵蓋 scheme/port/IPv6、空字串）→ null（忽略）。
 * 不做 IDN/punycode 轉換：Unicode 規則原樣保存（URL 端恆為 punycode → 永不相等 → 保守 ask）。
 */
export function parseDomainRule(rule: string): DomainRuleEntry | null {
  const m = /^WebFetch\(domain:(.*)\)$/.exec(rule);
  if (m === null) return null;
  let inner = m[1].toLowerCase();
  if (inner === "*") return { kind: "all" };
  let sub = false;
  if (inner.startsWith("*.")) {
    sub = true;
    inner = inner.slice(2);
  }
  inner = inner.replace(/\.+$/, "");
  if (inner === "") return null;
  if (/[*/:]/.test(inner)) return null;
  return sub ? { kind: "subdomains", suffix: inner } : { kind: "exact", host: inner };
}

/** host（已正規化的 hostname）是否命中 scope。 */
export function matchesDomain(host: string, scope: DomainScope): boolean {
  if (scope.all) return true;
  if (scope.exact.has(host)) return true;
  return scope.suffixes.some((s) => host.endsWith("." + s));
}
