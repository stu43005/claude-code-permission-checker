import { assertEquals, assertStringIncludes } from "@std/assert";
import { deny, nameRedefinitionDenyReason, pollingDenyReason, printDisguiseDenyReason, recursiveRootDenyReason } from "./types.ts";

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

Deno.test("pollingDenyReason 含 sleep 替代指引", () => {
  const r = pollingDenyReason();
  assertStringIncludes(r, "已禁止");
  assertStringIncludes(r, "ScheduleWakeup");
  assertStringIncludes(r, "task-notification");
});

Deno.test("printDisguiseDenyReason 依 kind 客製、含替代", () => {
  assertStringIncludes(printDisguiseDenyReason("interp-inline"), "已禁止");
  assertStringIncludes(printDisguiseDenyReason("cat-readback"), "cat 讀回");
  assertStringIncludes(printDisguiseDenyReason("write-exec"), "已禁止");
});
Deno.test("nameRedefinitionDenyReason 含禁止 + 替代", () => {
  assertStringIncludes(nameRedefinitionDenyReason("function"), "shell 函式");
  assertStringIncludes(nameRedefinitionDenyReason("alias"), "alias");
});
