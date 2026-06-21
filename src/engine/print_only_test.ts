import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { wordPrintEligible } from "./print_only.ts";

/** 取 `echo …` 第一個引數 Word。 */
function arg0(src: string) {
  return (parse(src).commands[0].command as Command).suffix[0];
}

Deno.test("wordPrintEligible: 靜態字面 / 命令替換 → 合格", () => {
  assertEquals(wordPrintEligible(arg0('echo hi')), true);
  assertEquals(wordPrintEligible(arg0('echo "$(echo x)"')), true);
  assertEquals(wordPrintEligible(arg0('echo a$(c)b')), true);
});

Deno.test("wordPrintEligible: 變數 / glob / brace / 混合 → 不合格", () => {
  assertEquals(wordPrintEligible(arg0('echo "$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo "$(c)$VAR"')), false);
  assertEquals(wordPrintEligible(arg0('echo *$(echo x)')), false); // 頂層未引號 glob Literal
  assertEquals(wordPrintEligible(arg0('echo ?$(c)')), false);      // ? glob + 替換 → 不合格
  assertEquals(wordPrintEligible(arg0('echo *.txt')), false);
  assertEquals(wordPrintEligible(arg0('echo {1..5}')), false);     // brace expansion → 動態
  assertEquals(wordPrintEligible(arg0('echo "*"$(c)')), true);     // 引號保護 glob → 合格
});
