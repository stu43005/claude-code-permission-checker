import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isStatic, staticValue } from "./word.ts";
import { firstGlobMetacharIndex, nonPathStaticValue } from "./word.ts";

/** 解析單一指令並回傳第一個 argv Word。 */
function firstArg(src: string) {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("static literal word", () => {
  const w = firstArg("cat file.txt");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "file.txt");
});

Deno.test("single-quoted word is static", () => {
  const w = firstArg("cat 'a b.txt'");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "a b.txt");
});

Deno.test("word with variable expansion is dynamic", () => {
  const w = firstArg("cat $FILE");
  assertEquals(isStatic(w), false);
  assertEquals(staticValue(w), null);
});

Deno.test("word with command substitution is dynamic", () => {
  const w = firstArg("cat $(ls)");
  assertEquals(isStatic(w), false);
  assertEquals(staticValue(w), null);
});

Deno.test("double-quoted word with expansion is dynamic", () => {
  const w = firstArg('cat "$HOME/x"');
  assertEquals(isStatic(w), false);
});

Deno.test("unquoted glob word is dynamic", () => {
  assertEquals(isStatic(firstArg("cat *.txt")), false);
  assertEquals(isStatic(firstArg("cat ?.txt")), false);
  assertEquals(isStatic(firstArg("cat [ab].txt")), false);
});

Deno.test("quoted glob is static (glob chars protected by quotes)", () => {
  const w = firstArg("cat '*.txt'");
  assertEquals(isStatic(w), true);
  assertEquals(staticValue(w), "*.txt");
});

Deno.test("staticValue：無 parts 未引號反斜線跳脫做 bash quote removal", () => {
  const w = (src: string) => (parse(src).commands[0].command as Command).name!;
  const a = (src: string) => (parse(src).commands[0].command as Command).suffix[0];
  assertEquals(staticValue(w("sl\\eep")), "sleep");
  assertEquals(staticValue(w("fin\\d")), "find");
  assertEquals(staticValue(a("tail -\\f")), "-f");
  assertEquals(staticValue(a("echo \\*")), "*");      // 跳脫的 * 是字面、仍靜態
  assertEquals(staticValue(a("echo *.txt")), null);   // 未跳脫 glob → 動態
  assertEquals(isStatic(a("echo \\*")), true);
  assertEquals(isStatic(a("echo *.txt")), false);
});

function wordOf(src: string) {
  const cmd = parse(`x ${src}`).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("firstGlobMetacharIndex finds the first unescaped metachar", () => {
  assertEquals(firstGlobMetacharIndex("abc"), -1);
  assertEquals(firstGlobMetacharIndex("ab?c"), 2);
  assertEquals(firstGlobMetacharIndex("a*b?c"), 1);
  assertEquals(firstGlobMetacharIndex("a[bc]"), 1);
  assertEquals(firstGlobMetacharIndex("a\\*b?c"), 4);
  assertEquals(firstGlobMetacharIndex("?abc"), 0);
});

Deno.test("nonPathStaticValue tolerates a single-? query string", () => {
  const r = nonPathStaticValue(wordOf("repos/o/r/tags?per_page=50"))!;
  assertEquals(r.value, "repos/o/r/tags?per_page=50");
  assertEquals(r.globIndex, "repos/o/r/tags".length);
  assertEquals(r.raw, "repos/o/r/tags?per_page=50");
});

Deno.test("globIndex is measured on the raw string, so escapes survive", () => {
  // `a\?b`：`\` 是被跳脫的反斜線，`?` 是活躍 glob（索引 3）
  const active = nonPathStaticValue(wordOf("a" + "\\\\" + "?b"))!;
  assertEquals(active.globIndex, 3);
  assertEquals(active.value, "a" + "\\" + "?b"); // quote removal 後仍留一個反斜線
  // 對 value 重跑 firstGlobMetacharIndex 會得到 -1 —— 正是不可這樣做的原因
  assertEquals(firstGlobMetacharIndex(active.value), -1);
});

Deno.test("nonPathStaticValue passes already-static words straight through", () => {
  // 本就靜態者 globIndex 為 -1：無活躍元字元，呼叫端不需做位置判定
  const cases: Array<[string, string]> = [
    ["plain/endpoint", "plain/endpoint"],
    ["'a?b/c'", "a?b/c"],
    ['"a*b"', "a*b"],
    ["a\\b", "ab"], // 無未跳脫元字元 → staticValue 已回字面值
  ];
  for (const [src, expected] of cases) {
    const r = nonPathStaticValue(wordOf(src))!;
    assertEquals(r.value, expected, src);
    assertEquals(r.globIndex, -1, src);
  }
});

Deno.test("an unquoted backslash plus an active ? goes through quote removal", () => {
  const r = nonPathStaticValue(wordOf("a\\b?c"))!;
  assertEquals(r.value, "ab?c");
  assertEquals(r.globIndex, 3); // 原字串 `a\b?c` 中 `?` 的索引
});

Deno.test("a word with parts is never relaxed (quote provenance is unrecoverable)", () => {
  // 引號內的反斜線在 word.value 中與 shell 跳脫無法區分，逐字掃描會誤放後面的 `*`
  assertEquals(nonPathStaticValue(wordOf("'a\\'*b?c")), null);
  assertEquals(nonPathStaticValue(wordOf('"a"?b')), null);
});

Deno.test("nonPathStaticValue rejects everything outside the tolerated shape", () => {
  assertEquals(nonPathStaticValue(wordOf("a*b")), null);
  assertEquals(nonPathStaticValue(wordOf("a[bc]")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b?c")), null);
  assertEquals(nonPathStaticValue(wordOf("?abc")), null);
  assertEquals(nonPathStaticValue(wordOf("a?b/c")), null);
  assertEquals(nonPathStaticValue(wordOf("$X")), null);
  assertEquals(nonPathStaticValue(wordOf("$(x)")), null);
});
