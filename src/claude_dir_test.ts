import { assertEquals } from "@std/assert";
import { sessionTrustedReadRoots } from "./claude_dir.ts";

const HOME = "/home/me";
const SID = "115826ef-e830-461f-8101-edac56694d2b";
const E = "-home-me-Sources-proj";
const TRANSCRIPT = `${HOME}/.claude/projects/${E}/${SID}.jsonl`;
const CLAUDE_ROOT = `${HOME}/.claude/projects/${E}/${SID}`;

Deno.test("合法：uid + privateTmp → 三根（~/.claude + /tmp + /private/tmp），皆以 sid 結尾", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, 501, true);
  assertEquals(roots, [
    CLAUDE_ROOT,
    `/tmp/claude-501/${E}/${SID}`,
    `/private/tmp/claude-501/${E}/${SID}`,
  ]);
});

Deno.test("uid 給定、privateTmp=false → 不含 /private/tmp", () => {
  const roots = sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, 501, false);
  assertEquals(roots, [CLAUDE_ROOT, `/tmp/claude-501/${E}/${SID}`]);
});

Deno.test("uid=null → 僅 ~/.claude 一根", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, HOME, null, true), [CLAUDE_ROOT]);
});

Deno.test("前後空白：transcript 與 sessionId 皆 trim", () => {
  const roots = sessionTrustedReadRoots(`  ${TRANSCRIPT}  `, `  ${SID}  `, HOME, null, true);
  assertEquals(roots, [CLAUDE_ROOT]);
});

Deno.test("大小寫敏感：.JSONL 結尾 → []", () => {
  const up = `${HOME}/.claude/projects/${E}/${SID}.JSONL`;
  assertEquals(sessionTrustedReadRoots(up, SID, HOME, null, true), []);
});

Deno.test("transcript basename 與 session_id 不符 → []", () => {
  const other = `${HOME}/.claude/projects/${E}/deadbeef.jsonl`;
  assertEquals(sessionTrustedReadRoots(other, SID, HOME, null, true), []);
});

Deno.test("session_id 缺失/空白 → []", () => {
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, undefined, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "   ", HOME, null, true), []);
});

Deno.test("session_id 非安全路徑段（. / .. / 斜線 / 反斜線 / 點 / 空白）一律回 []", () => {
  // sid="." 即使 transcript basename 湊成 ".jsonl"，安全段檢查先擋（不得收斂回 <E>）
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/.jsonl`, ".", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/...jsonl`, "..", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a/b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a\\b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a.b", HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, "a b", HOME, null, true), []);
});

Deno.test("transcript 不在 ~/.claude/projects 下 → []", () => {
  const ssh = `${HOME}/.ssh/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(ssh, SID, HOME, 501, true), []);
});

Deno.test("transcript dir 等於 projects 根（少一段）→ []", () => {
  const atRoot = `${HOME}/.claude/projects/${SID}.jsonl`;
  assertEquals(sessionTrustedReadRoots(atRoot, SID, HOME, 501, true), []);
});

Deno.test("非絕對 / 非 .jsonl / 空 / undefined transcript → []；home=null → []", () => {
  assertEquals(sessionTrustedReadRoots(`projects/${E}/${SID}.jsonl`, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(`${HOME}/.claude/projects/${E}/${SID}.txt`, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots("", SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(undefined, SID, HOME, null, true), []);
  assertEquals(sessionTrustedReadRoots(TRANSCRIPT, SID, null, 501, true), []);
});

Deno.test("碰撞免疫：/a/b 與 /a-b 共用 <E>=-a-b，但各 session 子樹以各自 sid 區隔", () => {
  const E2 = "-a-b";
  const sidA = "aaaaaaaa-0000-0000-0000-000000000000";
  const sidB = "bbbbbbbb-0000-0000-0000-000000000000";
  const a = sessionTrustedReadRoots(`${HOME}/.claude/projects/${E2}/${sidA}.jsonl`, sidA, HOME, null, false);
  const b = sessionTrustedReadRoots(`${HOME}/.claude/projects/${E2}/${sidB}.jsonl`, sidB, HOME, null, false);
  assertEquals(a, [`${HOME}/.claude/projects/${E2}/${sidA}`]);
  assertEquals(b, [`${HOME}/.claude/projects/${E2}/${sidB}`]);
  // 兩者互不涵蓋（不同 sid 子樹）：不相等，且任一不在另一之下
  assertEquals(a[0] === b[0], false);
  assertEquals(a[0].startsWith(b[0] + "/") || b[0].startsWith(a[0] + "/"), false);
});

Deno.test({
  name: "Windows：drive 路徑正規化後仍正確綁定（Windows 上 Deno.uid()→null，僅 ~/.claude 根）",
  ignore: Deno.build.os !== "windows",
  fn() {
    const wHome = "C:/Users/me";
    const wE = "-c-Users-me-proj"; // 示意：實際編碼由 Claude 決定；此處只驗正規化/綁定一致性
    const wTranscript = `${wHome}/.claude/projects/${wE}/${SID}.jsonl`;
    // Windows 上 main.ts 取不到 uid（Deno.uid() 回 null），故只應產生 ~/.claude 根
    const roots = sessionTrustedReadRoots(wTranscript, SID, wHome, null, false);
    assertEquals(roots, [`C:/Users/me/.claude/projects/${wE}/${SID}`]);
  },
});
