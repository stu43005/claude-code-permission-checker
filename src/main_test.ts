import { assertEquals } from "@std/assert";
import { homeDir, shellHomeDir } from "./main.ts";
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

Deno.test("e2e: settings allow + 寫入重導向 -> ask（中央前置不可升級）", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "npm test --x > /etc/passwd" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
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

Deno.test("shellHomeDir: 只接受絕對路徑的 HOME", () => {
  const of = (home: string | undefined) =>
    shellHomeDir({ get: (k: string) => (k === "HOME" ? home : undefined) });
  assertEquals(of("/home/u"), "/home/u");
  assertEquals(of(undefined), null);
  assertEquals(of(""), null);
  assertEquals(of("   "), null);
  assertEquals(of("../relative"), null);
  assertEquals(of("relative/home"), null);
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

/**
 * 父行程實際的 DENO_DIR（npm 模組快取根）。e2e 子行程以 clearEnv 啟動並覆寫 HOME 來測試
 * 家目錄路徑邏輯，但 Deno 的模組快取預設位於 HOME 之下；若不顯式帶入真實 DENO_DIR，子行程
 * 會去被覆寫的假 HOME 找 npm:unbash 快取而失敗（main.ts 無法啟動、stdout 為空）。DENO_DIR
 * 與 hook 的家目錄判定正交（hook 只讀 HOME/USERPROFILE），故帶入不影響測試語義。
 */
function realDenoDir(): string {
  const fromEnv = Deno.env.get("DENO_DIR");
  if (fromEnv) return fromEnv;
  const out = new Deno.Command("deno", {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return JSON.parse(new TextDecoder().decode(out.stdout)).denoDir as string;
}
const REAL_DENO_DIR = realDenoDir();

/** 以子行程執行 main.ts，可額外指定環境變數（如 HOME），並帶 --allow-sys=uid。 */
async function runHookWithEnv(
  payload: unknown,
  env: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-env", "--allow-read", "--allow-sys=uid", "src/main.ts"],
    clearEnv: true,
    // DENO_DIR 先給真實值，呼叫端 env 仍可覆寫（目前無呼叫端覆寫）。
    env: { DENO_DIR: REAL_DENO_DIR, ...env },
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

Deno.test("e2e: print-only chain -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: 'echo "結論是 X"' }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: sleep -> deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "sleep 5" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

Deno.test("e2e: real command + status echo -> not deny", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "make && echo DONE" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: heredoc body command substitution -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat <<EOF\n$(rm -rf x)\nEOF" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: input redirect external read -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "cat < /etc/passwd" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: tail -f -> ask", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "tail -f x" }, cwd: "/proj" },
    "/proj",
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: absolute allow + // in command -> allow (normalization wired)", async () => {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "/opt/tools//run.sh --x" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: approved real case - ~ allow + // command -> allow (HOME expands)", async () => {
  // ~ rule expands to the user home and folds // in the command's exec path
  const out = await runHookWithEnv(
    {
      tool_name: "Bash",
      tool_input: {
        command: "/Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh --spec docs/x --base abc",
      },
      cwd: SETTINGS_FIXTURE,
    },
    { CLAUDE_PROJECT_DIR: SETTINGS_FIXTURE, HOME: "/Users/stu43005" },
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});

Deno.test("e2e: approved real case but HOME unset -> ask (no ~ expansion)", async () => {
  const out = await runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: "/Users/stu43005/Sources/superpowers-codex//scripts/review-brainstorm.sh --spec docs/x --base abc",
      },
      cwd: SETTINGS_FIXTURE,
    },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

Deno.test("e2e: .. in command stays literal -> ask despite fold-equivalent allow", async () => {
  // fixture has Bash(/allowed/tool *); a .. command must NOT fold into it
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command: "/allowed/link/../tool x" }, cwd: SETTINGS_FIXTURE },
    SETTINGS_FIXTURE,
  );
  assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

/** 建臨時專案並寫 permissions.allow settings，回專案路徑。 */
async function projWithAllow(allow: string[]): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/.claude`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.claude/settings.json`, JSON.stringify({ permissions: { allow } }));
  return dir;
}

Deno.test("e2e: 閘②/③ 命中不可升級（settings 有 Bash(node *)/Bash(echo *)）", async () => {
  const proj = await projWithAllow(["Bash(node *)", "Bash(python *)", "Bash(echo *)", "Bash(cat *)"]);
  try {
    for (const command of [
      `node -e 'console.log("fake")'`,                                  // inline A
      `node <<'EOF'\nconsole.log("f")\nEOF`,                            // heredoc-stdin B
      `cat > ${proj}/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${proj}/x.mjs`, // write-exec C(a)
      `cat > ${proj}/q.txt <<'EOF'\ndead\nEOF\ncat ${proj}/q.txt`,      // cat-readback C(b)
      `echo 'console.log(1)' | node`,                                   // pipe D
      "echo a; echo b",                                                 // shell
      "f(){ :; }; echo done",                                           // 函式
      "alias grep=x; grep foo",                                        // alias
    ]) {
      const out = await runHook({ tool_name: "Bash", tool_input: { command }, cwd: proj }, proj);
      assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", command);
    }
    // 對照：真實運算 + Bash(node *) → allow（可升級）
    const ok = await runHook(
      { tool_name: "Bash", tool_input: { command: `node -e 'JSON.stringify(x)'` }, cwd: proj }, proj);
    assertEquals(JSON.parse(ok).hookSpecificOutput.permissionDecision, "allow");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test("e2e: 跨呼叫 migration 邊界", async () => {
  const bare = await Deno.makeTempDir();
  const withAllow = await projWithAllow(["Bash(node *)"]);
  try {
    // 呼叫1：寫檔（無 allow）→ ask
    const c1 = await runHook(
      { tool_name: "Bash", tool_input: { command: `cat > ${bare}/x.mjs <<'EOF'\nconsole.log("f")\nEOF` }, cwd: bare }, bare);
    assertEquals(JSON.parse(c1).hookSpecificOutput.permissionDecision, "ask");
    // 呼叫2：執行（無 allow）→ ask
    const c2 = await runHook(
      { tool_name: "Bash", tool_input: { command: `node ${bare}/x.mjs` }, cwd: bare }, bare);
    assertEquals(JSON.parse(c2).hookSpecificOutput.permissionDecision, "ask");
    // 呼叫2 + Bash(node *) → allow（使用者自負）
    const c3 = await runHook(
      { tool_name: "Bash", tool_input: { command: `node ${withAllow}/x.mjs` }, cwd: withAllow }, withAllow);
    assertEquals(JSON.parse(c3).hookSpecificOutput.permissionDecision, "allow");
    // 對照：同一 payload 單一呼叫 + Bash(node *) → 仍 deny
    const c4 = await runHook(
      { tool_name: "Bash", tool_input: { command: `cat > ${withAllow}/y.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${withAllow}/y.mjs` }, cwd: withAllow }, withAllow);
    assertEquals(JSON.parse(c4).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(withAllow, { recursive: true });
  }
});

Deno.test("e2e: pre-execution 無副作用（write-exec + cat-readback，內容/mtime 不變）", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const [file, command] of [
      [`${dir}/x.mjs`, `cat > ${dir}/x.mjs <<'EOF'\nconsole.log("f")\nEOF\nnode ${dir}/x.mjs`],
      [`${dir}/q.txt`, `cat > ${dir}/q.txt <<'EOF'\ndead\nEOF\ncat ${dir}/q.txt`],
    ] as const) {
      await Deno.writeTextFile(file, "ORIGINAL");
      const before = (await Deno.stat(file)).mtime?.getTime();
      const out = await runHook({ tool_name: "Bash", tool_input: { command }, cwd: dir }, dir);
      assertEquals(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", command);
      assertEquals(await Deno.readTextFile(file), "ORIGINAL", command);      // 內容不變
      assertEquals((await Deno.stat(file)).mtime?.getTime(), before, command); // mtime 不變
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** 由指令字串組出 hook payload，並取出決策。 */
async function decisionOf(command: string, projectDir: string): Promise<string> {
  const out = await runHook(
    { tool_name: "Bash", tool_input: { command }, cwd: projectDir },
    projectDir,
  );
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

Deno.test("e2e: 本次的真實指令改為自動放行", async () => {
  const proj = await projWithAllow([]);
  try {
    await Deno.writeTextFile(`${proj}/deno.json`, "{}");
    // 觸發本次設計的四條真實指令（第一條是完整的原始 pipeline）
    assertEquals(
      await decisionOf(
        `gh api repos/o/r/contents/README.md --template='{{.content}}' | base64 -d 2>&1 | grep -A 20 "x" | head -40`,
        proj,
      ),
      "allow",
    );
    assertEquals(await decisionOf("test -f deno.json && cat deno.json | head -100", proj), "allow");
    assertEquals(
      await decisionOf(
        "npm view markdown-it version && npm view marked version",
        proj,
      ),
      "allow",
    );
    assertEquals(await decisionOf("base64 -w 0 deno.json", proj), "allow");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test("e2e: 動態 cd 目標不再繞過 cwd 檢查", async () => {
  const proj = await projWithAllow([]);
  try {
    assertEquals(await decisionOf('cd "$(uname -a)" && git log --oneline -3', proj), "ask");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

Deno.test({
  ignore: Deno.build.os !== "windows",
  name: "e2e: cygpath 推導 cwd 後，相對路徑讀取被正確判定（本次主要需求）",
  async fn() {
    const proj = await projWithAllow([]);
    try {
      await Deno.writeTextFile(`${proj}/deno.json`, "{}");
      // 專案內：推導出的 cwd 在範圍內 → 相對路徑可解析 → allow
      assertEquals(await decisionOf(`cd "$(cygpath -u '${proj}')" && cat deno.json`, proj), "allow");
      // 專案外：推導出的 cwd 落在範圍外 → 中央前置規則一 → ask
      assertEquals(await decisionOf(`cd "$(cygpath -u 'C:/Windows')" && cat deno.json`, proj), "ask");
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  },
});

Deno.test("e2e: 磁碟相對的 cd 目標不得造出假的專案內 cwd", async () => {
  const proj = await projWithAllow([]);
  try {
    assertEquals(await decisionOf("cd C:Windows && cat win.ini", proj), "ask");
    assertEquals(await decisionOf(`cd "$(echo C:Windows)" && cat win.ini`, proj), "ask");
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

/** 帶環境變數跑 hook 並取出決策。 */
async function decisionWithEnv(
  command: string,
  proj: string,
  env: Record<string, string>,
): Promise<string> {
  const out = await runHookWithEnv(
    { tool_name: "Bash", tool_input: { command }, cwd: proj },
    { CLAUDE_PROJECT_DIR: proj, ...env },
  );
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

Deno.test("e2e: 未加引號的 ~ 展開為 HOME，落在專案外 → ask", async () => {
  const proj = await projWithAllow([]);
  try {
    const env = { HOME: "/bash-home", USERPROFILE: "/bash-home" };
    for (
      const cmd of [
        "cat ~/secret",
        "cat ~/.ssh/id_rsa",
        "grep x ~/secret",
        "head -5 ~/secret",
        "test -f ~/secret",
        "base64 ~/secret",
        "cat ~user/secret",
        "cat ~+/secret",
        "cat ~-/secret",
      ]
    ) {
      assertEquals(await decisionWithEnv(cmd, proj, env), "ask", cmd);
    }
    // 引號形態指向 <proj>/~/secret，仍在專案內 → allow
    assertEquals(await decisionWithEnv('cat "~/secret"', proj, env), "allow");
    // HOME 未設定 → 不可解析 → ask
    assertEquals(
      await decisionWithEnv("cat ~/x", proj, { USERPROFILE: "/settings-home" }),
      "ask",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

// 正面案例跨平台成立：兩個 home 相同時，settings 的 ~ 與指令的 ~ 指向同一處
Deno.test("e2e: Read(~/cache/**) 授權後，指令的 ~ 展開命中該範圍 → allow", async () => {
  const proj = await projWithAllow(["Read(~/cache/**)"]);
  try {
    assertEquals(
      await decisionWithEnv("cat ~/cache/x", proj, {
        HOME: "/same-home",
        USERPROFILE: "/same-home",
      }),
      "allow",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
  }
});

// 兩個 home 分歧只在 Windows 成立：resolveHome 在該平台優先 USERPROFILE，
// 其他平台兩者都用 HOME，分歧無從產生。
Deno.test({
  ignore: Deno.build.os !== "windows",
  name: "e2e: HOME 與 USERPROFILE 分歧時，settings 的 ~ 走 USERPROFILE、指令的 ~ 走 HOME",
  async fn() {
    const proj = await projWithAllow(["Read(~/cache/**)"]);
    const env = { HOME: "/bash-home", USERPROFILE: "/settings-home" };
    try {
      // 授權的是 USERPROFILE/cache，實際讀的是 HOME/cache → 不一致 → ask
      assertEquals(await decisionWithEnv("cat ~/cache/x", proj, env), "ask");
      // 同一環境下，該規則**仍然**授權 USERPROFILE 底下的位置——證明它被正確解析、
      // 而不是被丟棄或解析到別處（沒有這條，上面的 ask 也可能來自「規則根本沒生效」）
      assertEquals(await decisionWithEnv("cat /settings-home/cache/x", proj, env), "allow");
      // 而 HOME 底下的同名位置未被授權
      assertEquals(await decisionWithEnv("cat /bash-home/cache/x", proj, env), "ask");
    } finally {
      await Deno.remove(proj, { recursive: true });
    }
  },
});
