import { assertEquals } from "@std/assert";
import { combine } from "./combine.ts";

Deno.test("all allow -> allow with neutral reason", () => {
  const d = combine([{ kind: "allow" }, { kind: "allow" }]);
  assertEquals(d.verdict, "allow");
  assertEquals(d.reason, "全部指令均通過（唯讀放行或命中 permissions.allow）");
});

Deno.test("any ask -> ask with first ask reason", () => {
  const d = combine([{ kind: "allow" }, { kind: "ask", reason: "因為 X" }, { kind: "ask", reason: "因為 Y" }]);
  assertEquals(d.verdict, "ask");
  assertEquals(d.reason, "因為 X");
});

Deno.test("empty -> allow (no-op)", () => {
  assertEquals(combine([]).verdict, "allow");
});
