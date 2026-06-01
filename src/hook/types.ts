import type { Verdict } from "../types.ts";

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
  session_id?: string;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: Verdict;
    permissionDecisionReason: string;
  };
}
