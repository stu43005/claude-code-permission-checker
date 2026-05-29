import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { exact, hasAnyFlag, positionals, prefix } from "./flags.ts";

function argvOf(src: string) {
  return (parse(src).commands[0].command as Command).suffix;
}

Deno.test("hasAnyFlag matches exact and prefix", () => {
  const matchers = [exact("-i", "--in-place"), prefix("-i")];
  assertEquals(hasAnyFlag(argvOf("sed -i 's/a/b/' f"), matchers), true);
  assertEquals(hasAnyFlag(argvOf("sed -i.bak 's/a/b/' f"), matchers), true);
  assertEquals(hasAnyFlag(argvOf("sed -n '1,5p' f"), matchers), false);
});

Deno.test("positionals skips value-consuming flags", () => {
  // -l 吃掉 16，剩 file 是唯一位置參數
  const valueFlags = [exact("-l", "-s", "-c", "-g")];
  const got = positionals(argvOf("xxd -l 16 file"), valueFlags).map((w) => w.value);
  assertEquals(got, ["file"]);
});

Deno.test("positionals counts two when output file present", () => {
  const valueFlags = [exact("-l", "-s", "-c", "-g")];
  const got = positionals(argvOf("xxd in out.bin"), valueFlags).map((w) => w.value);
  assertEquals(got, ["in", "out.bin"]);
});

Deno.test("positionals ignores --opt=val single tokens", () => {
  const got = positionals(argvOf("sort --buffer-size=1M file"), []).map((w) => w.value);
  // --buffer-size=1M 是單一 token 旗標（以 - 開頭），file 是位置參數
  assertEquals(got, ["file"]);
});
