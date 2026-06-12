import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cdRule, diffRule, fileReaderRule, pureUtilRule } from "./coreutils.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
import type { CwdState } from "../../types.ts";

function ctxOf(src: string, cwd: CwdState = { kind: "known", path: "/proj" }): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  return {
    name: cmd.name!.value,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    resolveUrl: () => "not-allowed",
  };
}

Deno.test("fileReader allows in-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat src/a.ts")).kind, "allow");
});

Deno.test("fileReader asks for out-of-project file", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat /etc/passwd")).kind, "ask");
});

Deno.test("fileReader asks for dynamic path", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("cat $X")).kind, "ask");
});

Deno.test("pureUtil always allows (no file operands)", () => {
  assertEquals(pureUtilRule.evaluate(ctxOf("echo hello world")).kind, "allow");
  assertEquals(pureUtilRule.evaluate(ctxOf("whoami")).kind, "allow");
});

Deno.test("fileReader scope-checks basename path operand", () => {
  assertEquals(fileReaderRule.evaluate(ctxOf("basename src/a.ts")).kind, "allow");
  assertEquals(fileReaderRule.evaluate(ctxOf("realpath /etc/passwd")).kind, "ask");
});

Deno.test("cd always allows", () => {
  assertEquals(cdRule.evaluate(ctxOf("cd /anywhere")).kind, "allow");
});

Deno.test("rules expose expected names", () => {
  assertEquals(fileReaderRule.names.includes("cat"), true);
  assertEquals(pureUtilRule.names.includes("echo"), true);
  assertEquals(cdRule.names, ["cd"]);
});

Deno.test("diff --from-file= out-of-project asks", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff --from-file=/etc/passwd readme.md")).kind, "ask");
});

Deno.test("diff out-of-project positional asks", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff readme.md /etc/passwd")).kind, "ask");
});

Deno.test("diff in-project files allows", () => {
  assertEquals(diffRule.evaluate(ctxOf("diff a.txt b.txt")).kind, "allow");
});
