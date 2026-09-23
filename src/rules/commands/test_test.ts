import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { testRule } from "./test.ts";
import type { RuleContext } from "../types.ts";
import { dangerousRoot, resolvePath, resolvePathValue, rootScope } from "../../engine/scope.ts";
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
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}

Deno.test("test: 一元檔案測試 + 專案內路徑 → allow", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f src/a.ts")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -d src")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -e node_modules/tarn/README.md")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -s src/a.ts")).kind, "allow");
  assertEquals(testRule.evaluate(ctxOf("test -L src/a.ts")).kind, "allow");
});

Deno.test("test: 專案外路徑 → ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f /etc/passwd")).kind, "ask");
});

Deno.test("test: tilde 操作元依引號與否分流", () => {
  // 未加引號 → bash 展開為 $HOME（專案外）。ctxOf 的 rootScope 未設 shellHome → 不可解析 → ask
  assertEquals(testRule.evaluate(ctxOf("test -f ~/secret")).kind, "ask");
  // 加引號 → bash 不展開，指向 /proj/~/secret（專案內）→ allow
  assertEquals(testRule.evaluate(ctxOf('test -f "~/secret"')).kind, "allow");
});

Deno.test("test: 雙重語義的 -a / -o 一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -a src/a.ts")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -o emacs")).kind, "ask");
});

Deno.test("test: 操作元非路徑的運算子一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -t 0")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -n foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -z foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -v HOME")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -R HOME")).kind, "ask");
});

Deno.test("test: 參數個數不是 2 一律 ask", () => {
  // 單參數時 `-f` 只是非空字串，不是運算子
  assertEquals(testRule.evaluate(ctxOf("test -f")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test foo")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test -f src/a.ts -a -f src/b.ts")).kind, "ask");
});

Deno.test("test: 二元與邏輯運算子一律 ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test a = b")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test 1 -eq 2")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test src/a.ts -nt src/b.ts")).kind, "ask");
  assertEquals(testRule.evaluate(ctxOf("test ! -f src/a.ts")).kind, "ask");
});

Deno.test("test: 動態操作元 → ask", () => {
  assertEquals(testRule.evaluate(ctxOf("test -f $X")).kind, "ask");
});
