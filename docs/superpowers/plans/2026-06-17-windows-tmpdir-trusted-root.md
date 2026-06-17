# Windows tmpdir Trusted Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓本 PreToolUse(Bash) hook 把當前 session 的 Claude Code 背景任務輸出目錄（Windows `os.tmpdir()\claude\…` 無 uid、POSIX `…/claude-<uid>/…`）與工具輸出目錄納入 trusted 唯讀根，並對齊 Claude 真實的 `CLAUDE_CODE_TMPDIR`/`CLAUDE_CONFIG_DIR` env 覆寫。

**Architecture:** 推導邏輯集中在純函式 `sessionTrustedReadRoots`（不碰 FS/env），平台/env 讀取留在 `main.ts` I/O 邊界。新增 `resolveClaudeConfigDir(env, home)` 於 `claude_dir.ts`（依 domain），`settings.ts` 借它定位使用者 settings。tmp 來源為 `CLAUDE_CODE_TMPDIR ?? os.tmpdir()` 與 POSIX `/tmp`+darwin `/private/tmp` 的去重聯集。信任邊界純詞法、不做 FS/symlink/UNC 檢查（規格 §6.1 刻意決策）。

**Tech Stack:** Deno 2.8.2、TypeScript、`node:path/posix`（basename/dirname）、`node:os`（tmpdir）、`@std/assert`、`deno compile`。

**規格來源：** [docs/superpowers/specs/2026-06-17-windows-tmpdir-trusted-root-design.md](../specs/2026-06-17-windows-tmpdir-trusted-root-design.md)（commit 39376a6）

---

## 檔案結構

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/claude_dir.ts` | 修改 | 新增 `resolveClaudeConfigDir(env, home)`；重寫 `sessionTrustedReadRoots`（新簽名、`node:path/posix`、tmp 聯集）；移除自實作 `posixBasename`/`posixDirname` |
| `src/claude_dir_test.ts` | 重寫 | 全部改新簽名 + Windows/聯集/去重/env 覆寫/provenance/安全負向 + `resolveClaudeConfigDir` 單元測 |
| `src/main.ts` | 修改 | 讀 `Deno.build.os`/`Deno.uid()`/`CLAUDE_CODE_TMPDIR ?? tmpdir()`/`resolveClaudeConfigDir(env, home)` 並以新簽名呼叫 |
| `src/permissions/settings.ts` | 修改 | `import resolveClaudeConfigDir`，`loadPermissionRules` 以 configDir 定位使用者 settings.json |
| `src/permissions/settings_test.ts` | 增補 | `CLAUDE_CONFIG_DIR` 路徑定位測試 |
| `src/main_test.ts` | 增補 | e2e：`CLAUDE_CODE_TMPDIR` tmp 輸出 + `CLAUDE_CONFIG_DIR` tool-results |
| `deno.json` | 修改 | `build` task `--allow-env` 擴充新 env 鍵 |
| `CLAUDE.md` | 修改 | 更新 trusted read roots 說明段 |

**依賴方向（無循環）：** `settings.ts` → `claude_dir.ts` → (`type EnvReader`) `project.ts` + `engine/scope.ts` + `node:path/posix`；`main.ts` → `claude_dir.ts` + `settings.ts`。

---

## Task 1: 核心——重寫 `claude_dir.ts` 推導與 `main.ts` 呼叫端

> 簽名 `(transcriptPath, sessionId, home, uid, includePrivateTmp)` → `(transcriptPath, sessionId, claudeConfigDir, os, uid, osTmpBase)`。此變更同時破壞 `main.ts` 與 `claude_dir_test.ts` 編譯，故三檔同 Task 一起改。

**Files:**
- Modify: `src/claude_dir.ts`（整檔重寫）
- Modify: `src/main.ts:48-66`（else 分支呼叫端）
- Test: `src/claude_dir_test.ts`（整檔重寫）

- [ ] **Step 1: 重寫 `src/claude_dir_test.ts`（失敗測試先行）**

完整覆蓋新簽名 `(transcript, sid, configDir, os, uid, osTmpBase)`。注意 `normalizeAbsolute` 的磁碟形 `C:/…` 在所有平台都會被正規化（drive 比對不受 `IS_WINDOWS` 限制），故 Windows 形案例**不需** `ignore`。

```ts
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
```

- [ ] **Step 2: 跑測試確認失敗（簽名不符 / 匯出不存在）**

Run: `deno test --allow-env src/claude_dir_test.ts`
Expected: FAIL — `resolveClaudeConfigDir` 不存在、且舊 `sessionTrustedReadRoots` 簽名不符（型別/長度錯誤）。

- [ ] **Step 3: 重寫 `src/claude_dir.ts`（整檔）**

```ts
import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";
import { basename, dirname } from "node:path/posix";
import type { EnvReader } from "./project.ts";

/** session_id 安全單一路徑段：僅 alnum / '_' / '-'（UUID 形即符合）；拒 . / .. / 分隔符 / 點 / 空。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Claude 設定目錄解析（依 domain 與 trusted root 推導同置於本檔）：
 * CLAUDE_CONFIG_DIR（去空白、正規化）優先，否則 <home>/.claude；home 亦無 → null。
 * 收已解析的 home 參數、不內呼 resolveHome，維持 settings.ts → claude_dir.ts 單向依賴、避免循環。
 */
export function resolveClaudeConfigDir(env: EnvReader, home: string | null): string | null {
  const explicit = env.get("CLAUDE_CONFIG_DIR");
  if (explicit && explicit.trim() !== "") return normalizeAbsolute(explicit.trim());
  if (home === null) return null;
  return normalizeAbsolute(`${home}/.claude`);
}

/**
 * 推導「當前 session 的 Claude Code 工具/任務輸出子目錄」清單（trusted read roots）。
 * 全部以 .../<session_id>/ 結尾（以全域唯一 session_id 為鍵 → 碰撞免疫）。
 * 任一安全閘不過或前置缺失 → []（fail-safe）。純詞法、不碰 FS/env、不丟例外。
 *
 * @param claudeConfigDir CLAUDE_CONFIG_DIR ?? <home>/.claude（由 main.ts 解析；null → []）
 * @param os              Deno.build.os 的值（"windows"/"darwin"/"linux"…）
 * @param uid             Deno.uid() 結果（呼叫端 try/catch；null 時 POSIX 不產生 tmp 系根、Windows 不受影響）
 * @param osTmpBase       CLAUDE_CODE_TMPDIR ?? os.tmpdir()（由 main.ts 解析；null/空 → 不納入該 base）
 */
export function sessionTrustedReadRoots(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  claudeConfigDir: string | null,
  os: string,
  uid: number | null,
  osTmpBase: string | null,
): string[] {
  if (claudeConfigDir === null) return [];
  if (!sessionId || sessionId.trim() === "") return [];
  if (!transcriptPath || transcriptPath.trim() === "") return [];

  const trimmedSessionId = sessionId.trim();
  if (!SAFE_SESSION_ID.test(trimmedSessionId)) return []; // 先於任何把 sid 串入路徑的動作

  const trimmedTranscript = transcriptPath.trim();
  if (!isAbsolute(trimmedTranscript)) return [];
  if (!toPosix(trimmedTranscript).endsWith(".jsonl")) return []; // 大小寫敏感

  const absoluteTranscript = normalizeAbsolute(trimmedTranscript);
  if (basename(absoluteTranscript) !== trimmedSessionId + ".jsonl") return []; // transcript 檔名須等於 <session_id>.jsonl

  const encodedProjectDir = dirname(absoluteTranscript); // <configDir>/projects/<E>
  const projectsRoot = normalizeAbsolute(claudeConfigDir + "/projects");
  if (!isWithin(projectsRoot, encodedProjectDir) || encodedProjectDir === projectsRoot) return []; // transcript 須在 <configDir>/projects/<E> 之下且非該根本身

  const encodedSegment = basename(encodedProjectDir); // <E>（權威編碼段，非重算）
  const trustedRoots: string[] = [normalizeAbsolute(encodedProjectDir + "/" + trimmedSessionId)];

  // —— tmp 來源跨 OS 聯集（純靜態目錄推導；信任 osTmpBase，不做 fs/symlink/junction/UNC/共享檢查）——
  const normalizedOsTmp = osTmpBase && osTmpBase.trim() !== "" ? normalizeAbsolute(osTmpBase.trim()) : null;
  let tmpBases: { base: string; claudeDirName: string }[] = [];
  if (os === "windows") {
    if (normalizedOsTmp !== null) tmpBases = [{ base: normalizedOsTmp, claudeDirName: "claude" }]; // 無 uid
  } else if (uid !== null) {
    const claudeDirName = "claude-" + uid;
    tmpBases = [normalizedOsTmp, "/tmp", os === "darwin" ? "/private/tmp" : null]
      .filter((base): base is string => base !== null)
      .map((base) => ({ base, claudeDirName }));
  }
  for (const { base, claudeDirName } of tmpBases) {
    trustedRoots.push(
      normalizeAbsolute(base + "/" + claudeDirName + "/" + encodedSegment + "/" + trimmedSessionId),
    );
  }

  const dedupedRoots = [...new Set(trustedRoots)]; // normalizedOsTmp 與 /tmp 相同時去重、保序

  // Post-construction 不變量（defense-in-depth）：session 根 dirname 必為已驗證的 encodedProjectDir，
  // 且每個 root 的 basename 必為 sid。SAFE_SESSION_ID 已保證恆成立，此處僅防未來回歸。
  if (dirname(dedupedRoots[0]) !== encodedProjectDir) return [];
  for (const root of dedupedRoots) {
    if (basename(root) !== trimmedSessionId) return [];
  }
  return dedupedRoots;
}
```

- [ ] **Step 4: 更新 `src/main.ts` 呼叫端**

把 import 與 else 分支改為新簽名。將 `src/main.ts:8` 的
`import { sessionTrustedReadRoots } from "./claude_dir.ts";`
改為：

```ts
import { resolveClaudeConfigDir, sessionTrustedReadRoots } from "./claude_dir.ts";
```

在檔案頂部 import 區（與其他 import 並列）新增：

```ts
import { tmpdir } from "node:os";
```

將 `src/main.ts` 的 else 分支（現為 `const command = …` 到 `decision = evaluate(…)`）整段替換為：

```ts
    const command = input.tool_input?.command ?? "";
    const rules = loadPermissionRules(Deno.env, root);
    const home = homeDir(Deno.env);
    const claudeConfigDir = resolveClaudeConfigDir(Deno.env, home);
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
```

- [ ] **Step 5: 型別檢查 + lint + 測試**

Run: `deno task check && deno task lint && deno test --allow-env src/claude_dir_test.ts`
Expected: PASS（型別綠、lint 綠、claude_dir 全部測試通過）。

- [ ] **Step 6: 全測試回歸**

Run: `deno task test`
Expected: PASS（既有 main_test e2e 等全綠；trusted 機制未變、僅簽名改動已同步呼叫端）。

- [ ] **Step 7: Commit**

```bash
git add src/claude_dir.ts src/claude_dir_test.ts src/main.ts
git commit -F - <<'EOF'
feat(claude-dir): cross-OS tmp union + CLAUDE_CODE_TMPDIR/CLAUDE_CONFIG_DIR-aware trusted roots

sessionTrustedReadRoots 改 (transcript, sid, claudeConfigDir, os, uid, osTmpBase)：
tmp base 取 CLAUDE_CODE_TMPDIR ?? os.tmpdir() 與 POSIX /tmp、darwin /private/tmp
去重聯集，Windows 用 claude（無 uid）；改用 node:path/posix；新增 resolveClaudeConfigDir。
main.ts 在 I/O 邊界解析 env/平台值並傳入。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `settings.ts` 以 `CLAUDE_CONFIG_DIR` 定位使用者 settings

**Files:**
- Modify: `src/permissions/settings.ts:160-199`（`loadPermissionRules` 內 home/.claude 路徑組裝）
- Test: `src/permissions/settings_test.ts`（增補）

- [ ] **Step 1: 增補失敗測試（settings_test.ts 末尾追加）**

```ts
Deno.test("CLAUDE_CONFIG_DIR 設定時，使用者 settings 改讀 <configDir>/settings.json", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(
    fakeEnv({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "/opt/cc" }),
    ROOT,
    reader,
  );
  assertEquals(requested, [
    "/proj/.claude/settings.json",
    "/proj/.claude/settings.local.json",
    "/opt/cc/settings.json",
  ]);
});

Deno.test("CLAUDE_CONFIG_DIR 未設時，使用者 settings 仍讀 <home>/.claude/settings.json（相容）", () => {
  const requested: string[] = [];
  const reader: ReadText = (path) => {
    requested.push(path);
    return null;
  };
  loadPermissionRules(fakeEnv({ HOME: "/home/u" }), ROOT, reader);
  assertEquals(requested[2], "/home/u/.claude/settings.json");
});

// resolveClaudeConfigDir 的單元測在 claude_dir_test.ts；此處僅驗 loadPermissionRules 整合
Deno.test("loadPermissionRules 讀入自訂 configDir 的 permissions 規則", () => {
  const rules = loadPermissionRules(
    fakeEnv({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "/opt/cc" }),
    ROOT,
    fakeReadText({ "/opt/cc/settings.json": JSON.stringify({ permissions: { allow: ["Bash(z:*)"] } }) }),
  );
  assertEquals(rules.bash.allow, [{ kind: "prefix-boundary", prefix: "z" }]);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `deno test --allow-env src/permissions/settings_test.ts`
Expected: FAIL —「requests …」斷言收到 `/home/u/.claude/settings.json`（仍走舊邏輯），與期望的 `/opt/cc/settings.json` 不符。

- [ ] **Step 3: 修改 `loadPermissionRules`**

在 `src/permissions/settings.ts` 頂部 import 區新增：

```ts
import { resolveClaudeConfigDir } from "../claude_dir.ts";
```

將 `loadPermissionRules` 內現有的：

```ts
    const home = resolveHome(env);
    if (home !== null) {
      paths.push(normalizeAbsolute(`${home}/.claude/settings.json`));
    }
```

替換為：

```ts
    const home = resolveHome(env); // 供 parsePathRule 的 ~ 展開、並傳給 resolveClaudeConfigDir
    const configDir = resolveClaudeConfigDir(env, home);
    if (configDir !== null) {
      paths.push(normalizeAbsolute(`${configDir}/settings.json`));
    }
```

（`home` 仍傳給 `parseFile(readText(path), home)`，`~/` 展開行為不變。）

- [ ] **Step 4: 型別檢查 + lint + 測試**

Run: `deno task check && deno task lint && deno test --allow-env src/permissions/settings_test.ts`
Expected: PASS（含既有「requests the three expected file paths」「no home env」等回歸；未設 CLAUDE_CONFIG_DIR 時路徑不變）。

- [ ] **Step 5: Commit**

```bash
git add src/permissions/settings.ts src/permissions/settings_test.ts
git commit -F - <<'EOF'
feat(settings): locate user settings via CLAUDE_CONFIG_DIR ?? <home>/.claude

loadPermissionRules 改用 claude_dir.ts 的 resolveClaudeConfigDir 定位使用者 settings.json；
未設 CLAUDE_CONFIG_DIR 時路徑與既有完全相容。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `deno.json` build task `--allow-env` 擴充

> 編譯後 binary 需讀 `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_TMPDIR`，以及 `node:os` tmpdir 的 `TMPDIR/TMP/TEMP/SystemRoot/windir`。`test` task 已 unscoped，不需改。

**Files:**
- Modify: `deno.json:11`（build task）

- [ ] **Step 1: 修改 build task 的 `--allow-env`**

將 `deno.json` 的：

```json
    "build": "deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE --allow-sys=uid --output dist/permission-checker src/main.ts"
```

改為：

```json
    "build": "deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE,CLAUDE_CONFIG_DIR,CLAUDE_CODE_TMPDIR,TMPDIR,TMP,TEMP,SystemRoot,windir --allow-sys=uid --output dist/permission-checker src/main.ts"
```

- [ ] **Step 2: 驗證可建置**

Run: `deno task build`
Expected: 成功產出 `dist/permission-checker.exe`（無權限/編譯錯誤）。

- [ ] **Step 3: Commit**

```bash
git add deno.json
git commit -F - <<'EOF'
build: grant binary env access for CLAUDE_CONFIG_DIR/CLAUDE_CODE_TMPDIR + os.tmpdir keys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `main_test.ts` e2e（CLAUDE_CODE_TMPDIR 任務輸出 + CLAUDE_CONFIG_DIR tool-results）

> 既有 e2e 用 `runHookWithEnv`（`deno run --allow-env --allow-read --allow-sys=uid`）+ `e2ePayload`。新增案用顯式 env 覆寫避免 `os.tmpdir()` 不確定性：`CLAUDE_CODE_TMPDIR` 案直接指定 tmp base，dir 名依平台（Windows `claude`、否則 `claude-<uid>`）。

**Files:**
- Test: `src/main_test.ts`（末尾追加）

- [ ] **Step 1: 追加 e2e 測試**

在 `src/main_test.ts` 末尾追加（沿用既有 `runHookWithEnv`/`e2ePayload`/`E2E_*` 常數與既有的 `normalizeAbsolute` import；**不需** `node:os`——tmp base 用正斜線字串或經 `normalizeAbsolute` 的 `TEMP`，避免 Windows 反斜線在 Bash 被當跳脫）：

```ts
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
```

> 註：`Deno.uid()` 於 Windows 回 `null`；`claude-${Deno.uid()}` 僅在非 Windows 分支取值（三元已先判 `windows`）。
> 既有 N4 e2e（`memory/`、他 session 子目錄）維持綠燈，新增涵蓋 transcript `.jsonl` 本身；Windows 預設
> os.tmpdir() 案以 `TEMP` 餵入使子行程 `os.tmpdir()` 確定、驗證 `CLAUDE_CODE_TMPDIR ?? tmpdir()` 的 fallback 分支。

- [ ] **Step 2: 跑 e2e 測試**

Run: `deno test --allow-run --allow-env --allow-read --allow-sys=uid src/main_test.ts`
Expected: PASS（新增 e2e 全綠；Windows 預設 os.tmpdir() 案僅於 Windows 執行、其餘平台被 `ignore` 跳過；既有 e2e 含 N4 維持綠燈）。

- [ ] **Step 3: Commit**

```bash
git add src/main_test.ts
git commit -F - <<'EOF'
test(main): e2e for CLAUDE_CODE_TMPDIR task output and CLAUDE_CONFIG_DIR tool-results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Operational verification + `CLAUDE.md` 文件更新

**Files:**
- Modify: `CLAUDE.md`（trusted read roots 說明段）
- 無新測試（驗證為手動餵 JSON 給 binary）

- [ ] **Step 1: 重新建置 binary**

Run: `deno task build`
Expected: 產出 `dist/permission-checker.exe`。

- [ ] **Step 2: Operational verification（Windows）——背景任務輸出 allow**

於 Git-Bash 執行（以 `CLAUDE_CODE_TMPDIR` 顯式指定 base，避免 os.tmpdir() 差異；`E`/`SID` 自訂、與 transcript 檔名相符）：

```bash
H="C:/Users/$USERNAME"; CFG="$H/.claude"; E="-x-proj"; SID="115826ef-e830-461f-8101-edac56694d2b"
T="$CFG/projects/$E/$SID.jsonl"; TB="D:/cc-e2e-tmp"
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"tail -5 $TB/claude/$E/$SID/tasks/a.output\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" CLAUDE_CODE_TMPDIR="$TB" ./dist/permission-checker.exe; echo "(exit=$?)"
```
Expected: `permissionDecision":"allow"`、`(exit=0)`。

- [ ] **Step 3: Operational verification——對照與否決案**

```bash
# (a) 同 session tool-results -> allow
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $CFG/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 allow

# (b) 預設 os.tmpdir()（不帶 CLAUDE_CODE_TMPDIR）背景輸出 -> allow（起因 bug 之預設路徑）
TMPD="$(node -e 'process.stdout.write(require("os").tmpdir())' | tr '\\' '/')"
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"tail -5 $TMPD/claude/$E/$SID/tasks/a.output\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 allow

# (c) CLAUDE_CONFIG_DIR 自訂下 tool-results -> allow
CFG2="D:/cc-cfg"; T2="$CFG2/projects/$E/$SID.jsonl"
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $CFG2/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T2\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" CLAUDE_CONFIG_DIR="$CFG2" ./dist/permission-checker.exe
# 期望 allow

# (d) <CLAUDE_CONFIG_DIR>/settings.json 的 permissions 確被讀入並影響判定：
#     放一條 allow 規則，餵一個 allowlist 外（builtin 會 ask）的指令 -> 應升級為 allow
mkdir -p "$CFG2"
echo '{"permissions":{"allow":["Bash(npm run build:*)"]}}' > "$CFG2/settings.json"
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm run build\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T2\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" CLAUDE_CONFIG_DIR="$CFG2" ./dist/permission-checker.exe
# 期望 allow（理由命中 permissions.allow；證明自訂 config 的 settings.json 被讀入）

# (e) transcript 檔名與 session_id 不符 -> ask
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $CFG/projects/$E/$SID/tool-results/x.txt\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$CFG/projects/$E/deadbeef.jsonl\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 ask

# (f) transcript 在 <configDir>/projects 之外 -> ask（位置綁定）
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.ssh/$SID/secret\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$H/.ssh/$SID.jsonl\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 ask

# (g) 同專案 memory -> ask（不自動放行）
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $CFG/projects/$E/memory/n.md\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 ask

# (h) 他 session 子目錄 -> ask（不自動放行）
echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $CFG/projects/$E/deadsess/tool-results/x.txt\"},\"cwd\":\"D:/x/proj\",\"session_id\":\"$SID\",\"transcript_path\":\"$T\"}" \
  | USERPROFILE="$H" CLAUDE_PROJECT_DIR="D:/x/proj" ./dist/permission-checker.exe
# 期望 ask
```
Expected: (a)(b)(c)(d) `allow`；(e)(f)(g)(h) `ask`。任一不符即回 Task 1/2 修正。

- [ ] **Step 4: 更新 `CLAUDE.md`**

在 `CLAUDE.md` 描述 trusted read roots 的段落（提及 `claude_dir.ts` 的 `sessionTrustedReadRoots`、`/tmp/claude-<uid>` 的那一節）更新，反映新行為。下面整段為**要寫進 `CLAUDE.md` 的最終文字**——不得含對 spec/plan 的章節引用（如「§…」「見規格」），須自述：

```markdown
trusted read root 對齊 Claude Code 真實行為（依反編譯 2.1.179 之 `MI()`/`QYz()`/`Mq` 取證）：
- **背景任務輸出 base** 取 `CLAUDE_CODE_TMPDIR ?? os.tmpdir()`，與 POSIX 硬寫 `/tmp`、darwin `/private/tmp` 做
  **去重聯集**；tmp 子目錄名在 **Windows 為 `claude`（無 uid）**、其他平台為 `claude-<uid>`。
- **工具輸出**（`tool-results/`）與**使用者 `settings.json`** 的根取 `CLAUDE_CONFIG_DIR ?? <home>/.claude`；
  `resolveClaudeConfigDir(env, home)` 置於 `claude_dir.ts`（`settings.ts` 借用以定位使用者 settings）。
- 路徑切割改用 `node:path/posix` 的 `basename`/`dirname`。
- 信任邊界**純詞法、不碰檔案系統**（不做 symlink/junction/UNC/共享目錄檢查）；以全域唯一 `session_id` 為信任鍵；
  `transcript_path`/`session_id` 與行程 env（`CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_TMPDIR`/`os.tmpdir()`）同源於當前
  session。使用者把 `TEMP`/`CLAUDE_CODE_TMPDIR`/`CLAUDE_CONFIG_DIR` 重導向到非私有/共享位置，屬使用者自負的設定風險。
- binary 之 `--allow-env` 已含 `CLAUDE_CONFIG_DIR,CLAUDE_CODE_TMPDIR,TMPDIR,TMP,TEMP,SystemRoot,windir`（另 `--allow-sys=uid`）。
```

- [ ] **Step 5: 最終全綠驗證**

Run: `deno task check && deno task lint && deno task test`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -F - <<'EOF'
docs: document CLAUDE_CODE_TMPDIR/CLAUDE_CONFIG_DIR-aware trusted roots in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## 完成準則

- `deno task check`、`deno task lint`、`deno task test` 全綠。
- Operational verification：Windows 背景任務輸出（預設 os.tmpdir() 與 `CLAUDE_CODE_TMPDIR` 兩形）`allow`、tool-results `allow`、`CLAUDE_CONFIG_DIR` 自訂 `allow` 且其 `settings.json` 規則生效；transcript 檔名/位置綁定不符與 N4 路徑 `ask`。
- 既有 trusted/deny e2e 全數維持綠燈。
- `CLAUDE.md` 已反映新行為。
