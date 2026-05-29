import { assertEquals } from "@std/assert";
import { parse } from "../deps.ts";
import type { Command } from "../deps.ts";
import { hasWriteRedirect } from "./redirect.ts";

function redirectsOf(src: string) {
  return (parse(src).commands[0].command as Command).redirects;
}

Deno.test("plain > to a file is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("echo hi > out.txt")), true);
});

Deno.test(">> append is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("echo hi >> out.txt")), true);
});

Deno.test("&>> append-both is a write redirect", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd &>> out.log")), true);
});

Deno.test("redirect to /dev/null is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("grep x f 2>/dev/null")), false);
});

Deno.test("> /dev/null is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd >/dev/null")), false);
});

Deno.test("windows NUL (case-insensitive) is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd > NUL")), false);
});

Deno.test("pure fd-dup 2>&1 is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd 2>&1")), false);
});

Deno.test(">&filename is a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("ls >&out.txt")), true);
});

Deno.test(">&fd-number is not a write (dup)", () => {
  assertEquals(hasWriteRedirect(redirectsOf("ls >&2")), false);
});

Deno.test("input redirect < is not a write", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd < in.txt")), false);
});

Deno.test("dynamic write target still asks", () => {
  assertEquals(hasWriteRedirect(redirectsOf("cmd > $OUT")), true);
});
