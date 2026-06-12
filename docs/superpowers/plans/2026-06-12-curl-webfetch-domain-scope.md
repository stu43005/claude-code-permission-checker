# curl + WebFetch 網域範圍 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讀取 settings 的 `WebFetch(domain:...)` 規則 + 內建 preapproved 文件網域清單，讓唯讀形式的 `curl` 在全部 URL 落在允許網域時自動 allow。

**Architecture:** 鏡像 readScope 模式——新增 `src/permissions/domain_scope.ts`（規則解析、網域比對、preapproved 清單、`resolveUrl` 三態判定），`settings.ts` 的 `PermissionRules` 增加 `webFetch` 三分類，`classify.ts` 把 `resolveUrl` 注入 `RuleContext`，新增 `src/rules/commands/curl.ts`（旗標 allowlist + URL 抽取）並在 `allowlist.ts` 註冊。

**Tech Stack:** Deno + TypeScript、unbash 3.0.0（`Word.value` 為去引號內容）、`@std/assert` 測試。

對應 spec：`docs/superpowers/specs/2026-06-12-curl-webfetch-domain-scope-design.md`（章節引用如 §3 指該文件）。

---

## File Structure

- Create: `src/permissions/domain_scope.ts` — 規則解析 + 比對 + preapproved + `resolveUrl`（單一職責：網域範圍判定，不碰檔案系統）
- Create: `src/permissions/domain_scope_test.ts`
- Modify: `src/permissions/settings.ts` — `PermissionRules.webFetch` 載入與合併
- Modify: `src/permissions/settings_test.ts`
- Modify: `src/rules/types.ts` — `RuleContext.resolveUrl`
- Modify: `src/engine/classify.ts` — `classifyBuiltin` 簽名 + 注入 + 呼叫處
- Modify: `src/engine/classify_test.ts`、`src/engine/evaluate_test.ts`、`src/permissions/matcher_test.ts` — `rulesOf`/literal 增加 `webFetch` 欄位
- Modify: 10 個 `src/rules/commands/*_test.ts` 的 `ctxOf` — 增加 `resolveUrl` stub
- Create: `src/rules/commands/curl.ts`、`src/rules/commands/curl_test.ts`
- Modify: `src/rules/allowlist.ts` — 註冊 curlRule
- Modify: `CLAUDE.md` — 補 WebFetch 網域放寬說明

---

### Task 1: domain_scope.ts — parseDomainRule + DomainScope + matchesDomain

**Files:**
- Create: `src/permissions/domain_scope.ts`
- Create: `src/permissions/domain_scope_test.ts`

- [ ] **Step 1: Write the failing tests**

建立 `src/permissions/domain_scope_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import {
  type DomainScope,
  EMPTY_DOMAIN_SCOPE,
  matchesDomain,
  parseDomainRule,
} from "./domain_scope.ts";

Deno.test("parseDomainRule exact host", () => {
  assertEquals(parseDomainRule("WebFetch(domain:example.com)"), {
    kind: "exact",
    host: "example.com",
  });
});

Deno.test("parseDomainRule lowercases and strips trailing dots", () => {
  assertEquals(parseDomainRule("WebFetch(domain:Example.COM..)"), {
    kind: "exact",
    host: "example.com",
  });
});

Deno.test("parseDomainRule subdomain wildcard", () => {
  assertEquals(parseDomainRule("WebFetch(domain:*.example.com)"), {
    kind: "subdomains",
    suffix: "example.com",
  });
});

Deno.test("parseDomainRule domain:* matches all", () => {
  assertEquals(parseDomainRule("WebFetch(domain:*)"), { kind: "all" });
});

Deno.test("parseDomainRule ignores unsupported forms", () => {
  // 中段 / 尾段萬用字元
  assertEquals(parseDomainRule("WebFetch(domain:api-*.example.com)"), null);
  assertEquals(parseDomainRule("WebFetch(domain:example.*)"), null);
  // 含 scheme / path / port / IPv6（含 `:` 一律忽略）
  assertEquals(parseDomainRule("WebFetch(domain:https://example.com)"), null);
  assertEquals(parseDomainRule("WebFetch(domain:example.com/api)"), null);
  assertEquals(parseDomainRule("WebFetch(domain:example.com:8080)"), null);
  assertEquals(parseDomainRule("WebFetch(domain:[::1])"), null);
  // 空字串與裸 *.
  assertEquals(parseDomainRule("WebFetch(domain:)"), null);
  assertEquals(parseDomainRule("WebFetch(domain:*.)"), null);
  // 非 WebFetch 形狀
  assertEquals(parseDomainRule("Bash(curl:*)"), null);
  assertEquals(parseDomainRule("WebFetch(url:example.com)"), null);
});

Deno.test("parseDomainRule keeps unicode host as-is (no punycode conversion)", () => {
  assertEquals(parseDomainRule("WebFetch(domain:例え.jp)"), {
    kind: "exact",
    host: "例え.jp",
  });
});

function scopeOf(rules: string[]): DomainScope {
  const scope: DomainScope = { exact: new Set(), suffixes: [], all: false };
  for (const r of rules) {
    const e = parseDomainRule(r);
    if (e === null) continue;
    if (e.kind === "all") scope.all = true;
    else if (e.kind === "exact") scope.exact.add(e.host);
    else scope.suffixes.push(e.suffix);
  }
  return scope;
}

Deno.test("matchesDomain exact host only", () => {
  const s = scopeOf(["WebFetch(domain:example.com)"]);
  assertEquals(matchesDomain("example.com", s), true);
  assertEquals(matchesDomain("api.example.com", s), false);
  assertEquals(matchesDomain("notexample.com", s), false);
});

Deno.test("matchesDomain subdomain wildcard excludes bare domain", () => {
  const s = scopeOf(["WebFetch(domain:*.example.com)"]);
  assertEquals(matchesDomain("a.example.com", s), true);
  assertEquals(matchesDomain("a.b.example.com", s), true);
  assertEquals(matchesDomain("example.com", s), false);
  assertEquals(matchesDomain("evilexample.com", s), false);
});

Deno.test("matchesDomain all", () => {
  const s = scopeOf(["WebFetch(domain:*)"]);
  assertEquals(matchesDomain("anything.example", s), true);
});

Deno.test("matchesDomain empty scope matches nothing", () => {
  assertEquals(matchesDomain("example.com", EMPTY_DOMAIN_SCOPE), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: FAIL（module not found `./domain_scope.ts`）

- [ ] **Step 3: Write the implementation**

建立 `src/permissions/domain_scope.ts`：

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: PASS（全部）

- [ ] **Step 5: Verify and commit**

Run: `deno task check && deno task lint`
Expected: 無錯誤

```bash
git add src/permissions/domain_scope.ts src/permissions/domain_scope_test.ts
git commit -F - <<'EOF'
feat(permissions): add parseDomainRule and matchesDomain for WebFetch rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: domain_scope.ts — preapproved 清單 + matchesPreapproved

**Files:**
- Modify: `src/permissions/domain_scope.ts`（追加於檔尾）
- Modify: `src/permissions/domain_scope_test.ts`（追加）

- [ ] **Step 1: Write the failing tests**

在 `src/permissions/domain_scope_test.ts` 檔尾追加：

```ts
import { matchesPreapproved } from "./domain_scope.ts";
```

（與既有 import 合併成同一行 import 區塊；實際寫法為把 `matchesPreapproved` 加入檔頭既有的
`from "./domain_scope.ts"` import 清單。）

```ts
Deno.test("preapproved exact hostname allows", () => {
  assertEquals(matchesPreapproved("docs.python.org", "/3/library/json.html"), true);
  assertEquals(matchesPreapproved("developer.mozilla.org", "/"), true);
});

Deno.test("preapproved is exact match, not subdomain or suffix", () => {
  // 子網域不放行
  assertEquals(matchesPreapproved("www.python.org", "/"), false);
  // 精確條目不得被當作後綴
  assertEquals(matchesPreapproved("other.readthedocs.io", "/"), false);
  assertEquals(matchesPreapproved("readthedocs.io", "/"), false);
  // requests.readthedocs.io 本身在列
  assertEquals(matchesPreapproved("requests.readthedocs.io", "/en/latest/"), true);
});

Deno.test("preapproved path prefix entries", () => {
  assertEquals(matchesPreapproved("github.com", "/anthropics"), true);
  assertEquals(matchesPreapproved("github.com", "/anthropics/claude-code"), true);
  // 非該前綴的 path 不放行
  assertEquals(matchesPreapproved("github.com", "/evil"), false);
  assertEquals(matchesPreapproved("github.com", "/anthropics-evil"), false);
  // path 條目的 host 不得整 host 放行
  assertEquals(matchesPreapproved("huggingface.co", "/"), false);
  assertEquals(matchesPreapproved("huggingface.co", "/blog"), false);
  assertEquals(matchesPreapproved("huggingface.co", "/docs"), true);
  assertEquals(matchesPreapproved("vercel.com", "/docs/cli"), true);
  assertEquals(matchesPreapproved("vercel.com", "/pricing"), false);
});

Deno.test("preapproved rejects percent-encoded path tricks", () => {
  assertEquals(matchesPreapproved("github.com", "/anthropics/%2e%2e/evil"), false);
  assertEquals(matchesPreapproved("github.com", "/anthropics/%252f"), false);
  assertEquals(matchesPreapproved("github.com", "/anthropics/%5cx"), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: FAIL（`matchesPreapproved` 未匯出）

- [ ] **Step 3: Write the implementation**

在 `src/permissions/domain_scope.ts` 檔尾追加：

```ts
/**
 * 內建 preapproved 文件網域清單。逐字快照自 Claude Code 2.1.173 binary（90 條、89 唯一，
 * learn.microsoft.com 原始碼中重複兩次）。重抽指令：
 *   grep -a -o 'new Set(\[[^]]*docs\.python\.org[^]]*\])' <claude binary>
 * 含 `/` 的條目於載入時推導為 path 前綴（該 host 不入精確 Set）；其餘為 hostname 精確比對。
 */
const PREAPPROVED: string[] = [
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

/**
 * host 是否命中 preapproved（hostname 精確；path 條目需 pathname 等於前綴或在其下）。
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: PASS（全部）

- [ ] **Step 5: Verify and commit**

Run: `deno task check && deno task lint`
Expected: 無錯誤

```bash
git add src/permissions/domain_scope.ts src/permissions/domain_scope_test.ts
git commit -F - <<'EOF'
feat(permissions): add preapproved docs domain list snapshot from Claude Code 2.1.173

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: domain_scope.ts — resolveUrl 三態判定

**Files:**
- Modify: `src/permissions/domain_scope.ts`（追加）
- Modify: `src/permissions/domain_scope_test.ts`（追加）

- [ ] **Step 1: Write the failing tests**

把 `resolveUrl`、`type UrlScope`、`emptyDomainScope`、`type WebFetchRules` 加入檔頭既有的
`from "./domain_scope.ts"` import 清單，並在檔尾追加：

```ts
function webFetchOf(spec: {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}): WebFetchRules {
  return {
    allow: scopeOf(spec.allow ?? []),
    deny: scopeOf(spec.deny ?? []),
    ask: scopeOf(spec.ask ?? []),
  };
}

const NO_RULES = webFetchOf({});

Deno.test("resolveUrl allows explicit allow domain", () => {
  const r = webFetchOf({ allow: ["WebFetch(domain:api.example.com)"] });
  assertEquals(resolveUrl("https://api.example.com/v1", r), "allowed");
  assertEquals(resolveUrl("http://api.example.com/", r), "allowed");
  // 裸域與其他 host 不放行
  assertEquals(resolveUrl("https://example.com/", r), "not-allowed");
});

Deno.test("resolveUrl wildcard subdomains", () => {
  const r = webFetchOf({ allow: ["WebFetch(domain:*.example.com)"] });
  assertEquals(resolveUrl("https://a.b.example.com/", r), "allowed");
  assertEquals(resolveUrl("https://example.com/", r), "not-allowed");
});

Deno.test("resolveUrl preapproved without any rules", () => {
  assertEquals(resolveUrl("https://docs.python.org/3/", NO_RULES), "allowed");
  assertEquals(resolveUrl("https://github.com/anthropics/claude-code", NO_RULES), "allowed");
  assertEquals(resolveUrl("https://github.com/evil/repo", NO_RULES), "not-allowed");
  assertEquals(resolveUrl("https://unknown.example/", NO_RULES), "not-allowed");
});

Deno.test("resolveUrl deny and ask veto allow and preapproved", () => {
  const denied = webFetchOf({
    allow: ["WebFetch(domain:docs.python.org)"],
    deny: ["WebFetch(domain:docs.python.org)"],
  });
  assertEquals(resolveUrl("https://docs.python.org/3/", denied), "not-allowed");
  const asked = webFetchOf({ ask: ["WebFetch(domain:docs.python.org)"] });
  assertEquals(resolveUrl("https://docs.python.org/3/", asked), "not-allowed");
});

Deno.test("resolveUrl host normalization", () => {
  const r = webFetchOf({ allow: ["WebFetch(domain:api.example.com)"] });
  // hostname 大小寫與尾端點（URL parser lowercase；尾端 . 由 resolveUrl 去除）
  assertEquals(resolveUrl("https://API.Example.COM/x", r), "allowed");
  assertEquals(resolveUrl("https://api.example.com./x", r), "allowed");
  // port 忽略（只比 hostname）
  assertEquals(resolveUrl("https://api.example.com:8443/x", r), "allowed");
});

Deno.test("resolveUrl invalid forms", () => {
  const r = webFetchOf({ allow: ["WebFetch(domain:*)"] });
  // 非 http(s) scheme
  assertEquals(resolveUrl("file:///etc/passwd", r), "invalid");
  assertEquals(resolveUrl("ftp://api.example.com/", r), "invalid");
  // 無 scheme / 解析失敗
  assertEquals(resolveUrl("api.example.com/v1", r), "invalid");
  assertEquals(resolveUrl("not a url", r), "invalid");
  // userinfo 視同憑證
  assertEquals(resolveUrl("https://user@api.example.com/", r), "invalid");
  assertEquals(resolveUrl("https://u:p@api.example.com/", r), "invalid");
  // curl 多重展開字元（即使網域全放行也拒絕；含 IPv6 字面值的 [ ]）
  assertEquals(resolveUrl("https://api.example.com/{a,b}", r), "invalid");
  assertEquals(resolveUrl("https://api.example.com/[1-9]", r), "invalid");
  assertEquals(resolveUrl("http://[::1]/", r), "invalid");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: FAIL（`resolveUrl` 未匯出）

- [ ] **Step 3: Write the implementation**

在 `src/permissions/domain_scope.ts` 檔尾追加：

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/permissions/domain_scope_test.ts`
Expected: PASS（全部）

- [ ] **Step 5: Verify and commit**

Run: `deno task check && deno task lint`
Expected: 無錯誤

```bash
git add src/permissions/domain_scope.ts src/permissions/domain_scope_test.ts
git commit -F - <<'EOF'
feat(permissions): add resolveUrl three-state domain verdict

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: settings.ts — 載入 webFetch 規則（含既有測試型別同步）

**Files:**
- Modify: `src/permissions/settings.ts`
- Modify: `src/permissions/settings_test.ts`
- Modify: `src/permissions/matcher_test.ts:111-116`（`rulesOf`）
- Modify: `src/engine/classify_test.ts:13-18` 與 `:94-99`、`:120-140`（PermissionRules literal）
- Modify: `src/engine/evaluate_test.ts:83-88`（`rulesOf`）

- [ ] **Step 1: Write the failing tests**

在 `src/permissions/settings_test.ts` 檔尾追加（import 區補上
`import { EMPTY_DOMAIN_SCOPE } from "./domain_scope.ts";`，若既有 import 已有同來源則合併）：

```ts
Deno.test("loadPermissionRules parses WebFetch domain rules", () => {
  const files = new Map<string, string>([
    [
      "/proj/.claude/settings.json",
      JSON.stringify({
        permissions: {
          allow: ["WebFetch(domain:api.example.com)", "WebFetch(domain:*.cdn.example.com)"],
          deny: ["WebFetch(domain:evil.example.com)"],
          ask: ["WebFetch(domain:*)"],
        },
      }),
    ],
  ]);
  const rules = loadPermissionRules(envOf({}), "/proj", (p) => files.get(p) ?? null);
  assertEquals(rules.webFetch.allow.exact.has("api.example.com"), true);
  assertEquals(rules.webFetch.allow.suffixes, ["cdn.example.com"]);
  assertEquals(rules.webFetch.deny.exact.has("evil.example.com"), true);
  assertEquals(rules.webFetch.ask.all, true);
});

Deno.test("loadPermissionRules unions webFetch across sources", () => {
  const files = new Map<string, string>([
    [
      "/proj/.claude/settings.json",
      JSON.stringify({ permissions: { allow: ["WebFetch(domain:a.example.com)"] } }),
    ],
    [
      "/proj/.claude/settings.local.json",
      JSON.stringify({ permissions: { allow: ["WebFetch(domain:b.example.com)"] } }),
    ],
  ]);
  const rules = loadPermissionRules(envOf({}), "/proj", (p) => files.get(p) ?? null);
  assertEquals(rules.webFetch.allow.exact.has("a.example.com"), true);
  assertEquals(rules.webFetch.allow.exact.has("b.example.com"), true);
});

Deno.test("loadPermissionRules ignores unsupported WebFetch forms", () => {
  const files = new Map<string, string>([
    [
      "/proj/.claude/settings.json",
      JSON.stringify({
        permissions: { allow: ["WebFetch(domain:api-*.example.com)", "WebFetch(domain:x.com:8080)"] },
      }),
    ],
  ]);
  const rules = loadPermissionRules(envOf({}), "/proj", (p) => files.get(p) ?? null);
  assertEquals(rules.webFetch.allow.exact.size, 0);
  assertEquals(rules.webFetch.allow.suffixes, []);
  assertEquals(rules.webFetch.allow.all, false);
});
```

注意：`settings_test.ts` 既有的 `envOf` helper 與「期望整物件相等」的斷言寫法照舊；
既有測試中以整物件 `assertEquals` 比對 `PermissionRules` 的期望值 literal（如 `:22` 附近的
`readScope: { allow: EMPTY_READ_SCOPE, ... }`）必須同步補上：

```ts
webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/permissions/settings_test.ts`
Expected: FAIL（`rules.webFetch` 不存在 / 型別錯誤）

- [ ] **Step 3: Write the implementation**

修改 `src/permissions/settings.ts`：

(a) import 區追加：

```ts
import {
  type DomainScope,
  EMPTY_DOMAIN_SCOPE,
  emptyDomainScope,
  parseDomainRule,
  type WebFetchRules,
} from "./domain_scope.ts";
```

(b) `PermissionRules` 與 `EMPTY_RULES`：

```ts
export interface PermissionRules {
  bash: BashRules; // 原扁平的 { allow, deny, ask } 移入此層
  readScope: ReadScopeRules;
  webFetch: WebFetchRules;
}

export const EMPTY_RULES: PermissionRules = {
  bash: { allow: [], deny: [], ask: [] },
  readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
  webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
};
```

(c) `emptyRules()` 的回傳物件追加：

```ts
    webFetch: {
      allow: emptyDomainScope(),
      deny: emptyDomainScope(),
      ask: emptyDomainScope(),
    },
```

(d) 新增解析函式（放在 `parsePathRuleList` 之後）：

```ts
function parseDomainRuleList(value: unknown): DomainScope {
  const out = emptyDomainScope();
  if (!Array.isArray(value)) return out;
  for (const el of value) {
    if (typeof el !== "string") continue;
    let entry: ReturnType<typeof parseDomainRule>;
    try {
      entry = parseDomainRule(el);
    } catch {
      entry = null;
    }
    if (entry === null) continue;
    if (entry.kind === "all") out.all = true;
    else if (entry.kind === "exact") out.exact.add(entry.host);
    else out.suffixes.push(entry.suffix);
  }
  return out;
}
```

(e) `parseFile` 的回傳物件追加：

```ts
    webFetch: {
      allow: parseDomainRuleList(p.allow),
      deny: parseDomainRuleList(p.deny),
      ask: parseDomainRuleList(p.ask),
    },
```

(f) `loadPermissionRules` 的合併迴圈（既有 readScope 合併之後）追加：

```ts
      for (const k of ["allow", "deny", "ask"] as const) {
        for (const h of rules.webFetch[k].exact) merged.webFetch[k].exact.add(h);
        merged.webFetch[k].suffixes.push(...rules.webFetch[k].suffixes);
        if (rules.webFetch[k].all) merged.webFetch[k].all = true;
      }
```

(g) 同步修正三個既有測試檔的 `PermissionRules` literal（型別補欄位，行為不變）。
`src/permissions/matcher_test.ts` 與 `src/engine/evaluate_test.ts` 與
`src/engine/classify_test.ts` 的 `rulesOf` helper、以及 `classify_test.ts` 中直接建構
`PermissionRules` 的 literal（約 `:94-99`、`:120-140` 三處），每個物件追加同一行：

```ts
    webFetch: { allow: EMPTY_DOMAIN_SCOPE, deny: EMPTY_DOMAIN_SCOPE, ask: EMPTY_DOMAIN_SCOPE },
```

並在各檔 import 區追加：

```ts
import { EMPTY_DOMAIN_SCOPE } from "../permissions/domain_scope.ts";
```

（`matcher_test.ts` 的相對路徑為 `./domain_scope.ts`。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task check && deno task test`
Expected: 型別檢查通過、全部測試 PASS

- [ ] **Step 5: Verify and commit**

Run: `deno task lint`
Expected: 無錯誤

```bash
git add src/permissions/settings.ts src/permissions/settings_test.ts src/permissions/matcher_test.ts src/engine/classify_test.ts src/engine/evaluate_test.ts
git commit -F - <<'EOF'
feat(permissions): load WebFetch domain rules into PermissionRules.webFetch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: RuleContext.resolveUrl + classify.ts wiring

**Files:**
- Modify: `src/rules/types.ts`
- Modify: `src/engine/classify.ts`
- Modify: `src/engine/classify_test.ts`（新增注入驗證測試）
- Modify: 10 個 `ctxOf` helper：`src/rules/commands/{awk,coreutils,deno,find,gh,git,grep,positional-output,sed,simple-flag}_test.ts`

- [ ] **Step 1: Write the failing test**

在 `src/engine/classify_test.ts` 檔尾追加（此測試走 classify 端到端，驗證 resolveUrl
已被注入並由 webFetch 規則驅動；curl 規則尚未存在，故先用 rules 物件直接驗證
classify 對「未列入 allowlist 指令」不受影響、且型別接通——真正的 e2e 在 Task 6/7）：

```ts
Deno.test("classify passes webFetch rules through (type wiring)", () => {
  // curl 尚未註冊 → ask（未列入 allowlist）；本測試先固定此基準行為，
  // Task 6 註冊 curl 後將由 curl_test 與 Task 7 的 e2e 接手驗證 allow 路徑。
  const inv = firstInv("curl https://docs.python.org/3/");
  const v = classify(inv, "/proj", rulesOf({}));
  assertEquals(v.kind, "ask");
});
```

（`firstInv` 為 `classify_test.ts` 既有 helper；若名稱不同，沿用該檔既有「由 src 字串取
第一個 CommandInvocation」的 helper。）

- [ ] **Step 2: Run test to verify current state**

Run: `deno test --allow-env src/engine/classify_test.ts`
Expected: 新測試 PASS（curl 未註冊本就 ask）——本 Task 的失敗訊號在型別層：Step 3 改
`RuleContext` 後，`deno task check` 會因 10 個 `ctxOf` 缺欄位而 FAIL，再逐一補齊。

- [ ] **Step 3: Write the implementation**

(a) `src/rules/types.ts`：import 區追加

```ts
import type { UrlScope } from "../permissions/domain_scope.ts";
```

`RuleContext` 介面追加（放在 `resolvePathValue` 之後）：

```ts
  /** 對 URL 字串做網域範圍三態判定（內部已綁定 settings 的 WebFetch 規則與 preapproved 清單）。 */
  resolveUrl(value: string): UrlScope;
```

(b) `src/engine/classify.ts`：import 區追加

```ts
import { resolveUrl, type WebFetchRules } from "../permissions/domain_scope.ts";
```

`classifyBuiltin` 簽名改為：

```ts
function classifyBuiltin(inv: CommandInvocation, scope: ScopeConfig, webFetch: WebFetchRules): RuleVerdict {
```

`rule.evaluate({...})` 的物件 literal 中、`resolvePathValue` 之後追加：

```ts
    resolveUrl: (v) => resolveUrl(v, webFetch),
```

`classify` 內唯一呼叫處改為：

```ts
  const v = classifyBuiltin(inv, scope, rules.webFetch);
```

(c) 10 個 `src/rules/commands/*_test.ts` 的 `ctxOf` helper：在
`resolvePathValue: ...` 行之後各追加同一行 stub（這些規則不使用 URL 判定，固定回
`not-allowed` 即可）：

```ts
    resolveUrl: () => "not-allowed",
```

- [ ] **Step 4: Run full check and tests**

Run: `deno task check && deno task test`
Expected: 型別檢查通過、全部測試 PASS

- [ ] **Step 5: Verify and commit**

Run: `deno task lint`
Expected: 無錯誤

```bash
git add src/rules/types.ts src/engine/classify.ts src/engine/classify_test.ts src/rules/commands/awk_test.ts src/rules/commands/coreutils_test.ts src/rules/commands/deno_test.ts src/rules/commands/find_test.ts src/rules/commands/gh_test.ts src/rules/commands/git_test.ts src/rules/commands/grep_test.ts src/rules/commands/positional-output_test.ts src/rules/commands/sed_test.ts src/rules/commands/simple-flag_test.ts
git commit -F - <<'EOF'
feat(engine): inject resolveUrl into RuleContext via classify

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: curl 指令規則 + allowlist 註冊

**Files:**
- Create: `src/rules/commands/curl.ts`
- Create: `src/rules/commands/curl_test.ts`
- Modify: `src/rules/allowlist.ts`

- [ ] **Step 1: Write the failing tests**

建立 `src/rules/commands/curl_test.ts`：

```ts
import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { curlRule } from "./curl.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import {
  type DomainScope,
  parseDomainRule,
  resolveUrl,
  type WebFetchRules,
} from "../../permissions/domain_scope.ts";

function scopeOf(rules: string[]): DomainScope {
  const scope: DomainScope = { exact: new Set(), suffixes: [], all: false };
  for (const r of rules) {
    const e = parseDomainRule(r);
    if (e === null) continue;
    if (e.kind === "all") scope.all = true;
    else if (e.kind === "exact") scope.exact.add(e.host);
    else scope.suffixes.push(e.suffix);
  }
  return scope;
}

const ALLOW_EXAMPLE: WebFetchRules = {
  allow: scopeOf(["WebFetch(domain:api.example.com)"]),
  deny: scopeOf([]),
  ask: scopeOf([]),
};
const NO_RULES: WebFetchRules = { allow: scopeOf([]), deny: scopeOf([]), ask: scopeOf([]) };

function ctxOf(src: string, rules: WebFetchRules = ALLOW_EXAMPLE): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "curl",
    argv: cmd.suffix ?? [],
    redirects: cmd.redirects ?? [],
    assignments: cmd.prefix ?? [],
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: (v) => resolveUrl(v, rules),
  };
}

Deno.test("curl allows read-only fetch to allowed domain", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl https://api.example.com/v1")).kind, "allow");
  assertEquals(curlRule.evaluate(ctxOf("curl -sSL https://api.example.com/v1")).kind, "allow");
  assertEquals(curlRule.evaluate(ctxOf("curl -I https://api.example.com/")).kind, "allow");
  assertEquals(
    curlRule.evaluate(ctxOf("curl --max-time 10 --retry 3 https://api.example.com/")).kind,
    "allow",
  );
});

Deno.test("curl allows preapproved domain without rules", () => {
  assertEquals(
    curlRule.evaluate(ctxOf("curl -s https://docs.python.org/3/", NO_RULES)).kind,
    "allow",
  );
});

Deno.test("curl asks for non-allowed domain", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl https://evil.example/")).kind, "ask");
  // 多 URL：任一不命中 → ask
  assertEquals(
    curlRule.evaluate(ctxOf("curl https://api.example.com/a https://evil.example/b")).kind,
    "ask",
  );
});

Deno.test("curl asks without any URL", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl -s")).kind, "ask");
});

Deno.test("curl --url value is domain-checked", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl --url https://api.example.com/v1")).kind, "allow");
  assertEquals(curlRule.evaluate(ctxOf("curl --url=https://api.example.com/v1")).kind, "allow");
  assertEquals(curlRule.evaluate(ctxOf("curl --url https://evil.example/")).kind, "ask");
});

Deno.test("curl asks on write/output flags", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl -o out.txt https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -O https://api.example.com/f.txt")).kind, "ask");
  assertEquals(
    curlRule.evaluate(ctxOf("curl --output out.txt https://api.example.com/")).kind,
    "ask",
  );
});

Deno.test("curl asks on non-GET and credential flags", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl -X POST https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -d a=b https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -T file https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -u user:pw https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -K cfg https://api.example.com/")).kind, "ask");
  assertEquals(
    curlRule.evaluate(ctxOf("curl --resolve x:443:1.2.3.4 https://api.example.com/")).kind,
    "ask",
  );
});

Deno.test("curl asks on unknown flags (allowlist principle)", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl --unknown-flag https://api.example.com/")).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf("curl -Z https://api.example.com/")).kind, "ask");
});

Deno.test("curl -H static value allows; @file applies read scope; dynamic asks", () => {
  assertEquals(
    curlRule.evaluate(ctxOf('curl -H "Accept: application/json" https://api.example.com/')).kind,
    "allow",
  );
  // 黏值形式（unbash Word.value 去引號 → token 為 `-HAccept: x`）
  assertEquals(
    curlRule.evaluate(ctxOf('curl -H"Accept: x" https://api.example.com/')).kind,
    "allow",
  );
  assertEquals(
    curlRule.evaluate(ctxOf("curl -H @headers.txt https://api.example.com/")).kind,
    "allow", // /proj 內相對路徑 → in-project
  );
  assertEquals(
    curlRule.evaluate(ctxOf("curl -H @/etc/headers https://api.example.com/")).kind,
    "ask", // 專案外
  );
  assertEquals(
    curlRule.evaluate(ctxOf("curl -H @- https://api.example.com/")).kind,
    "allow", // stdin
  );
  assertEquals(
    curlRule.evaluate(ctxOf('curl -H "$HDR" https://api.example.com/')).kind,
    "ask", // 動態值
  );
});

Deno.test("curl short-flag aggregation with value letter", () => {
  // 聚合中尾隨吃值字母：值取下一個 token，且該 token 不得被當作 URL
  assertEquals(
    curlRule.evaluate(ctxOf("curl -sSA myagent https://api.example.com/")).kind,
    "allow",
  );
  // 聚合中吃值字母後接黏值
  assertEquals(curlRule.evaluate(ctxOf("curl -sm10 https://api.example.com/")).kind, "allow");
  // 聚合中含未知字母 → ask
  assertEquals(curlRule.evaluate(ctxOf("curl -sZ https://api.example.com/")).kind, "ask");
});

Deno.test("curl URL constraints", () => {
  // 無 scheme
  assertEquals(curlRule.evaluate(ctxOf("curl api.example.com/v1")).kind, "ask");
  // userinfo
  assertEquals(curlRule.evaluate(ctxOf('curl "https://user@api.example.com/"')).kind, "ask");
  // 引號保護的 curl 展開字元（shell 層攔不到，靠 resolveUrl 攔）
  assertEquals(curlRule.evaluate(ctxOf('curl "https://api.example.com/{a,b}"')).kind, "ask");
  assertEquals(curlRule.evaluate(ctxOf('curl "https://api.example.com/[1-9]"')).kind, "ask");
  // -g 不放寬展開字元攔截
  assertEquals(curlRule.evaluate(ctxOf('curl -g "https://api.example.com/{a,b}"')).kind, "ask");
  // 動態 URL
  assertEquals(curlRule.evaluate(ctxOf('curl "$URL"')).kind, "ask");
});

Deno.test("curl deny/ask rules veto", () => {
  const vetoed: WebFetchRules = {
    allow: scopeOf(["WebFetch(domain:docs.python.org)"]),
    deny: scopeOf(["WebFetch(domain:docs.python.org)"]),
    ask: scopeOf([]),
  };
  assertEquals(
    curlRule.evaluate(ctxOf("curl https://docs.python.org/3/", vetoed)).kind,
    "ask",
  );
});

Deno.test("rule covers only curl", () => {
  assertEquals(curlRule.names, ["curl"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env src/rules/commands/curl_test.ts`
Expected: FAIL（module not found `./curl.ts`）

- [ ] **Step 3: Write the implementation**

建立 `src/rules/commands/curl.ts`：

```ts
import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

// 安全集合採 allowlist：未列入的旗標一律 ask（誤 ask 可接受、誤 allow 不可接受）。
// 寫檔（-o/-O/--output*）、非 GET（-X/-d/-F/-T）、憑證（-u/--netrc/-K）、路由
// （-x/--resolve/--connect-to）等皆不在集合內，自然 ask。
const SAFE_LONG_NOVAL = new Set([
  "--silent",
  "--show-error",
  "--fail",
  "--fail-with-body",
  "--location",
  "--head",
  "--include",
  "--get",
  "--verbose",
  "--ipv4",
  "--ipv6",
  "--compressed",
  "--globoff", // 僅相容性：不放寬 resolveUrl 的 {}[] 攔截
  "--no-progress-meter",
  "--http1.1",
  "--http2",
]);
const SAFE_SHORT_NOVAL = new Set(["s", "S", "f", "L", "I", "i", "G", "v", "4", "6", "g"]);
const SAFE_LONG_VAL = new Set([
  "--max-time",
  "--connect-timeout",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--max-redirs",
  "--user-agent",
  "--referer",
]);
const SAFE_SHORT_VAL = new Set(["m", "A", "e"]);

/** -H/--header 值檢查：靜態字串安全；@- 安全；@file 走讀取範圍；其餘 ask。 */
function checkHeaderValue(ctx: RuleContext, value: string): RuleVerdict | null {
  if (!value.startsWith("@")) return null;
  if (value === "@-") return null; // 讀 stdin，無檔案存取
  const scope = ctx.resolvePathValue(value.slice(1));
  if (scope !== "in-project") {
    return ask("curl：-H @file 路徑超出允許範圍或無法解析");
  }
  return null;
}

export const curlRule: CommandRule = {
  names: ["curl"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const argv = ctx.argv;
    const urls: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const t = staticValue(argv[i]);
      if (t === null) return ask("curl：動態參數無法判定");

      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        const name = eq === -1 ? t : t.slice(0, eq);
        const inline = eq === -1 ? null : t.slice(eq + 1);
        if (SAFE_LONG_NOVAL.has(name)) {
          if (inline !== null) return ask(`curl：旗標 ${name} 不應帶值`);
          continue;
        }
        if (SAFE_LONG_VAL.has(name) || name === "--header" || name === "--url") {
          let value: string;
          if (inline !== null) {
            value = inline;
          } else {
            i++;
            if (i >= argv.length) return ask(`curl：${name} 缺少值`);
            const v = staticValue(argv[i]);
            if (v === null) return ask(`curl：${name} 的值為動態`);
            value = v;
          }
          if (name === "--header") {
            const verdict = checkHeaderValue(ctx, value);
            if (verdict) return verdict;
          } else if (name === "--url") {
            urls.push(value);
          }
          continue;
        }
        return ask(`curl：未列入安全集合的旗標 ${name}`);
      }

      if (t.startsWith("-") && t !== "-") {
        // 聚合短旗標逐字母掃描（區分大小寫）；吃值字母後同 token 剩餘字元為值，
        // 剩餘為空則下一個 argv token 為值（並從 URL 候選排除）。
        let handled = false;
        for (let j = 1; j < t.length; j++) {
          const c = t[j];
          if (SAFE_SHORT_NOVAL.has(c)) continue;
          if (SAFE_SHORT_VAL.has(c) || c === "H") {
            const rest = t.slice(j + 1);
            let value: string;
            if (rest !== "") {
              value = rest;
            } else {
              i++;
              if (i >= argv.length) return ask(`curl：-${c} 缺少值`);
              const v = staticValue(argv[i]);
              if (v === null) return ask(`curl：-${c} 的值為動態`);
              value = v;
            }
            if (c === "H") {
              const verdict = checkHeaderValue(ctx, value);
              if (verdict) return verdict;
            }
            handled = true;
            break; // 值吃掉剩餘字元，掃描即止
          }
          return ask(`curl：未列入安全集合的旗標 -${c}`);
        }
        void handled;
        continue;
      }

      // 位置參數 = URL（`-` 會解析失敗 → invalid → ask，符合保守方向）
      urls.push(t);
    }

    if (urls.length === 0) return ask("curl：未發現 URL");
    for (const u of urls) {
      if (ctx.resolveUrl(u) !== "allowed") {
        return ask(`curl：URL 不在允許網域或形式不安全（${u}）`);
      }
    }
    return allow();
  },
};
```

(b) `src/rules/allowlist.ts`：import 區追加

```ts
import { curlRule } from "./commands/curl.ts";
```

`RULES` 陣列尾端（`ghRule` 之後）追加：

```ts
  curlRule,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env src/rules/commands/curl_test.ts && deno task test`
Expected: 全部 PASS

- [ ] **Step 5: Verify and commit**

Run: `deno task check && deno task lint`
Expected: 無錯誤

```bash
git add src/rules/commands/curl.ts src/rules/commands/curl_test.ts src/rules/allowlist.ts
git commit -F - <<'EOF'
feat(rules): add curl read-only rule gated by WebFetch domain scope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: 端到端整合測試 + operational verification + 文件

**Files:**
- Modify: `src/engine/classify_test.ts`（e2e 案例）
- Modify: `CLAUDE.md`
- Build: `dist/permission-checker(.exe)`（不入版控）

- [ ] **Step 1: Write the failing e2e tests**

在 `src/engine/classify_test.ts` 檔尾追加（`rulesOf` 已於 Task 4 擴充型別；此處需要一個
能帶 WebFetch 規則的變體——直接建構 literal）：

```ts
function webFetchRulesOf(spec: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules {
  const scopeOf = (rules: string[]) => {
    const s = { exact: new Set<string>(), suffixes: [] as string[], all: false };
    for (const r of rules) {
      const e = parseDomainRule(r);
      if (e === null) continue;
      if (e.kind === "all") s.all = true;
      else if (e.kind === "exact") s.exact.add(e.host);
      else s.suffixes.push(e.suffix);
    }
    return s;
  };
  return {
    bash: { allow: [], deny: [], ask: [] },
    readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
    webFetch: {
      allow: scopeOf(spec.allow ?? []),
      deny: scopeOf(spec.deny ?? []),
      ask: scopeOf(spec.ask ?? []),
    },
  };
}

Deno.test("classify e2e: curl allowed domain via WebFetch rules", () => {
  const rules = webFetchRulesOf({ allow: ["WebFetch(domain:api.example.com)"] });
  assertEquals(
    classify(firstInv("curl -sL https://api.example.com/v1"), "/proj", rules).kind,
    "allow",
  );
  assertEquals(
    classify(firstInv("curl -sL https://example.com/"), "/proj", rules).kind,
    "ask",
  );
});

Deno.test("classify e2e: curl preapproved domain with default rules", () => {
  assertEquals(
    classify(firstInv("curl -s https://docs.python.org/3/"), "/proj", EMPTY_RULES).kind,
    "allow",
  );
});

Deno.test("classify e2e: deny vetoes preapproved", () => {
  const rules = webFetchRulesOf({ deny: ["WebFetch(domain:docs.python.org)"] });
  assertEquals(
    classify(firstInv("curl -s https://docs.python.org/3/"), "/proj", rules).kind,
    "ask",
  );
});

Deno.test("classify e2e: write redirect still asks for allowed curl", () => {
  // 中央寫入重導向規則照常生效
  assertEquals(
    classify(firstInv("curl -s https://docs.python.org/3/ > out.html"), "/proj", EMPTY_RULES).kind,
    "ask",
  );
});
```

import 區追加 `parseDomainRule`（來源 `../permissions/domain_scope.ts`，與 Task 4 已加的
`EMPTY_DOMAIN_SCOPE` 合併同一行）；`EMPTY_RULES` 若尚未 import 則自
`../permissions/settings.ts` 加入。

- [ ] **Step 2: Run tests to verify they pass**

Run: `deno task check && deno task test`
Expected: 全部 PASS（Task 6 已完成實作，e2e 應直接綠；若有紅，修復後重跑）

- [ ] **Step 3: Build and operational verification**

Run: `deno task build`
Expected: 產出 `dist/permission-checker(.exe)`

依序餵真實 hook JSON 驗證（在專案根執行；`CLAUDE_PROJECT_DIR` 指向一個**不含**相關
`permissions.allow` 與 WebFetch 規則的乾淨目錄，避免使用者 settings 干擾——若使用者
`~/.claude/settings.json` 含 WebFetch 規則，預期值需按其內容調整，參見專案 CLAUDE.md
的 operational verification 注意事項）：

```bash
# 1. preapproved 網域唯讀 curl → allow
echo '{"tool_name":"Bash","tool_input":{"command":"curl -sL https://docs.python.org/3/"},"cwd":"D:/claude-code-permission-checker"}' \
  | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe
# 期望輸出含 "allow"

# 2. 未列網域 → ask
echo '{"tool_name":"Bash","tool_input":{"command":"curl -s https://unknown.example/"},"cwd":"D:/claude-code-permission-checker"}' \
  | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe
# 期望輸出含 "ask"

# 3. 寫檔旗標 → ask
echo '{"tool_name":"Bash","tool_input":{"command":"curl -o x.html https://docs.python.org/3/"},"cwd":"D:/claude-code-permission-checker"}' \
  | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe
# 期望輸出含 "ask"

# 4. 非 GET → ask
echo '{"tool_name":"Bash","tool_input":{"command":"curl -X POST https://docs.python.org/"},"cwd":"D:/claude-code-permission-checker"}' \
  | CLAUDE_PROJECT_DIR="D:/claude-code-permission-checker" ./dist/permission-checker.exe
# 期望輸出含 "ask"
```

Expected: 四項皆符合期望；任何不符 → 回到對應 Task 修復、重跑單元測試與本步驟。

- [ ] **Step 4: Update CLAUDE.md**

在專案 `CLAUDE.md` 的「hook 決策 vs settings.json 權限的優先序（重要）」一節，
readScope 段落（「此外，本檢查器也沿用 `permissions.{allow,deny,ask}` 中的
`Read()/Edit()/Write()` 規則放寬『讀取位置』…」）之後追加：

```markdown
本檢查器同樣沿用 `permissions.{allow,deny,ask}` 中的 `WebFetch(domain:...)` 規則 + 內建
preapproved 文件網域清單（快照自 Claude Code 2.1.173，見 `permissions/domain_scope.ts`），
放行唯讀形式的 `curl`：旗標全落在安全 allowlist、每個 URL 靜態且帶明確 http(s) scheme、
host 命中 allow 網域或 preapproved（顯式 deny/ask 規則否決之）才 allow。比對語意對齊官方：
無萬用字元 = 精確 host（不含子網域）、`*.x` 僅子網域（不含裸域）、`domain:*` 一切；只比
hostname（忽略 port/path，preapproved 的 5 條 path 前綴條目除外）。寫檔旗標（`-o` 等）、
非 GET、憑證旗標、無 scheme、userinfo、curl 展開字元 `{}[]`、動態 token 一律 ask；
`-H @file` 走既有讀取範圍判定。
```

- [ ] **Step 5: Final verification and commit**

Run: `deno task check && deno task lint && deno task test`
Expected: 全綠

```bash
git add src/engine/classify_test.ts CLAUDE.md
git commit -F - <<'EOF'
test(engine): add curl WebFetch domain e2e cases; document curl widening

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```
