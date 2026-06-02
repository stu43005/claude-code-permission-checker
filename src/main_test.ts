import { assertEquals } from "@std/assert";

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
