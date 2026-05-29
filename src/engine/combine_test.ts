import { assertEquals } from "@std/assert";
import { combine } from "./combine.ts";

Deno.test("all allow -> allow", () => {
  assertEquals(combine([{ kind: "allow" }, { kind: "allow" }]).verdict, "allow");
});

Deno.test("any ask -> ask with first ask reason", () => {
  const d = combine([{ kind: "allow" }, { kind: "ask", reason: "因為 X" }, { kind: "ask", reason: "因為 Y" }]);
  assertEquals(d.verdict, "ask");
  assertEquals(d.reason, "因為 X");
});

Deno.test("empty -> allow (no-op)", () => {
  assertEquals(combine([]).verdict, "allow");
});
