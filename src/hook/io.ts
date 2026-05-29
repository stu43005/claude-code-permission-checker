import type { Decision } from "../types.ts";
import type { HookInput, HookOutput } from "./types.ts";

/** 讀取 stdin 全部內容為字串。 */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

export function parseHookInput(raw: string): HookInput {
  return JSON.parse(raw) as HookInput;
}

/** 產出嚴格符合 hook 契約的 decision JSON。 */
export function renderDecision(decision: Decision): string {
  const out: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.verdict,
      permissionDecisionReason: decision.reason,
    },
  };
  return JSON.stringify(out);
}
