import { assertEquals, assertStringIncludes } from "@std/assert";
import { deny, recursiveRootDenyReason } from "./types.ts";

Deno.test("deny() 建構 deny verdict", () => {
  assertEquals(deny("理由X"), { kind: "deny", reason: "理由X" });
});

Deno.test("recursiveRootDenyReason 含指令名/目標/禁止字樣/替代建議", () => {
  const r = recursiveRootDenyReason("find", "/");
  assertStringIncludes(r, "find");
  assertStringIncludes(r, "/");
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "請改為");
});
