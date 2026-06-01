import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { ghRule } from "./gh.ts";
import type { RuleContext } from "../types.ts";
import { resolvePath, resolvePathValue } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "gh",
    argv: cmd.suffix,
    redirects: cmd.redirects,
    assignments: cmd.prefix,
    cwd,
    resolvePath: (w) => resolvePath(w, cwd, "/proj"),
    resolvePathValue: (v) => resolvePathValue(v, cwd, "/proj"),
  };
}

function v(src: string) {
  return ghRule.evaluate(ctxOf(src)).kind;
}

Deno.test("gh repo view/list allow, clone/create ask", () => {
  assertEquals(v("gh repo view owner/repo"), "allow");
  assertEquals(v("gh repo list"), "allow");
  assertEquals(v("gh repo clone owner/repo"), "ask");
  assertEquals(v("gh repo create x"), "ask");
});

Deno.test("gh search always allows", () => {
  assertEquals(v("gh search repos cli"), "allow");
  assertEquals(v("gh search code foo"), "allow");
  assertEquals(v("gh search issues bar"), "allow");
});

Deno.test("gh api GET allows, mutating asks", () => {
  assertEquals(v("gh api repos/o/r"), "allow");
  assertEquals(v("gh api -X GET repos/o/r"), "allow");
  assertEquals(v("gh api --paginate repos/o/r"), "allow");
  assertEquals(v("gh api -X POST repos/o/r"), "ask");
  assertEquals(v("gh api --method DELETE repos/o/r"), "ask");
  assertEquals(v("gh api -XPATCH repos/o/r"), "ask");
  assertEquals(v("gh api -f name=x repos/o/r"), "ask");
  assertEquals(v("gh api --field a=b repos/o/r"), "ask");
});

Deno.test("gh issue read allows, write asks", () => {
  assertEquals(v("gh issue view 1"), "allow");
  assertEquals(v("gh issue list"), "allow");
  assertEquals(v("gh issue status"), "allow");
  assertEquals(v("gh issue create"), "ask");
  assertEquals(v("gh issue close 1"), "ask");
});

Deno.test("gh pr read allows, write asks", () => {
  assertEquals(v("gh pr view 1"), "allow");
  assertEquals(v("gh pr list"), "allow");
  assertEquals(v("gh pr diff"), "allow");
  assertEquals(v("gh pr checks 1"), "allow");
  assertEquals(v("gh pr merge 1"), "ask");
  assertEquals(v("gh pr create"), "ask");
});

Deno.test("gh release view/list allow, download/create ask", () => {
  assertEquals(v("gh release view v1.0"), "allow");
  assertEquals(v("gh release list"), "allow");
  assertEquals(v("gh release download v1.0"), "ask");
  assertEquals(v("gh release create v1.0"), "ask");
});

Deno.test("gh other commands and missing/dynamic ask", () => {
  assertEquals(v("gh auth status"), "ask");
  assertEquals(v("gh gist create"), "ask");
  assertEquals(v("gh"), "ask");
  assertEquals(v("gh $CMD"), "ask");
  assertEquals(v("gh repo"), "ask"); // 無子指令
});
