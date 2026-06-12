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
