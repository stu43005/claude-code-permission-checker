import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { expandTilde, hasUnquotedLeadingTilde } from "./tilde.ts";

/** 取出 `cd <word>` 的第一個 argv Word。 */
function wordOf(src: string): Word {
  const cmd = parse(src).commands[0].command as Command;
  return cmd.suffix[0];
}

Deno.test("hasUnquotedLeadingTilde: 未加引號的 ~ 會被 bash 展開", () => {
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~")), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~/src")), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~user/x")), true);
});

Deno.test("hasUnquotedLeadingTilde: 引號抑制展開", () => {
  // `cd "~"` 的 value 同樣是 "~"，只有 word 結構能區分
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd "~"')), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd '~/x'")), false);
});

Deno.test("hasUnquotedLeadingTilde: 混合引號形態的開頭 ~ 仍會展開", () => {
  // parts = [Literal("~/"), DoubleQuoted]
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd ~/"src"')), true);
});

Deno.test("hasUnquotedLeadingTilde: 不以 ~ 開頭者一律 false", () => {
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd src")), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd "$(echo x)"')), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd a~b")), false);
});

Deno.test("hasUnquotedLeadingTilde: tilde-prefix 內含引號時 bash 不展開", () => {
  // prefix 是 `~""`（到第一個未加引號的 /），含引號 → 不展開，字面 ./~/src
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd ~""/src')), false);
  // 整個 word 都在 prefix 內且含引號 → 不展開
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd ~"/src"')), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~''/src")), false);
});

Deno.test("hasUnquotedLeadingTilde: prefix 乾淨時仍展開（引號只落在 prefix 之後）", () => {
  // prefix 是 `~`，第一個未加引號的 / 之後才有引號 → 照常展開
  assertEquals(hasUnquotedLeadingTilde(wordOf('cd ~/"src"')), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf(`cd ~/'src'/x`)), true);
});

Deno.test("hasUnquotedLeadingTilde: 反斜線跳脫的 / 不終止 tilde-prefix", () => {
  // 實測 `echo ~\/src` → `~/src`（不展開），`echo ~/src` → `$HOME/src`（展開）
  assertEquals(hasUnquotedLeadingTilde(wordOf(String.raw`cd ~\/src`)), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf(String.raw`cd ~us\er`)), false);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~/src")), true);
  assertEquals(hasUnquotedLeadingTilde(wordOf("cd ~user")), true);
});

Deno.test("expandTilde: 只支援 ~ 與 ~/<rest>", () => {
  assertEquals(expandTilde("~", "/home/u"), "/home/u");
  assertEquals(expandTilde("~/x/y", "/home/u"), "/home/u/x/y");
});

Deno.test("expandTilde: 其餘形態不可解析", () => {
  assertEquals(expandTilde("~user", "/home/u"), null);
  assertEquals(expandTilde("~user/x", "/home/u"), null);
  assertEquals(expandTilde("~+", "/home/u"), null);
  assertEquals(expandTilde("~-", "/home/u"), null);
  assertEquals(expandTilde("~+1", "/home/u"), null);
  assertEquals(expandTilde("src", "/home/u"), null);
});

Deno.test("expandTilde: shellHome 未知時不可解析", () => {
  assertEquals(expandTilde("~/x", null), null);
  assertEquals(expandTilde("~/x", "   "), null);
});
