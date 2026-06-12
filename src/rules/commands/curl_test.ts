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

Deno.test("curl `--` option terminator asks (conservative, not in safe set)", () => {
  assertEquals(curlRule.evaluate(ctxOf("curl -- https://api.example.com/")).kind, "ask");
});

Deno.test("curl --header long form with @file applies read scope", () => {
  assertEquals(
    curlRule.evaluate(ctxOf("curl --header=@headers.txt https://api.example.com/")).kind,
    "allow", // inline 值、專案內
  );
  assertEquals(
    curlRule.evaluate(ctxOf("curl --header @headers.txt https://api.example.com/")).kind,
    "allow", // 下一 token 值、專案內
  );
  assertEquals(
    curlRule.evaluate(ctxOf("curl --header=@/etc/headers https://api.example.com/")).kind,
    "ask", // inline 值、專案外
  );
});
