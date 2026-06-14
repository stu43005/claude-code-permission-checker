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

Deno.test("combine: 任一 deny -> deny，取首個 deny 理由", () => {
  assertEquals(
    combine([
      { kind: "allow" },
      { kind: "deny", reason: "d1" },
      { kind: "ask", reason: "a1" },
      { kind: "deny", reason: "d2" },
    ]),
    { verdict: "deny", reason: "d1" },
  );
});

Deno.test("combine: 無 deny 時 ask 蓋過 allow", () => {
  assertEquals(
    combine([{ kind: "allow" }, { kind: "ask", reason: "a1" }]).verdict,
    "ask",
  );
});
