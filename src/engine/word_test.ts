import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { isStatic, staticValue } from "./word.ts";

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
