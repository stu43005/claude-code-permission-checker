import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { sedRule } from "./sed.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "sed",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

Deno.test("sed -n print range allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '30,45p' file")).kind, "allow");
});

Deno.test("sed delete to stdout allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '/foo/d' file")).kind, "allow");
});

Deno.test("sed substitution allows", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/g' file")).kind, "allow");
});

Deno.test("sed -i asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -i.bak asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -i.bak 's/a/b/' file")).kind, "ask");
});

Deno.test("sed -f scriptfile asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -f prog.sed file")).kind, "ask");
});

Deno.test("sed s///w write flag asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed 's/a/b/w out' file")).kind, "ask");
});

Deno.test("sed w command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n 'w out' file")).kind, "ask");
});

Deno.test("sed e exec command asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed '1e cat /etc/passwd' file")).kind, "ask");
});

Deno.test("sed allowed form but out-of-project file asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed -n '1,5p' /etc/passwd")).kind, "ask");
});

Deno.test("sed with no static program (dynamic) asks", () => {
  assertEquals(sedRule.evaluate(ctxOf("sed $PROG file")).kind, "ask");
});
