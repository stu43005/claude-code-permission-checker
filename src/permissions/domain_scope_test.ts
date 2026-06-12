import { assertEquals } from "@std/assert";
import {
  type DomainScope,
  EMPTY_DOMAIN_SCOPE,
  matchesDomain,
  matchesPreapproved,
  parseDomainRule,
  resolveUrl,
  type WebFetchRules,
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

Deno.test("matchesDomain is case-sensitive (host must already be lowercase)", () => {
  const s = scopeOf(["WebFetch(domain:example.com)"]);
  assertEquals(matchesDomain("EXAMPLE.COM", s), false); // 呼叫端負責先正規化
});

Deno.test("matchesDomain subdomain of TLD wildcard", () => {
  const s = scopeOf(["WebFetch(domain:*.com)"]);
  assertEquals(matchesDomain("example.com", s), true);
  assertEquals(matchesDomain("com", s), false);
});

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

Deno.test("preapproved is case-sensitive (host must already be lowercase)", () => {
  assertEquals(matchesPreapproved("DOCS.PYTHON.ORG", "/"), false);
  assertEquals(matchesPreapproved("Github.com", "/anthropics"), false);
});

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

Deno.test("resolveUrl deny:* wildcard vetoes specific allow", () => {
  const r = webFetchOf({
    allow: ["WebFetch(domain:safe.example.com)"],
    deny: ["WebFetch(domain:*)"],
  });
  assertEquals(resolveUrl("https://safe.example.com/", r), "not-allowed");
});
