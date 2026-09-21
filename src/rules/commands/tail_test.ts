import { assertEquals } from "@std/assert";
import { parse } from "../../deps.ts";
import type { Command } from "../../deps.ts";
import { tailRule } from "./tail.ts";
import { lookupRule } from "../allowlist.ts";
import type { RuleContext } from "../types.ts";
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
    resolveUrl: () => "not-allowed",
    isDangerousRoot: (w) => dangerousRoot(w, cwd, null),
  };
}
const v = (src: string) => tailRule.evaluate(ctxOf("tail", src)).kind;

Deno.test("tail follow → ask", () => {
  assertEquals(v("tail -f log"), "ask");
  assertEquals(v("tail -F log"), "ask");
  assertEquals(v("tail --follow log"), "ask");
  assertEquals(v("tail --follow=name log"), "ask");
  assertEquals(v("tail --retry log"), "ask");
  assertEquals(v("tail -fn10 log"), "ask");   // 短旗標群集含 f + 數字
  assertEquals(v("tail -Fq log"), "ask");     // 短旗標群集含 F
});

Deno.test("tail 非 follow → allow（唯讀）", () => {
  assertEquals(v("tail log"), "allow");
  assertEquals(v("tail -n 20 log"), "allow");
  assertEquals(v("tail -f /etc/x"), "ask");   // follow 先於範圍
});

Deno.test("tail 在 allowlist；cut -f 不受影響", () => {
  assertEquals(lookupRule("tail"), tailRule);
  assertEquals(lookupRule("cut")?.evaluate(ctxOf("cut", "cut -f1 data.csv")).kind, "allow");
});

Deno.test("tail numeric shorthand and -n value are not paths", () => {
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -200")).kind, "allow");
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -n 200")).kind, "allow");
});

Deno.test("tail declares cwd-independence only with no operands", () => {
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -200")), true);
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -200 a.txt")), false);
  // -f 時 evaluate 判 ask，護欄 1 因此不會讓它豁免；述詞本身也應回 false
  assertEquals(tailRule.cwdIndependent!(ctxOf("tail", "tail -f")), false);
});

Deno.test("tail -f still asks", () => {
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -f a.txt")).kind, "ask");
  assertEquals(tailRule.evaluate(ctxOf("tail", "tail -f")).kind, "ask");
});
