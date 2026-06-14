import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { dateRule, fileCmdRule, sortRule, treeRule, yqRule } from "./simple-flag.ts";
import type { CommandRule, RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(name: string, src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name,
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, rootScope("/proj")),
    resolvePathValue: (v) => resolvePathValue(v, cwd, rootScope("/proj")),
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

function v(rule: CommandRule, name: string, src: string) {
  return rule.evaluate(ctxOf(name, src)).kind;
}

Deno.test("sort allows plain, asks on -o / -T", () => {
  assertEquals(v(sortRule, "sort", "sort file"), "allow");
  assertEquals(v(sortRule, "sort", "sort -k 2 file"), "allow"); // -k 吃值 2
  assertEquals(v(sortRule, "sort", "sort -o out.txt file"), "ask");
  assertEquals(v(sortRule, "sort", "sort --output=out file"), "ask");
  assertEquals(v(sortRule, "sort", "sort -T /tmp file"), "ask");
});

Deno.test("yq allows read, asks on -i", () => {
  assertEquals(v(yqRule, "yq", "yq '.a' f.yml"), "allow");
  assertEquals(v(yqRule, "yq", "yq -i '.a=1' f.yml"), "ask");
  assertEquals(v(yqRule, "yq", "yq --inplace '.a=1' f.yml"), "ask");
});

Deno.test("tree allows, asks on -o", () => {
  assertEquals(v(treeRule, "tree", "tree src"), "allow");
  assertEquals(v(treeRule, "tree", "tree -o t.txt"), "ask");
});

Deno.test("file allows, asks on -C", () => {
  assertEquals(v(fileCmdRule, "file", "file a.bin"), "allow");
  assertEquals(v(fileCmdRule, "file", "file -C -m mymagic"), "ask");
});

Deno.test("date allows, asks on -s", () => {
  assertEquals(v(dateRule, "date", "date '+%Y'"), "allow");
  assertEquals(v(dateRule, "date", "date -s '2020-01-01'"), "ask");
});

Deno.test("sort out-of-project file asks", () => {
  assertEquals(v(sortRule, "sort", "sort /etc/passwd"), "ask");
});
