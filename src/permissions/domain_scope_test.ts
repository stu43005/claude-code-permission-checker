import { assertEquals } from "@std/assert";
import {
  type DomainScope,
  EMPTY_DOMAIN_SCOPE,
  matchesDomain,
  matchesPreapproved,
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
