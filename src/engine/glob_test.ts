import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command, Word } from "../deps.ts";
import { hasGlobstarSegment, isGlobAttachedValue, mayExpandToOption, parseGlobPath } from "./glob.ts";

/** 取出 `x <word>` 的那個 Word（x 只是佔位指令名）。 */
function w(src: string): Word {
  return (parse(`x ${src}`).commands[0].command as Command).suffix[0];
}

Deno.test("parseGlobPath: 接受的形態與其 prefix", () => {
  const cases: [string, string][] = [
    ["*.md", ""],
    ["runtime-behavior/*.md", "runtime-behavior"],
    ["src/**/*.ts", "src"],
    ["./*.md", "."],
    ["./*/x.md", "."],
    ["/d/proj/*.md", "/d/proj"],
    ["../x/*.md", "../x"],
    ["/*.md", "/"],
    ["C:/*.md", "C:/"], // 磁碟根前綴必須保留分隔符，否則會被當成相對路徑
    ["C:/proj/*.md", "C:/proj"],
    ["src//*.md", "src/"], // 空段可接受（原樣連接）
    ["src/*/", "src"], // 結尾 / 可接受
  ];
  for (const [src, prefix] of cases) {
    assertEquals(parseGlobPath(w(src)), { prefix }, src);
  }
});

Deno.test("parseGlobPath: 拒絕的形態", () => {
  for (
    const src of [
      "*/outside/secret", // 可能展開成旗標的多段 glob
      "*/x.md",
      "-*",
      "~/*.md",
      '"src"/*.md', // 含引號片段
      "src/\\*.md", // 含反斜線
      "C:*.md", // 磁碟相對
      "sub*/../x", // glob 段之後的字面 ..
      ".*", // . 開頭的 glob 段
      "sub/.*",
      "[.]*", // [ 開頭的 glob 段
      "x/[ab]*",
      "a.md", // 無 glob
    ]
  ) {
    assertEquals(parseGlobPath(w(src)), null, src);
  }
});

Deno.test("mayExpandToOption: 只有開頭即 glob 元字元者為 true", () => {
  for (const src of ["*.md", "?x", "[ab]x"]) assertEquals(mayExpandToOption(w(src)), true, src);
  for (const src of ["./*.md", "src/*.md", "a.md"]) assertEquals(mayExpandToOption(w(src)), false, src);
});

Deno.test("hasGlobstarSegment: 恰為 ** 的段才算", () => {
  assertEquals(hasGlobstarSegment(w("src/**/*.ts")), true);
  assertEquals(hasGlobstarSegment(w("/**/*.md")), true);
  assertEquals(hasGlobstarSegment(w("src/a**b/*.ts")), false);
  assertEquals(hasGlobstarSegment(w("*.md")), false);
});

Deno.test("isGlobAttachedValue: 只接受單段、無反斜線的黏寫 glob 值", () => {
  assertEquals(isGlobAttachedValue(w("--include=*.md"), "--include"), true);
  assertEquals(isGlobAttachedValue(w("--include=a.md"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--exclude=*.log"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=*/../../../**"), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=src/*.md"), "--include"), false);
  assertEquals(isGlobAttachedValue(w('--include="*.md"'), "--include"), false);
  assertEquals(isGlobAttachedValue(w("--include=\\*.md"), "--include"), false); // 含反斜線
});
