import { assertEquals } from "@std/assert";
import { resolveClaudeConfigDir, sessionTrustedReadRoots } from "./claude_dir.ts";
import type { EnvReader } from "./project.ts";

const HOME = "/home/me";
const CONFIG = `${HOME}/.claude`; // CLAUDE_CONFIG_DIR ?? <home>/.claude
const SID = "115826ef-e830-461f-8101-edac56694d2b";
const E = "-home-me-Sources-proj";
const TRANSCRIPT = `${CONFIG}/projects/${E}/${SID}.jsonl`;
const PROJ_ROOT = `${CONFIG}/projects/${E}/${SID}`; // tool-results 等所在的 session 根

function env(map: Record<string, string>): EnvReader {
  return { get: (k) => map[k] };
}

// —— sessionTrustedReadRoots —— //

Deno.test("macOS 聯集：os.tmpdir + /tmp + /private/tmp（皆 claude-<uid>）+ session 根", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "darwin", 501, "/var/folders/x/T");
  assertEquals(roots, [
    PROJ_ROOT,
    `/var/folders/x/T/claude-501/${E}/${SID}`,
    `/tmp/claude-501/${E}/${SID}`,
    `/private/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("Linux 去重：osTmpBase==/tmp → tmp 根僅一個", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "linux", 501, "/tmp");
  assertEquals(roots, [PROJ_ROOT, `/tmp/claude-501/${E}/${SID}`]);
});

Deno.test("Linux 相異 base：osTmpBase=/scratch → 兩個 tmp 根", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "linux", 501, "/scratch");
  assertEquals(roots, [
    PROJ_ROOT,
    `/scratch/claude-501/${E}/${SID}`,
    `/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("Windows：claude（無 uid），uid 不影響", () => {
  const wHome = "C:/Users/u";
  const wConfig = `${wHome}/.claude`;
  const wE = "-c-Users-u-proj";
  const wTranscript = `${wConfig}/projects/${wE}/${SID}.jsonl`;
  const roots = sessionTrustedReadRoots(wTranscript, SID, wConfig, "windows", null, "C:/Users/u/AppData/Local/Temp");
  assertEquals(roots, [
    `${wConfig}/projects/${wE}/${SID}`,
    `C:/Users/u/AppData/Local/Temp/claude/${wE}/${SID}`,
  ]);
});

Deno.test("CLAUDE_CODE_TMPDIR 對齊（Windows 重導向 D:/scratch，刻意行為）", () => {
  const wConfig = "C:/Users/u/.claude";
  const wE = "-c-Users-u-proj";
  const wTranscript = `${wConfig}/projects/${wE}/${SID}.jsonl`;
  const roots = sessionTrustedReadRoots(wTranscript, SID, wConfig, "windows", null, "D:/scratch");
  assertEquals(roots, [
    `${wConfig}/projects/${wE}/${SID}`,
    `D:/scratch/claude/${wE}/${SID}`,
  ]);
});

Deno.test("CLAUDE_CONFIG_DIR 對齊：自訂 configDir 下 transcript → 通過、session 根在其下", () => {
  const cfg = "/opt/cc";
  const t = `${cfg}/projects/${E}/${SID}.jsonl`;
  const roots = sessionTrustedReadRoots(t, SID, cfg, "linux", 501, "/tmp");
  assertEquals(roots, [`${cfg}/projects/${E}/${SID}`, `/tmp/claude-501/${E}/${SID}`]);
});

Deno.test("CLAUDE_CONFIG_DIR 不符：transcript 在 home/.claude 但 configDir=/opt/cc → []（fail-closed）", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, "/opt/cc", "linux", 501, "/tmp"), []);
});

Deno.test("跨來源 provenance（刻意接受）：config 與 tmp 來源不一致仍各自產出", () => {
  const cfg = "/opt/cc";
  const t = `${cfg}/projects/${E}/${SID}.jsonl`;
  const roots = sessionTrustedReadRoots(t, SID, cfg, "linux", 501, "/unrelated/tmp");
  assertEquals(roots, [
    `${cfg}/projects/${E}/${SID}`,
    `/unrelated/tmp/claude-501/${E}/${SID}`,
    `/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("osTmpBase null/空白：Windows → 僅 session 根；POSIX → 僅硬寫 /tmp(+darwin /private/tmp)", () => {
  assertEquals(
    sessionTrustedReadRoots(`C:/Users/u/.claude/projects/-x/${SID}.jsonl`, SID, "C:/Users/u/.claude", "windows", null, null),
    [`C:/Users/u/.claude/projects/-x/${SID}`],
  );
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "linux", 501, null), [
    PROJ_ROOT,
    `/tmp/claude-501/${E}/${SID}`,
  ]);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "darwin", 501, "  "), [
    PROJ_ROOT,
    `/tmp/claude-501/${E}/${SID}`,
    `/private/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("uid=null：POSIX 無 tmp 根；Windows 不依賴 uid", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, CONFIG, "linux", null, "/tmp"), [PROJ_ROOT]);
});

Deno.test("前後空白：transcript 與 sessionId 皆 trim", () => {
  assertEquals(
    sessionTrustedReadRoots(`  ${TRANSCRIPT}  `, `  ${SID}  `, CONFIG, "linux", null, "/tmp"),
    [PROJ_ROOT],
  );
});

Deno.test("大小寫敏感：.JSONL 結尾 → []", () => {
  const up = `${CONFIG}/projects/${E}/${SID}.JSONL`;
  assertEquals(sessionTrustedReadRoots(up, SID, CONFIG, "linux", null, "/tmp"), []);
});

Deno.test("transcript basename 與 session_id 不符 → []", () => {
  const other = `${CONFIG}/projects/${E}/deadbeef.jsonl`;
  assertEquals(sessionTrustedReadRoots(other, SID, CONFIG, "linux", null, "/tmp"), []);
});

Deno.test("session_id 缺失/空白 → []", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, undefined, CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "   ", CONFIG, "linux", null, "/tmp"), []);
});

Deno.test("session_id 非安全路徑段（. / .. / 斜線 / 反斜線 / 點 / 空白）→ []", () => {
  assertEquals(sessionTrustedReadRoots(`${CONFIG}/projects/${E}/.jsonl`, ".", CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(`${CONFIG}/projects/${E}/...jsonl`, "..", CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a/b", CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a\\b", CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a.b", CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a b", CONFIG, "linux", null, "/tmp"), []);
});

Deno.test("transcript 不在 <configDir>/projects 下 → []", () => {
  const ssh = `${HOME}/.ssh/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(ssh, SID, CONFIG, "linux", 501, "/tmp"), []);
});

Deno.test("transcript dir 等於 projects 根（少一段）→ []", () => {
  const atRoot = `${CONFIG}/projects/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(atRoot, SID, CONFIG, "linux", 501, "/tmp"), []);
});

Deno.test("非絕對 / 非 .jsonl / 空 / undefined transcript → []；configDir=null → []", () => {
  assertEquals(sessionTrustedReadRoots(`projects/${E}/${SID}.jsonl`, SID, CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(`${CONFIG}/projects/${E}/${SID}.txt`, SID, CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots("", SID, CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(undefined, SID, CONFIG, "linux", null, "/tmp"), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, null, "linux", 501, "/tmp"), []);
});

Deno.test("碰撞免疫：/a/b 與 /a-b 共用 <E>=-a-b，但各 session 子樹以各自 sid 區隔", () => {
  const E2 = "-a-b";
  const sidA = "aaaaaaaa-0000-0000-0000-000000000000";
  const sidB = "bbbbbbbb-0000-0000-0000-000000000000";
  const a = sessionTrustedReadRoots(`${CONFIG}/projects/${E2}/${sidA}.jsonl`, sidA, CONFIG, "linux", null, null);
  const b = sessionTrustedReadRoots(`${CONFIG}/projects/${E2}/${sidB}.jsonl`, sidB, CONFIG, "linux", null, null);
  assertEquals(a, [`${CONFIG}/projects/${E2}/${sidA}`]);
  assertEquals(b, [`${CONFIG}/projects/${E2}/${sidB}`]);
  assertEquals(a[0] === b[0], false);
  assertEquals(a[0].startsWith(b[0] + "/") || b[0].startsWith(a[0] + "/"), false);
});

// —— resolveClaudeConfigDir —— //

Deno.test("resolveClaudeConfigDir：設 CLAUDE_CONFIG_DIR → 回正規化該值（忽略 home）", () => {
  assertEquals(resolveClaudeConfigDir(env({ CLAUDE_CONFIG_DIR: "/opt/cc" }), "/home/me"), "/opt/cc");
});

Deno.test("resolveClaudeConfigDir：未設 → <home>/.claude；home=null 且未設 → null；空白值 → 退回 home", () => {
  assertEquals(resolveClaudeConfigDir(env({}), "/home/me"), "/home/me/.claude");
  assertEquals(resolveClaudeConfigDir(env({}), null), null);
  assertEquals(resolveClaudeConfigDir(env({ CLAUDE_CONFIG_DIR: "   " }), "/home/me"), "/home/me/.claude");
});
