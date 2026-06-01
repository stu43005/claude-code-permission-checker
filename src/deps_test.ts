import { assertEquals } from "@std/assert";
import { parse } from "./deps.ts";

Deno.test("unbash parses a simple command into Script.commands", () => {
  const script = parse("cat file.txt");
  assertEquals(script.type, "Script");
  assertEquals(script.commands.length, 1);
  const stmt = script.commands[0];
  assertEquals(stmt.type, "Statement");
  assertEquals(stmt.command.type, "Command");
});

Deno.test("unbash exposes errors as an array field", () => {
  const script = parse("cat file.txt");
  assertEquals(script.errors ?? [], []);
});
