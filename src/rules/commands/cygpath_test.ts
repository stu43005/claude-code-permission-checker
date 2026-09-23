import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { cygpathRule } from "./cygpath.ts";
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

Deno.test("cygpath 形態 A：純字串轉換，操作元不做範圍檢查", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -u /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -m /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t unix /outside/x")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -p /a:/b")).kind, "allow");
});

Deno.test("cygpath 形態 A：宣告 cwdIndependent", () => {
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -u /outside/x")), true);
});

Deno.test("cygpath 形態 B：查檔案系統，操作元需在專案內", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -d src/a.ts")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -d /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -s /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -l /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -M /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t dos /outside/x")).kind, "ask");
});

Deno.test("cygpath 形態 B：不得宣告 cwdIndependent", () => {
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -d src/a.ts")), false);
});

Deno.test("cygpath 形態 C：輸出系統目錄，無操作元", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -D")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -S")).kind, "allow");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -F 0")).kind, "allow");
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -D")), true);
});

Deno.test("cygpath 形態 C：帶路徑操作元 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -D /outside/x")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -F 0 /outside/x")).kind, "ask");
});

Deno.test("cygpath：-t 未知值 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -t nonsense src/a.ts")).kind, "ask");
});

Deno.test("cygpath：-p 與查檔案系統的旗標併用 → ask", () => {
  // -p 的操作元是 PATH 列表，整串丟給 resolvePath 會被當成單一路徑而誤判
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -s -p src:/c/Windows")).kind, "ask");
  // 但 -p 單用（純字串轉換）仍 allow
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -p /a:/b")).kind, "allow");
});

Deno.test("cygpath：形態 B 的每個旗標都不得取得 cwd 豁免", () => {
  for (const flag of ["-d", "-s", "-l", "-M"]) {
    assertEquals(
      cygpathRule.cwdIndependent?.(ctxOf(`cygpath ${flag} src/a.ts`)),
      false,
      `${flag} 不應豁免`,
    );
  }
  assertEquals(cygpathRule.cwdIndependent?.(ctxOf("cygpath -t dos src/a.ts")), false);
});

Deno.test("cygpath：讀檔旗標與未知旗標 → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -f list.txt")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -o opts.txt")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -c 123")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -Z /x")).kind, "ask");
});

Deno.test("cygpath：動態 token → ask", () => {
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -u $X")).kind, "ask");
});

Deno.test("cygpath 形態 B：磁碟相對操作元 → ask", () => {
  // C:Windows 的基準是 C 磁碟的當前目錄，不是 /proj 底下
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -d C:Windows")).kind, "ask");
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -w -s C:Windows")).kind, "ask");
});

Deno.test("cygpath 形態 A：磁碟相對操作元仍 allow（不做範圍檢查）", () => {
  // 形態 A 只改寫路徑的書寫形式，不查檔案系統、不洩漏任何狀態
  assertEquals(cygpathRule.evaluate(ctxOf("cygpath -u C:Windows")).kind, "allow");
});
