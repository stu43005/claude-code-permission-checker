import { assertEquals } from "@std/assert";
import { homeDir } from "./main.ts";
import { normalizeAbsolute } from "./engine/scope.ts";

/** 以子行程執行 main.ts，餵入 hook JSON，回傳 stdout。 */
async function runHook(payload: unknown, projectDir: string): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "src/main.ts"],
    clearEnv: true,
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout } = await child.output();
  return new TextDecoder().decode(stdout).trim();
}

Deno.test("e2e: read-only in-project -> allow", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat src/a.ts" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: write -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "rm -rf x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: non-Bash tool -> no output", async () => {
  const out = await runHook(
    { tool_name: "Read", tool_input: {}, cwd: "/proj" },
    "/proj",
  );
  assertEquals(out, "");
});

Deno.test("e2e: malformed stdin -> ask, never crash", async () => {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "src/main.ts"],
    clearEnv: true,
    env: { CLAUDE_PROJECT_DIR: "/proj" },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not json"));
  await writer.close();
  const { stdout, code } = await child.output();
  const out = new TextDecoder().decode(stdout).trim();
  assertEquals(code, 0);
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

const SETTINGS_FIXTURE = `${Deno.cwd()}/src/testdata/proj-with-settings`;

Deno.test("e2e: command matching settings allow -> allow (upgrade)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm test --silent" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: command not in settings allow -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm run build" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("homeDir: 讀 HOME 並正規化（去結尾斜線）", () => {
  assertEquals(homeDir({ get: (k: string) => (k === "HOME" ? "/home/me/" : undefined) }), "/home/me");
});

Deno.test("homeDir: HOME 未設時退回 USERPROFILE", () => {
  assertEquals(
    homeDir({ get: (k: string) => (k === "USERPROFILE" ? "/c/Users/me" : undefined) }),
    normalizeAbsolute("/c/Users/me"),
  );
});

Deno.test("homeDir: 皆未設 -> null", () => {
  assertEquals(homeDir({ get: () => undefined }), null);
});

Deno.test("e2e: recursive root scan -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find / -type d -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: lone $HOME recursive scan -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find $HOME -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: subdir of home -> not deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "find ~/.claude -name x" }, cwd: "/proj" },
    "/proj",
  );
  const decision = JSON.parse(out).hookSpecificOutput.permissionDecision;
  assertEquals(decision !== "deny", true);
});

Deno.test("e2e: compound allow + recursive-root -> deny (最弱環節)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat README.md && find / -name x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

/** 以子行程執行 main.ts，可額外指定環境變數（如 HOME），並帶 --allow-sys=uid。 */
async function runHookWithEnv(
  payload: unknown,
  env: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "--allow-sys=uid", "src/main.ts"],
    clearEnv: true,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(payload)));
  await writer.close();
  const { stdout } = await child.output();
  return new TextDecoder().decode(stdout).trim();
}

const E2E_HOME = "/tmp/cc-pc-e2e-home";
const E2E_PROJ = "/tmp/cc-pc-e2e-home/Sources/proj";
const E2E_E = "-tmp-cc-pc-e2e-home-Sources-proj";
const E2E_SID = "115826ef-e830-461f-8101-edac56694d2b";
const E2E_TRANSCRIPT = `${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}.jsonl`;

function e2ePayload(command: string, extra: Record<string, unknown> = {}) {
  return {
    tool_name: "Bash",
    tool_input: { command },
    cwd: E2E_PROJ,
    session_id: E2E_SID,
    transcript_path: E2E_TRANSCRIPT,
    ...extra,
  };
}

Deno.test("e2e: 讀當前 session 的 ~/.claude tool-results -> allow", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: 不帶 transcript_path -> ask", async () => {
  const out = await runHookWithEnv(
    { tool_name: "Bash", tool_input: { command: `cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt` }, cwd: E2E_PROJ, session_id: E2E_SID },
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: transcript basename 與 session_id 不符 -> ask", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt`, {
      transcript_path: `${E2E_HOME}/.claude/projects/${E2E_E}/deadbeef.jsonl`,
    }),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: transcript_path 在 ~/.claude/projects 外 -> ask", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.ssh/${E2E_SID}/secret`, {
      transcript_path: `${E2E_HOME}/.ssh/${E2E_SID}.jsonl`,
    }),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: 同專案 memory -> ask（不自動放行）", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/memory/note.md`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: 他 session 子目錄 -> ask", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_HOME}/.claude/projects/${E2E_E}/deadsess/tool-results/x.txt`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test({
  name: "e2e: 讀當前 session 的 /tmp 任務輸出 -> allow（macOS）",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const uid = Deno.uid();
    const out = await runHookWithEnv(
      e2ePayload(`cat /private/tmp/claude-${uid}/${E2E_E}/${E2E_SID}/tasks/x.output`),
      { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
    );
    assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
  },
});

Deno.test("e2e: CLAUDE_CODE_TMPDIR 任務輸出 -> allow（跨平台）", async () => {
  const tmpBase = `${E2E_HOME}/tmp-override`; // 顯式覆寫（正斜線、跨平台安全）→ 子行程 osTmpBase 確定
  const claudeDir = Deno.build.os === "windows" ? "claude" : `claude-${Deno.uid()}`;
  const out = await runHookWithEnv(
    e2ePayload(`cat ${tmpBase}/${claudeDir}/${E2E_E}/${E2E_SID}/tasks/x.output`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME, CLAUDE_CODE_TMPDIR: tmpBase },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test({
  name: "e2e: Windows 預設 os.tmpdir() 背景輸出 -> allow（不帶 CLAUDE_CODE_TMPDIR）",
  ignore: Deno.build.os !== "windows",
  async fn() {
    const tempDir = "C:/Users/Public/cc-pc-e2e-temp"; // 作為 TEMP 傳入；子行程 os.tmpdir() 取此值
    const base = normalizeAbsolute(tempDir); // 轉正斜線，避免 Bash 反斜線跳脫
    const out = await runHookWithEnv(
      e2ePayload(`cat ${base}/claude/${E2E_E}/${E2E_SID}/tasks/x.output`),
      { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME, TEMP: tempDir },
    );
    assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
  },
});

Deno.test("e2e: CLAUDE_CONFIG_DIR 下 tool-results -> allow（跨平台）", async () => {
  const cfg = "/tmp/cc-pc-e2e-cfg";
  const transcript = `${cfg}/projects/${E2E_E}/${E2E_SID}.jsonl`;
  const out = await runHookWithEnv(
    {
      tool_name: "Bash",
      tool_input: { command: `cat ${cfg}/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt` },
      cwd: E2E_PROJ,
      session_id: E2E_SID,
      transcript_path: transcript,
    },
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME, CLAUDE_CONFIG_DIR: cfg },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: 不帶 CLAUDE_CONFIG_DIR 時，自訂 configDir 路徑 -> ask（相容性回歸）", async () => {
  const cfg = "/tmp/cc-pc-e2e-cfg";
  const out = await runHookWithEnv(
    e2ePayload(`cat ${cfg}/projects/${E2E_E}/${E2E_SID}/tool-results/x.txt`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: 讀 transcript .jsonl 本身 -> ask（不自動放行）", async () => {
  const out = await runHookWithEnv(
    e2ePayload(`cat ${E2E_TRANSCRIPT}`),
    { CLAUDE_PROJECT_DIR: E2E_PROJ, HOME: E2E_HOME },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
