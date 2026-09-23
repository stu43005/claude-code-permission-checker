import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { evalSubstitutionWord, resultIsUsable } from "./subst_eval.ts";
import type { CwdState } from "../types.ts";

const CWD: CwdState = { kind: "known", path: "/proj" };

function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("framework: 未註冊的指令名不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(uname -a)"'), CWD), null);
});

Deno.test("framework: 未加引號的 substitution 一律不求值", () => {
  // bash 對未加引號的展開做 word splitting 與空值移除，語義與單一字串不同
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo foo)"), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf("cd $(echo -n)"), CWD), null);
});

Deno.test("framework: 混合 word 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo foo)/sub"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "pre$(echo foo)"'), CWD), null);
});

Deno.test("framework: 內層有 pipeline / 多 statement / 重導向 / 賦值前綴皆不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a | tr a b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a; echo b)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo a > /tmp/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(FOO=1 echo a)"'), CWD), null);
});

Deno.test("framework: 動態 argv 不求值", () => {
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo $X)"'), CWD), null);
});

Deno.test("framework: argv 含未加引號 tilde 不求值", () => {
  // 外層 substitution 的雙引號不會抑制內層的 tilde expansion
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/x)"'), CWD), null);
  assertEquals(evalSubstitutionWord(wordOf('cd "$(echo ~/"src")"'), CWD), null);
});

Deno.test("framework: 非 substitution 的 word 回 null", () => {
  assertEquals(evalSubstitutionWord(wordOf("cd /proj/src"), CWD), null);
});

Deno.test("framework: 結果過濾述詞", () => {
  // 現有求值器本身都不產生換行，故直接對述詞斷言，確保這兩條過濾規則有被執行到
  assertEquals(resultIsUsable("/proj/src"), true);
  assertEquals(resultIsUsable(""), false);
  assertEquals(resultIsUsable("a\nb"), false);
  assertEquals(resultIsUsable("a\r\nb"), false);
});
