import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { findRule } from "./find.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "find",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("find search in-project allows", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -name '*.ts'")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find src tests -type f")).kind, "allow");
});

Deno.test("find -delete asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -delete")).kind, "ask");
});

Deno.test("find -exec asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -exec rm {} ;")).kind, "ask");
});

Deno.test("find -fprintf asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find . -fprintf out '%p'")).kind, "ask");
});

Deno.test("find out-of-project start path asks", () => {
  assertEquals(findRule.evaluate(ctxOf("find /etc -name passwd")).kind, "ask");
});

Deno.test("find 遞迴遍歷根/家目錄 -> deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find /")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find ~")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find $HOME")).kind, "deny");
  assertEquals(findRule.evaluate(ctxOf("find ${HOME}")).kind, "deny");
});

Deno.test("find 根/家目錄的子路徑 -> 非 deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find ~/.claude")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find .")).kind, "allow");
  assertEquals(findRule.evaluate(ctxOf("find /usr")).kind, "ask");
});

Deno.test("find action flag 優先於根 deny", () => {
  assertEquals(findRule.evaluate(ctxOf("find / -delete")).kind, "ask");
});
