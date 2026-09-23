import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { base64Rule } from "./base64.ts";
import { fileReaderRule } from "./coreutils.ts";
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

Deno.test("base64: 無操作元讀 stdin → allow", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -d")).kind, "allow");
});

Deno.test("base64: 專案內檔案 → allow", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -d src/a.ts")).kind, "allow");
});

Deno.test("base64: -w 吃值，其值不得被當成路徑", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 --wrap=0 src/a.ts")).kind, "allow");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0")).kind, "allow");
  // 關鍵斷言：`0` 若被誤當成路徑操作元，它本身會解析成專案內的 /proj/0 而測不出錯。
  // 改用一個「當成路徑就會超出範圍」的值，才真正釘住 -w 吃值這件事。
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w /etc/passwd src/a.ts")).kind, "allow");
});

Deno.test("base64: 專案外檔案 → ask", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 /etc/passwd")).kind, "ask");
  assertEquals(base64Rule.evaluate(ctxOf("base64 -w 0 /etc/passwd")).kind, "ask");
});

Deno.test("base64: 未知旗標與動態 token → ask", () => {
  assertEquals(base64Rule.evaluate(ctxOf("base64 -Z src/a.ts")).kind, "ask");
  assertEquals(base64Rule.evaluate(ctxOf("base64 $X")).kind, "ask");
});

Deno.test("迴歸：base64 的 -w arity 不得外溢到 fileReaderRule 其他成員", () => {
  // md5sum 的 -w 是不吃值的 --warn，其後的路徑仍是操作元，必須被範圍檢查擋下
  assertEquals(fileReaderRule.evaluate(ctxOf("md5sum -c -w /outside/checksums")).kind, "ask");
});
