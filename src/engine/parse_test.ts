import { assertEquals } from "@std/assert";
import { parseCommand } from "./parse.ts";

Deno.test("valid command: no errors", () => {
  const r = parseCommand("cat file.txt");
  assertEquals(r.errors.length, 0);
  assertEquals(r.script.commands.length, 1);
});

Deno.test("errors are always an array (never undefined)", () => {
  const r = parseCommand("");
  assertEquals(Array.isArray(r.errors), true);
});
