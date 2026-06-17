import { parseHookInput, readStdin, renderDecision } from "./hook/io.ts";
import { resolveProjectRoot } from "./project.ts";
import type { EnvReader } from "./project.ts";
import { evaluate } from "./engine/evaluate.ts";
import { normalizeAbsolute } from "./engine/scope.ts";
import { loadPermissionRules, resolveHome } from "./permissions/settings.ts";
import type { CwdState, Decision } from "./types.ts";
import { resolveClaudeConfigDir, sessionTrustedReadRoots } from "./claude_dir.ts";
import { tmpdir } from "node:os";

/** 家目錄絕對路徑（平台感知，重用 settings 的 resolveHome）；未設定回 null。 */
export function homeDir(env: EnvReader): string | null {
  const h = resolveHome(env);
  return h === null ? null : normalizeAbsolute(h);
}

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
    const rules = loadPermissionRules(Deno.env, root);
    const home = homeDir(Deno.env);
    let claudeConfigDir: string | null = null;
    try {
      claudeConfigDir = resolveClaudeConfigDir(Deno.env, home);
    } catch {
      claudeConfigDir = null; // env 權限/平台失敗 → 無 trusted 根（fail-safe）
    }
    let uid: number | null = null;
    try {
      uid = Deno.uid();
    } catch {
      uid = null; // 權限（--allow-sys=uid）/平台不支援 → null（fail-safe）
    }
    let osTmpBase: string | null = null;
    try {
      const explicit = Deno.env.get("CLAUDE_CODE_TMPDIR"); // 對齊 Claude MI()：CLAUDE_CODE_TMPDIR 優先
      osTmpBase = explicit && explicit.trim() !== "" ? explicit : tmpdir();
    } catch {
      osTmpBase = null;
    }
    const trusted = sessionTrustedReadRoots(
      input.transcript_path,
      input.session_id,
      claudeConfigDir,
      Deno.build.os,
      uid,
      osTmpBase,
    );
    decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);
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
