import { assertEquals, assertStringIncludes } from "@std/assert";
import { deny, functionShadowReason, pollingDenyReason, printOnlyDenyReason, recursiveRootDenyReason } from "./types.ts";

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

Deno.test("printOnlyDenyReason 含禁止字樣 + 替代建議", () => {
  const r = printOnlyDenyReason();
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "回覆");
});

Deno.test("pollingDenyReason 含 sleep 替代指引", () => {
  const r = pollingDenyReason();
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "ScheduleWakeup");
  assertStringIncludes(r, "task-notification");
});

Deno.test("functionShadowReason 含需確認 + 替代", () => {
  const r = functionShadowReason();
  assertStringIncludes(r, "需確認");
  assertStringIncludes(r, "函式");
});
