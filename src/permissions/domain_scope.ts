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

/**
 * 內建 preapproved 文件網域清單。逐字快照自 Claude Code 2.1.173 binary（90 條、89 唯一，
 * learn.microsoft.com 原始碼中重複兩次）。重抽指令：
 *   grep -a -o 'new Set(\[[^]]*docs\.python\.org[^]]*\])' <claude binary>
 * 含 `/` 的條目於載入時推導為 path 前綴（該 host 不入精確 Set）；其餘為 hostname 精確比對。
 */
const PREAPPROVED: readonly string[] = [
  "platform.claude.com",
  "code.claude.com",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  "laravel.com",
  "symfony.com",
  "wordpress.org/documentation",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "blazor.net",
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  "keras.io",
  "spark.apache.org",
  "huggingface.co/docs",
  "www.kaggle.com/docs",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  "docs.getdbt.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "learn.microsoft.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.stripe.com",
  "docs.netlify.com",
  "devcenter.heroku.com",
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
];

const PREAPPROVED_HOSTS = new Set<string>();
const PREAPPROVED_PATH_PREFIXES = new Map<string, string[]>();
for (const entry of PREAPPROVED) {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    PREAPPROVED_HOSTS.add(entry);
    continue;
  }
  // 含 path 的條目：僅入 path Map，host 不入精確 Set（否則該 host 任意 path 都會誤放）
  const host = entry.slice(0, slash);
  const prefix = entry.slice(slash);
  const arr = PREAPPROVED_PATH_PREFIXES.get(host);
  if (arr) arr.push(prefix);
  else PREAPPROVED_PATH_PREFIXES.set(host, [prefix]);
}

export type UrlScope = "allowed" | "not-allowed" | "invalid";

/**
 * 對單一 URL 字串做網域三態判定：
 *   invalid    — 解析失敗 / 非 http(s) / 含 userinfo / 含 curl 展開字元 {}[]
 *   not-allowed — host 命中 deny 或 ask（否決），或未命中任何 allow / preapproved
 *   allowed    — host 命中 allow，或命中 preapproved（hostname 或 path 前綴）
 * 判定順序對齊官方 v2.1.162：顯式 deny/ask 優先於 preapproved 自動放行。
 * `{}[]` 檢查不可省略：shell 層 glob 偵測攔不到引號保護的 "{a,b}"，curl 仍會展開。
 */
export function resolveUrl(value: string, rules: WebFetchRules): UrlScope {
  try {
    if (/[{}[\]]/.test(value)) return "invalid";
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";
    if (u.username !== "" || u.password !== "") return "invalid";
    const host = u.hostname.replace(/\.+$/, "");
    if (host.startsWith("[")) return "not-allowed"; // IPv6：規則端無法宣告（防禦層；{}[] 檢查已先攔）
    if (matchesDomain(host, rules.deny)) return "not-allowed";
    if (matchesDomain(host, rules.ask)) return "not-allowed";
    if (matchesDomain(host, rules.allow)) return "allowed";
    if (matchesPreapproved(host, u.pathname)) return "allowed";
    return "not-allowed";
  } catch {
    return "invalid";
  }
}

/**
 * host 是否命中 preapproved（hostname 精確；path 條目需 pathname 等於前綴或在其下）。
 * host 必須已正規化（lowercase、無尾端 `.`、不含 port）——呼叫端負責，通常由 URL.hostname 滿足；
 * pathname 應來自 URL.pathname（已經 WHATWG 正規化）。
 * pathname 含百分號編碼的 `/` `\` `.`（含多重編碼如 %252f）→ 一律不放行（對齊官方 NX_）。
 */
export function matchesPreapproved(host: string, pathname: string): boolean {
  if (PREAPPROVED_HOSTS.has(host)) return true;
  const prefixes = PREAPPROVED_PATH_PREFIXES.get(host);
  if (!prefixes) return false;
  if (/%(25)*(2f|5c|2e)/i.test(pathname)) return false;
  for (const p of prefixes) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}
