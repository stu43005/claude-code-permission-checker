import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { ghRule } from "./gh.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";

function ctxOf(src: string): RuleContext {
  const cmd = parse(src).commands[0].command as Command;
  const cwd = { kind: "known", path: "/proj" } as const;
  return {
    name: "gh",
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
  assertEquals(v("gh api -fname=x repos/o/r"), "ask"); // 黏寫 -f
  assertEquals(v("gh api -FFILE=@data.json repos/o/r"), "ask"); // 黏寫 -F
  assertEquals(v("gh api --method=DELETE repos/o/r"), "ask"); // = 形式
  assertEquals(v("gh api --method=get repos/o/r"), "allow"); // GET 不分大小寫
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

Deno.test("gh local side-effect flags ask", () => {
  assertEquals(v("gh search code x --web"), "ask");
  assertEquals(v("gh repo view -w"), "ask");
  assertEquals(v("gh pr diff --web"), "ask");
  assertEquals(v("gh api repos/o/r/tags --cache 1h"), "ask");
  assertEquals(v("gh api repos/o/r/tags --cache=1h"), "ask");
});

Deno.test("gh unknown flags ask", () => {
  assertEquals(v("gh api repos/o/r --totally-unknown"), "ask");
  assertEquals(v("gh search code x --good-first-issues"), "ask");
});

Deno.test("gh known safe flags still allow", () => {
  assertEquals(v("gh api repos/o/r -H 'Accept: application/vnd.github.raw'"), "allow");
  assertEquals(v("gh api repos/o/r --paginate --jq '.[].name'"), "allow");
  assertEquals(v("gh api repos/o/r -X GET"), "allow");
  assertEquals(v("gh search code x --language go --limit 10"), "allow");
  assertEquals(v("gh issue list --repo o/r --state open"), "allow");
});

Deno.test("non-GET methods ask in every flag form", () => {
  assertEquals(v("gh api repos/o/r -X POST"), "ask");
  assertEquals(v("gh api repos/o/r -XPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iXPOST"), "ask");
  assertEquals(v("gh api repos/o/r -iX DELETE"), "ask");
  assertEquals(v("gh api repos/o/r --method=PATCH"), "ask");
  assertEquals(v("gh api repos/o/r -f a=b"), "ask");
  assertEquals(v("gh api repos/o/r --input body.json"), "ask");
});

Deno.test("gh api tolerates a single-? query string in the endpoint", () => {
  assertEquals(v("gh api repos/o/r/tags?per_page=50"), "allow");
  assertEquals(v("gh api repos/o/r/contents/pkg/x.go?ref=v1.18.0"), "allow");
  assertEquals(v("gh api -X GET repos/o/r/tags?per_page=50"), "allow");
});

Deno.test("gh api rejects other glob shapes in the endpoint", () => {
  assertEquals(v("gh api repos/o/*/x"), "ask");
  assertEquals(v("gh api rep?s/o/r/x"), "ask");
  assertEquals(v("gh api ?x"), "ask");
  assertEquals(v("gh api a?b c?d"), "ask");
});

Deno.test("the tolerance never applies to a flag value", () => {
  assertEquals(v("gh api x -H Accept:a?b"), "ask");
  assertEquals(v("gh api -H Accept:a/b?c repos/o/r"), "ask");
  assertEquals(v("gh issue list --repo o/r?x"), "ask");
});

Deno.test("placeholder endpoints keep their ordinary verdict but lose the exemption", () => {
  assertEquals(v("gh api 'repos/{owner}/{repo}/issues'"), "allow");
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api 'repos/{owner}/{repo}/issues'")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api -X GET 'repos/{owner}/{repo}/issues'")), false);
});

Deno.test("flags before the subcommand are still checked", () => {
  assertEquals(v("gh -XPOST api repos/o/r"), "ask");
  assertEquals(v("gh -X POST api repos/o/r"), "ask");
  assertEquals(v("gh --method=PATCH api repos/o/r"), "ask");
  assertEquals(v("gh --method PATCH api repos/o/r"), "ask");
  assertEquals(v("gh --cache=1h api repos/o/r"), "ask");
  assertEquals(v("gh --web repo view"), "ask");
  assertEquals(v("gh --totally-unknown api repos/o/r"), "ask");
  // 合法的前置旗標仍放行——包含「分開寫的值」形式，其值不可被誤認為子指令
  assertEquals(v("gh -X GET api repos/o/r"), "allow");
  assertEquals(v("gh -XGET api repos/o/r"), "allow");
  assertEquals(v("gh --method GET api repos/o/r"), "allow");
  assertEquals(v("gh --method=GET api repos/o/r"), "allow");
  assertEquals(v("gh -H 'Accept: x' api repos/o/r"), "allow");
  // 子指令前出現位置參數 → 保守否決
  assertEquals(v("gh x api repos/o/r"), "ask");
});

Deno.test("glob position is judged on the raw token, not the quote-removed value", () => {
  // `a\?b`：quote removal 後是 `a\?b`，重掃會找不到元字元；必須用原始位置判定
  assertEquals(v("gh api a" + "\\\\" + "?b"), "ask");
  // 反向：`rep\?os/...` 的 `?` 是被跳脫的字面值，不是活躍 glob → 不應被位置護欄誤殺
  assertEquals(v("gh api rep" + "\\" + "?os/o/r/x"), "allow");
});

Deno.test("a rescued endpoint may not contain braces", () => {
  // 未加引號的 `?` 可展開成 `{` / `}`，形成 cwd 佔位符
  assertEquals(v("gh api repos/o/r/x?owner}"), "ask");
  assertEquals(v("gh api 'repos/o/r/x{owner}'"), "allow"); // 加引號、未經寬鬆取值
});

Deno.test("only api and search are cwd-independent", () => {
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api repos/o/r/tags?per_page=50")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh search code x")), true);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh pr diff")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh repo view")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh issue list --repo o/r")), false);
  assertEquals(ghRule.cwdIndependent!(ctxOf("gh api x --cache 1h")), false);
});
