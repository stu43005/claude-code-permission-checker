import { parseHookInput, readStdin, renderDecision } from "./hook/io.ts";
import { resolveProjectRoot } from "./project.ts";
import { evaluate } from "./engine/evaluate.ts";
import { normalizeAbsolute } from "./engine/scope.ts";
import type { CwdState, Decision } from "./types.ts";

function initialCwd(cwd: string | undefined, root: string): CwdState {
  if (cwd && cwd.trim() !== "") return { kind: "known", path: normalizeAbsolute(cwd.trim()) };
  return { kind: "known", path: root };
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "無法讀取 hook 輸入" }));
    return;
  }

  let input;
  try {
    input = parseHookInput(raw);
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "hook 輸入非合法 JSON" }));
    return;
  }

  // 非 Bash：不輸出任何 decision，交回 Claude Code 預設流程。
  if (input.tool_name !== "Bash") return;

  const root = resolveProjectRoot(Deno.env);
  let decision: Decision;
  if (root === null) {
    decision = {
      verdict: "ask",
      reason: "無法確定專案根目錄（CLAUDE_PROJECT_DIR 未設定）",
    };
  } else {
    const command = input.tool_input?.command ?? "";
    decision = evaluate(command, root, initialCwd(input.cwd, root));
  }
  console.log(renderDecision(decision));
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.log(renderDecision({ verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" }));
  }
  Deno.exit(0);
}
