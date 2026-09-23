/**
 * 可重複執行的 operational verification harness：建置 `dist/permission-checker.exe`
 * 後，對照下方 `CASES` 表逐一餵 hook JSON 給編譯後的 binary（不是 `deno run src/main.ts`），
 * 斷言真實決策與 exit code。取代手刻的 echo-pipe 迴圈，讓下一個人（或下一次改動）可以
 * 直接重跑同一份驗證，而不必重新手動組指令。
 *
 * 用法：
 *   deno run --allow-run --allow-read --allow-write --allow-env scripts/verify-hook-binary.ts
 *
 * 新增案例：在下方 `CASES` 陣列多加一個 `{ description, command, expected }` 即可，
 * 不需要改動其餘邏輯。`command` 是函式而非字串，因為部分案例（如 cygpath 推導 cwd）
 * 需要參照本次執行動態建立的暫存專案路徑；不需要它的案例可以忽略參數直接回傳字面字串。
 *
 * 環境隔離：`clearEnv: true` 並顯式指定 `CLAUDE_PROJECT_DIR`/`CLAUDE_CONFIG_DIR` 指向
 * 暫存目錄（後者為空、無 settings.json），確保使用者自己的 `permissions.allow` 不會把
 * 某個 rule-level ask 升級成 allow、掩蓋掉真正的 regression；`HOME`/`USERPROFILE` 也顯式
 * 指定為暫存目錄，避免沿用真實家目錄。
 *
 * 只在 Windows 執行：部分案例是 cygpath-specific（本工具的 MSYS/cygpath 相關規則只在
 * Windows 上有意義），在其他平台上直接印訊息並正常結束（exit 0），不拋例外。
 */

interface Case {
  description: string;
  /** proj：本次執行建立的暫存專案根目錄（已正規化為正斜線）。不需要它的案例可忽略參數。 */
  command: (proj: string) => string;
  expected: "allow" | "ask" | "deny";
}

const CASES: Case[] = [
  // ---- 期望 allow ----
  {
    description: "npm view 兩次（唯讀 registry 查詢）",
    command: () => "npm view markdown-it version && npm view marked version",
    expected: "allow",
  },
  {
    description: "test -f && cat | head（單元檔案測試 + 唯讀讀取）",
    command: () => "test -f deno.json && cat deno.json | head -20",
    expected: "allow",
  },
  {
    description: "base64 -w 0（純字串轉換，無寫檔旗標）",
    command: () => "base64 -w 0 deno.json",
    expected: "allow",
  },
  {
    description: "cygpath -u（形態 A 純字串轉換，不對操作元做範圍檢查）",
    command: () => "cygpath -u /d/claude-code-permission-checker",
    expected: "allow",
  },
  {
    description: "cd \"$(cygpath -u <專案根>)\" && cat deno.json（推導出的 cwd 落在專案內）",
    command: (proj) => `cd "$(cygpath -u '${proj}')" && cat deno.json`,
    expected: "allow",
  },

  // ---- 期望 ask（安全方向） ----
  {
    description: "cat ~/.ssh/id_rsa（未加引號 tilde 展開後落在專案外）",
    command: () => "cat ~/.ssh/id_rsa",
    expected: "ask",
  },
  {
    description: "npm view /etc（操作元不是 registry package spec）",
    command: () => "npm view /etc",
    expected: "ask",
  },
  {
    description: "npm ls（子指令未列入唯讀 allowlist，會印出父層專案內容）",
    command: () => "npm ls",
    expected: "ask",
  },
  {
    description: "cygpath -d /etc/passwd（形態 B 查詢檔案系統，路徑超出範圍）",
    command: () => "cygpath -d /etc/passwd",
    expected: "ask",
  },
  {
    description: "test -f /etc/passwd（路徑超出專案範圍）",
    command: () => "test -f /etc/passwd",
    expected: "ask",
  },
  {
    description: "cd -P /c/Windows && cat win.ini（cd 帶選項形態，cwd 無法靜態確定）",
    command: () => "cd -P /c/Windows && cat win.ini",
    expected: "ask",
  },
];

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

async function buildBinary(repoRoot: string): Promise<void> {
  console.log("building dist/permission-checker.exe via `deno task build`...");
  const result = await new Deno.Command("deno", {
    args: ["task", "build"],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error("`deno task build` failed");
  }
}

async function runBinary(
  exePath: string,
  payload: unknown,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  const cmd = new Deno.Command(exePath, {
    clearEnv: true,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout, code } = await child.output();
  return { stdout: new TextDecoder().decode(stdout).trim(), code };
}

async function main(): Promise<void> {
  if (Deno.build.os !== "windows") {
    console.log(
      "[verify-hook-binary] skipped: several cases are cygpath/MSYS-specific and only make " +
        "sense on Windows. Nothing to verify on this platform.",
    );
    return;
  }

  const repoRoot = toForwardSlash(Deno.cwd());
  await buildBinary(repoRoot);
  const exePath = `${repoRoot}/dist/permission-checker.exe`;

  const root = await Deno.makeTempDir({ prefix: "verify-hook-binary-" });
  try {
    const proj = toForwardSlash(`${root}/project`);
    const config = toForwardSlash(`${root}/config`);
    const home = toForwardSlash(`${root}/home`);
    await Deno.mkdir(proj, { recursive: true });
    await Deno.mkdir(config, { recursive: true }); // 刻意留空：無 settings.json → 無 permissions.allow
    await Deno.writeTextFile(`${proj}/deno.json`, "{}");

    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
      USERPROFILE: home,
    };

    let failures = 0;
    for (const c of CASES) {
      const command = c.command(proj);
      const payload = { tool_name: "Bash", tool_input: { command }, cwd: proj };
      const { stdout, code } = await runBinary(exePath, payload, env);

      let decision = "<parse error>";
      let reason = "";
      try {
        const parsed = JSON.parse(stdout);
        decision = parsed?.hookSpecificOutput?.permissionDecision ?? "<missing decision>";
        reason = parsed?.hookSpecificOutput?.permissionDecisionReason ?? "";
      } catch {
        // decision 維持 "<parse error>"，下面印出原始 stdout 供除錯
      }

      const ok = decision === c.expected && code === 0;
      if (!ok) failures++;

      console.log(`[${ok ? "PASS" : "FAIL"}] ${c.description}`);
      console.log(`  command : ${command}`);
      console.log(`  expected: ${c.expected}  actual: ${decision}  exit: ${code}`);
      if (reason) console.log(`  reason  : ${reason}`);
      if (!ok && decision === "<parse error>") console.log(`  raw stdout: ${stdout}`);
      if (code !== 0) console.log(`  !!! 違反不變量：hook 必須永遠 exit 0`);
    }

    console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
    if (failures > 0) {
      console.error(`${failures} case(s) failed`);
      Deno.exit(1);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

await main();
