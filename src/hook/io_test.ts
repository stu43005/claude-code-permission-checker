import { assertEquals } from "@std/assert";
import { parseHookInput, renderDecision } from "./io.ts";

Deno.test("parseHookInput extracts fields", () => {
  const input = parseHookInput(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat a" }, cwd: "/proj" }),
  );
  assertEquals(input.tool_name, "Bash");
  assertEquals(input.tool_input?.command, "cat a");
  assertEquals(input.cwd, "/proj");
});

Deno.test("renderDecision builds the exact hook output JSON", () => {
  const json = renderDecision({ verdict: "allow", reason: "ok" });
  assertEquals(JSON.parse(json), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "ok",
    },
  });
});
