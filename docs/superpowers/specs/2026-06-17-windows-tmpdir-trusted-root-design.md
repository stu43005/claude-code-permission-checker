# 設計規格：補齊 Windows 背景任務輸出目錄為 trusted 唯讀根，並對齊 Claude Code 真實 tmp/config 目錄解析

- 日期：2026-06-17
- 狀態：設計（待實作）
- 前置規格：[2026-06-14-allow-claude-output-dir-design.md](./2026-06-14-allow-claude-output-dir-design.md)（本規格延伸並**修正**其 tmp 來源推導）
- 上游證據：反編譯本機已安裝 **Claude Code 2.1.179**（`~/.local/share/claude/versions/2.1.179`，Bun 編譯 PE，
  `GIT_SHA 8c865e06ae1320b1c9b005bdeb6f6589ada9d0b3`、`PACKAGE_URL @anthropic-ai/claude-code`）取得真實函式與字面常數。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook。前置規格實作了「把當前 session 的 Claude Code
工具/任務輸出子目錄視為唯讀延伸範圍」，由 `src/claude_dir.ts` 的 `sessionTrustedReadRoots` 推導 trusted read roots，
以全域唯一 `session_id` 為信任鍵（所有根皆以 `/<session_id>/` 結尾、碰撞免疫），經 `ScopeConfig.trusted` 在
`isReadScoped` 的 allow 層比對。

### 1.1 痛點（Windows 平台缺口）

前置規格的背景任務輸出根**只重建 POSIX 形式**：

```ts
const bases = includePrivateTmp ? ["/tmp", "/private/tmp"] : ["/tmp"];
roots.push(normalizeAbsolute(b + "/claude-" + uid + "/" + e + "/" + sid));
```

而 Claude Code 在 **Windows** 把背景任務輸出寫到 `%LOCALAPPDATA%\Temp\claude\<E>\<sid>\tasks\...`
（即 `os.tmpdir()\claude\...`，**無 `-<uid>` 後綴**）。此位置不在任何 trusted 根之內，且 Windows 上
`Deno.uid()` 回 `null` → POSIX 的 `/tmp` 分支整段被跳過。結果：Windows 上讀背景任務輸出一律被判 `ask`。

#### 已實證（operational verification，2026-06-17，Windows）

對既有 binary 餵真實 hook JSON：

```text
指令：tail -15 "/c/Users/<user>/AppData/Local/Temp/claude/<E>/<sid>/tasks/<id>.output" | grep -v ... | grep -v ...
transcript_path：C:/Users/<user>/.claude/projects/<E>/<sid>.jsonl
session_id：<sid>（合法 UUID，與 transcript 檔名相符）
→ 結果：ask（理由：tail 路徑超出專案範圍）
```

對照組（同 session 讀 `~/.claude/projects/<E>/<sid>/tool-results/x.txt`）→ `allow`，證實 trusted 機制本身在
Windows 正常、兩道安全閘通過，**唯一缺口是 Windows 背景任務輸出 base 未被涵蓋**。

`tail`/`grep` 皆在 allowlist；`grep -v <pattern>`（無檔案參數、讀 stdin）無路徑可檢。問題純粹在 tail 的路徑範圍。

### 1.2 Claude Code 真實目錄邏輯（反編譯 2.1.179 bundle 取證）

從真實 bundle 取出的關鍵函式（字面常數，非推測）：

```js
// 背景任務輸出 base：CLAUDE_CODE_TMPDIR 優先，否則 os.tmpdir()
function MI(){ if(process.env.CLAUDE_CODE_TMPDIR) return process.env.CLAUDE_CODE_TMPDIR; return os.tmpdir() }
// tmp 子目錄名：Windows = "claude"；非 Windows = "claude-<uid>"（uid 來自 getuid()）
function QYz(){ if(platform()==="windows") return "claude"; return `claude-${process.getuid?.()??0}` }
// 背景任務輸出完整路徑： <MI()>/claude[-uid]/<E>/<sid>/tasks/<id>.output
// 工具輸出 base：configDir = CLAUDE_CONFIG_DIR ?? <home>/.claude（NFC 正規化）
Mq = (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),".claude")).normalize("NFC")
// 工具輸出完整路徑： <configDir>/projects/<E>/<sid>/tool-results/<id>.{txt|json}
// <E> 編碼：把所有非英數字元換 "-"（>200 字才截斷加 hash）
function Bw(H){ return H.replace(/[^a-zA-Z0-9]/g,"-") /* … */ }
```

各 OS `os.tmpdir()` 行為 vs Claude 實際輸出目錄：

| OS | `os.tmpdir()` 實際回傳 | Claude 背景任務輸出 base（`MI()`） | tmp 子目錄（`QYz()`） |
|---|---|---|---|
| **Linux** | `TMPDIR\|\|TMP\|\|TEMP\|\|/tmp`（多半字面 `/tmp`），不解 symlink | `CLAUDE_CODE_TMPDIR \|\| os.tmpdir()` | `claude-<uid>` |
| **macOS** | `$TMPDIR`（launchd 設為 `/var/folders/…/T`）；全未設才字面 `/tmp`；**永不解 symlink、永不回 `/private/tmp`**（nodejs/node#11422） | `CLAUDE_CODE_TMPDIR \|\| os.tmpdir()`（**非硬寫 `/tmp`**；另維護 `/tmp↔/private/tmp` realpath 對照供比對） | `claude-<uid>` |
| **Windows** | `TEMP\|\|TMP\|\|(SystemRoot\|\|windir)\temp`；預設 `%LOCALAPPDATA%\Temp` | `CLAUDE_CODE_TMPDIR \|\| os.tmpdir()` | `claude`（**無 uid**） |

**重要更正**：前置規格 §1.2.6 稱「macOS base 為硬寫 `/tmp/claude-<uid>`」**有誤**。真實程式碼三平台**一致**用
`CLAUDE_CODE_TMPDIR || os.tmpdir()` + `QYz()` 命名。macOS 的 `os.tmpdir()` 多為 `/var/folders/…`，Claude 即寫在那；
`/tmp`/`/private/tmp` 只是 `$TMPDIR` 未設時的 fallback 與 symlink 等價形。本檢查器純詞法、不 realpath，故仍**以聯集
同時納入** `os.tmpdir()`、`/tmp`、（darwin）`/private/tmp`，以覆蓋實際 base 與 `/tmp↔/private/tmp` 兩種字面形。

另查得：Claude **Read tool** 內部權限（`RbH`）對「tool-results 目錄」「專案 temp 目錄（含 `tasks/*.output`）」等
**自動放行讀取**，但那是 Read tool；走 **Bash** 的 `cat`/`tail`/`grep` 不經此邏輯——正是本 hook 要補的缺口。
（Read 另自動放行：cwd 專案目錄、Plan/scratchpad、背景 job `CLAUDE_JOB_DIR/tmp/`、`<configDir>/tasks`、
`<configDir>/teams`、agent memory `.md`、bundled-skills——本規格**不**納入這些，列為未來可參考範圍。）

### 1.3 本功能要改的事

1. `sessionTrustedReadRoots` 的「tmp 來源推導」改為**跨 OS 聯集**（`os.tmpdir()` + POSIX `/tmp` + darwin `/private/tmp`，
   Windows `claude` 無 uid），全部推導邏輯集中在函式內。
2. **對齊 Claude 真實 env 覆寫**：tmp base 改用 `CLAUDE_CODE_TMPDIR ?? os.tmpdir()`；trusted 的 projects 根與
   `settings.ts` 讀使用者 settings 的位置改用 `CLAUDE_CONFIG_DIR ?? <home>/.claude`。
3. `main.ts` 退為純 I/O 邊界，只讀原始平台/env 值（`Deno.build.os`、`Deno.uid()`、`CLAUDE_CODE_TMPDIR ?? tmpdir()`、
   `CLAUDE_CONFIG_DIR ?? <home>/.claude`）並傳入。
4. POSIX 路徑切割改用 `node:path/posix`，移除自實作 helper。

兩道安全閘維持不變。

## 2. 目標與非目標

### 2.1 目標

- G1：**Windows** 背景任務輸出 `<tmpBase>\claude\<E>\<sid>\...`（含 `tasks/`）下的 allowlist 唯讀指令路徑判為 in-project。
- G2：**跨 OS 聯集 tmp 來源**——所有 OS 都納入 `os.tmpdir()`，POSIX 另補 `/tmp`、darwin 另補 `/private/tmp`
  （覆蓋實際 base 與 `/tmp↔/private/tmp` 字面等價）；相同 base 去重。
- G3：tmp 推導邏輯**集中在 `sessionTrustedReadRoots`**；`main.ts` 只讀原始值。
- G4：`sessionTrustedReadRoots` 維持**純函式**（不呼叫 `Deno.*`/`node:os`、無副作用、不碰 FS）；env/平台讀取留在 `main.ts`。
- G5：POSIX 路徑切割改用 `node:path/posix` 的 `basename`/`dirname`（不自實作）；移除既有 `posixBasename`/`posixDirname`。
- G6：所有安全不變量維持（見 §6）：以 `session_id` 為信任鍵（碰撞免疫）、兩道 fail-closed 安全閘、`deny`/`ask` 覆蓋
  trusted、只放寬讀取位置、fail-safe 退回 `ask`。
- G7：**對齊 `CLAUDE_CODE_TMPDIR`**：tmp base 取 `CLAUDE_CODE_TMPDIR ?? os.tmpdir()`（Claude 真實邏輯 `MI()`）。
- G8：**對齊 `CLAUDE_CONFIG_DIR`**：(a) trusted 的 projects 根閘改用 `CLAUDE_CONFIG_DIR ?? <home>/.claude`；
  (b) `src/permissions/settings.ts` 讀使用者 settings 的位置由寫死 `<home>/.claude/settings.json` 改為
  `<CLAUDE_CONFIG_DIR ?? <home>/.claude>/settings.json`。

### 2.2 非目標

- N1：不改動 `scope.ts`／`classify.ts`／`evaluate.ts`（`trusted` 穿線與 `isReadScoped` 比對已由前置規格完成）。
- N2：不放寬任何寫入型重導向、賦值前綴、非唯讀指令偵測；不改「遞迴遍歷根 → deny」硬性不變量。
- N3：不解析 symlink/不碰 FS；`/tmp`↔`/private/tmp` 以**字面同時納入**處理（見 §1.2、§6.1）。
- N4：不放行 `memory/`、歷史 session 子目錄、transcript `.jsonl` 本身（與前置規格 N4 一致）。
- N5：不對推導目錄做存在性 I/O 檢查（純詞法）。
- N6：不修改既有 `settingsAllows` 升級層行為。
- N7：不納入 Read tool 其他自動放行路徑（Plan/scratchpad/job tmp/configDir tasks/teams/bundled-skills 等，見 §1.2）。
- N8：不做 `CLAUDE_CONFIG_DIR` 的 NFC 正規化（上游有 `.normalize("NFC")`；本工具沿用既有非 NFC 行為，非 ASCII
  家目錄為極少數邊角，差異僅致 fail-closed 退 `ask`、不誤放行）。

## 3. 方案選擇

- **tmp 來源**：「`CLAUDE_CODE_TMPDIR ?? os.tmpdir()` 跨 OS 聯集 + POSIX `/tmp` + darwin `/private/tmp`」。理由見 §1.2：
  真實 base 三平台一致為 `MI()`；`/tmp`/`/private/tmp` 補字面等價；多餘 base 純詞法不 match、安全無害（§6.1）。
- **邏輯放置**：推導邏輯放 `sessionTrustedReadRoots`（純函式，接收 plain 值），平台/env 讀取放 `main.ts`/`settings.ts`。
- **env 覆寫**：`CLAUDE_CODE_TMPDIR`、`CLAUDE_CONFIG_DIR` 由 `main.ts`/`settings.ts` 在 I/O 邊界解析後傳入/使用。
- **路徑切割**：改用 `node:path/posix`。已驗證 Deno 2.8.2 `deno run` 與 `deno compile` 後 binary 皆可用、無需權限，
  且對「恆為絕對路徑」的輸入與既有自實作等價（唯一差異：無分隔符/空字串時 node 回 `"."`、舊版回 `null`，該分支
  在本流程不可達，且即便發生亦由後續 `isWithin` 閘 fail-safe 回 `[]`）。

## 4. 詳細設計

### 4.1 `src/claude_dir.ts`（trusted root 推導 + Claude 目錄解析）

`sessionTrustedReadRoots` 維持純函式（不碰 FS/env、不丟例外）；同檔另含 `resolveClaudeConfigDir`（依 domain 歸位，
讀 env 解析 Claude 目錄）。

移除自實作的 `posixBasename`/`posixDirname`，改自 `node:path/posix` 匯入 `basename`/`dirname`。函式簽名以
`(claudeConfigDir, os, uid, osTmpBase)` 取代既有的 `(home, uid, includePrivateTmp)`：

```ts
import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";
import { basename, dirname } from "node:path/posix";
import type { EnvReader } from "./project.ts";

/** session_id 安全單一路徑段：僅 alnum / '_' / '-'（UUID 形即符合）；拒 . / .. / 分隔符 / 點 / 空。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Claude 設定目錄解析（依 domain 與 trusted root 推導同置於本檔）：
 * CLAUDE_CONFIG_DIR（去空白、正規化）優先，否則 <home>/.claude；home 亦無 → null。
 * **收已解析的 `home` 參數、不內呼 `resolveHome`**，以維持 settings.ts → claude_dir.ts 的單向依賴、避免循環。
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
  if (!SAFE_SESSION_ID.test(trimmedSessionId)) return []; // 先於任何把 sid 串入路徑的動作（封 . / .. / 逃逸）

  const trimmedTranscript = transcriptPath.trim();
  if (!isAbsolute(trimmedTranscript)) return [];
  if (!toPosix(trimmedTranscript).endsWith(".jsonl")) return []; // 大小寫敏感

  const absoluteTranscript = normalizeAbsolute(trimmedTranscript);
  if (basename(absoluteTranscript) !== trimmedSessionId + ".jsonl") return []; // G5(a) session 綁定

  const encodedProjectDir = dirname(absoluteTranscript);                       // <configDir>/projects/<E>
  const projectsRoot = normalizeAbsolute(claudeConfigDir + "/projects");
  if (!isWithin(projectsRoot, encodedProjectDir) || encodedProjectDir === projectsRoot) return []; // G5(b) 位置綁定

  const encodedSegment = basename(encodedProjectDir);                          // <E>（權威編碼段，非重算）
  const trustedRoots: string[] = [normalizeAbsolute(encodedProjectDir + "/" + trimmedSessionId)]; // tool-results 等所在的 session 子目錄

  // —— tmp 來源跨 OS 聯集（純靜態目錄推導；信任 osTmpBase，不做 fs/symlink/junction/UNC/共享檢查，見 §6.1）——
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

  // Post-construction 不變量（defense-in-depth）：session 根（dedupedRoots[0]）的 dirname 必為已驗證的
  // encodedProjectDir，且每個 root 的 basename 必為 sid。SAFE_SESSION_ID 已保證恆成立，此處僅防未來回歸。
  if (dirname(dedupedRoots[0]) !== encodedProjectDir) return [];
  for (const root of dedupedRoots) {
    if (basename(root) !== trimmedSessionId) return [];
  }
  return dedupedRoots;
}
```

各 OS 產生的 trusted tmp 根（每個再接 `/<E>/<sid>`；`base` = `CLAUDE_CODE_TMPDIR ?? os.tmpdir()`）：

| OS | tmp bases（聯集） | 目錄段 |
|---|---|---|
| Linux | `{ base, /tmp }`（相同則去重） | `claude-<uid>` |
| macOS | `{ base, /tmp, /private/tmp }` | `claude-<uid>` |
| Windows | `{ base }` | `claude`（無 uid） |

### 4.2 `src/main.ts`（純 I/O 邊界：只讀原始值並傳入）

新增 `import { tmpdir } from "node:os";`；`resolveClaudeConfigDir` 與 `sessionTrustedReadRoots` 同檔，故
`import { sessionTrustedReadRoots, resolveClaudeConfigDir } from "./claude_dir.ts";`。

```ts
const home = homeDir(Deno.env);                                  // 仍供 evaluate 的 ScopeConfig.home
const claudeConfigDir = resolveClaudeConfigDir(Deno.env, home);  // CLAUDE_CONFIG_DIR ?? <home>/.claude
let uid: number | null = null;
try { uid = Deno.uid(); } catch { uid = null; }             // 權限/平台不支援 → null
let osTmpBase: string | null = null;
try {
  const explicit = Deno.env.get("CLAUDE_CODE_TMPDIR");      // 對齊 Claude MI()：CLAUDE_CODE_TMPDIR 優先
  osTmpBase = explicit && explicit.trim() !== "" ? explicit : tmpdir();
} catch { osTmpBase = null; }
const trusted = sessionTrustedReadRoots(
  input.transcript_path, input.session_id, claudeConfigDir, Deno.build.os, uid, osTmpBase,
);
decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);
```

### 4.3 `src/permissions/settings.ts`（讀使用者 settings 對齊 `CLAUDE_CONFIG_DIR`）

`resolveClaudeConfigDir` 改置於 `claude_dir.ts`（依 domain）；此處 `import { resolveClaudeConfigDir } from "../claude_dir.ts";`
並以已解析的 `home` 呼叫，定位使用者 settings（依賴單向 settings → claude_dir，無循環）：

```ts
import { resolveClaudeConfigDir } from "../claude_dir.ts";

// loadPermissionRules 內：
const home = resolveHome(env);                       // 供 parsePathRule 的 ~ 展開、並傳給 resolveClaudeConfigDir
const configDir = resolveClaudeConfigDir(env, home);
if (configDir !== null) {
  paths.push(normalizeAbsolute(`${configDir}/settings.json`)); // 取代既有 `${home}/.claude/settings.json`
}
```

說明：`~/` 在 path 規則中**仍展開為 home**（`parsePathRule(el, home)` 不變）；只有「使用者 settings.json 的**位置**」
改用 configDir。`CLAUDE_CONFIG_DIR` 未設時 `configDir = <home>/.claude`，與既有行為**完全相容**（路徑不變）。

### 4.4 `deno.json` 權限

`node:os` 的 `tmpdir()` 在編譯後 binary 內讀 env（POSIX：`TMPDIR/TMP/TEMP`；Windows：`TEMP/TMP/SystemRoot/windir`），
另加讀 `CLAUDE_CODE_TMPDIR`、`CLAUDE_CONFIG_DIR`。`build` task 的 scoped `--allow-env` 擴充（`--allow-sys=uid` 不變）：

```text
--allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE,CLAUDE_CONFIG_DIR,CLAUDE_CODE_TMPDIR,TMPDIR,TMP,TEMP,SystemRoot,windir
```

`test` task 已是 unscoped `--allow-env`，不需改。`node:path/posix`／`node:os` 皆為 built-in `node:` specifier，
不需加入 `imports` 對映。

### 4.5 不需改動者

`src/engine/scope.ts`（`ScopeConfig.trusted`、`isReadScoped` trusted 比對）、`src/engine/classify.ts`、
`src/engine/evaluate.ts`、`src/hook/types.ts`（`transcript_path?` 既有）皆維持不變。

## 5. 資料流

```text
stdin JSON ─▶ HookInput{ transcript_path?, session_id? }
   home = homeDir(env)；claudeConfigDir = CLAUDE_CONFIG_DIR ?? <home>/.claude
   uid = Deno.uid()|null；osTmpBase = CLAUDE_CODE_TMPDIR ?? node:os tmpdir() | null；os = Deno.build.os
   trusted = sessionTrustedReadRoots(transcript_path, session_id, claudeConfigDir, os, uid, osTmpBase)
              └─ G5 兩閘 → [] 或 N 個 .../<sid>/ 根（projects session 根一個 + 平台聯集 tmp 根，去重）
                                   ▼
        evaluate(…, rules, home, trusted) → classify(…, trusted)
        ScopeConfig{ root, home, allow, deny, ask, trusted }
        isReadScoped ── allow 層比對 trusted ──▶ in-project / out-of-project
```

## 6. 錯誤處理與不變量

- **Fail-safe**：`sessionTrustedReadRoots` 純字串運算、不丟例外；`Deno.uid()`/`tmpdir()`/env 讀取於 `main.ts` 包
  try/catch。任一不合法輸入、安全閘不過、`claudeConfigDir`/`uid`/`osTmpBase` 取不到 → 該根/該 base 不產生 → 至多
  `trusted = []` → 行為等同現況（`ask`）。最外層 try/catch 與 `exit 0` 不變。
- **以 `session_id` 為信任鍵（碰撞免疫）**：所有根仍以 `.../<sid>/` 結尾；聯集只擴充 base，不改變此鍵。
  post-construction 不變量逐根斷言 `basename(root) === sid`。
- **兩道 fail-closed 安全閘不變**：G5(a) `basename(absoluteTranscript) === sid + ".jsonl"`；
  G5(b) `encodedProjectDir` 嚴格位於 `<claudeConfigDir>/projects/` 之下且非該根本身。`SAFE_SESSION_ID` 仍封 path-escape。
- **信任 `osTmpBase`/Claude 目錄（刻意、不做額外驗證）**：`osTmpBase` 僅做靜態推導（`normalizeAbsolute` + null/空
  guard），不檢查私有性、不拒 UNC/共享。詳見 §6.1。
- **聯集多餘 base 安全無害**：純詞法比對，不被 Claude 使用的 base 只會產生無實檔對應的根，不誤放行（仍受 session_id
  鍵與 `deny`/`ask` 覆蓋約束）。
- **deny 硬性不變量**：tmp 根皆為深層子目錄（`.../<E>/<sid>`），永不等於磁碟根/home 根，`dangerousRoot` 不對其成立。
- **只放寬讀取位置**：寫入型重導向／賦值前綴／非唯讀指令偵測完全不動；`deny`/`ask` 仍覆蓋 trusted（`deny > ask > allow`）。
- **`CLAUDE_CONFIG_DIR` 相容性**：未設 → `configDir = <home>/.claude`，trusted 閘與 `settings.ts` 路徑均與既有相同；
  設了 → 兩處一致改用該目錄。`settings.ts` 的 `~` 展開仍用 home（不受影響）。
- **`node:path/posix` 等價性**：對恆為絕對路徑的輸入，`basename`/`dirname` 與既有自實作等價；無分隔符/空字串分支
  不可達，且即便發生亦由 G5(b) `isWithin` 閘 fail-safe 回 `[]`。

### 6.1 信任邊界與威脅模型（純詞法靜態推導；刻意接受的擁有者決策）

trusted read root 的推導**純詞法靜態**：只對 hook 傳入的 `transcript_path`/`session_id` 與 env 解析出的
`osTmpBase`/`claudeConfigDir` 做字串推導，**完全不碰檔案系統**，**不做** realpath/stat/symlink/junction/UNC/共享
目錄檢查。這是本工具擁有者**刻意**的設計決策，與 `scope.ts` 全域不變量「路徑解析永不碰 FS」一致；引入 FS 檢查將
打破該核心不變量、且須一併套用到既有兩根，遠超本功能範圍。據此明示並**接受**下列殘留：

- **已詞法封堵**：`normalizeAbsolute` 折疊 `..`，故「`<sid>/../../../etc`」型目錄跳脫在比對前即被收斂出 trusted 根、
  不會放行。`deny`/`ask` 仍覆蓋 trusted（`deny > ask > allow`）。
- **信任 `os.tmpdir()`/`CLAUDE_CODE_TMPDIR` 與 Claude 生成目錄**：信任 hook 行程解析出的 tmp base 即 Claude 寫背景
  任務輸出的 base，且 `<configDir>/projects/<E>/<sid>/`、`<tmp>/claude[-uid]/<E>/<sid>/` 由 Claude Code 為**當前
  session** 建立、未被植入惡意 symlink/junction/hardlink。與信任 `cwd`/`tool_input`/`transcript_path`/`session_id`
  及既有已上線 feature 同一信任層級。
- **`TEMP`/`TMP`/`CLAUDE_CODE_TMPDIR`/`CLAUDE_CONFIG_DIR` 重導向為使用者自負風險（刻意）**：使用者若把這些 env 改指向
  非私有/共享/UNC 位置，trusted 根會隨之落在該處——屬使用者對自身系統環境的設定責任，本工具**不**加私有性/UNC 檢查
  防堵。對應 codex adversarial review 的「可寫 temp 詞法信任（symlink/junction）」與「env-redirected temp base」兩點，
  本設計依其自身建議的可接受替代路徑「明文宣告為刻意的信任擴張」處置，列為**已知且接受**的殘留風險。
- **跨來源 provenance 假設（明示接受）**：hook 由**當前 Claude 呼叫**為「這次 tool call」spawn 的子行程，故其
  行程 env（`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_TMPDIR`/`os.tmpdir()`、`Deno.uid()`、`Deno.build.os`）與 hook 輸入
  （`transcript_path`、`session_id`）**同源於當前 session**。tmp 根由 transcript 的 `<E>/<sid>`（session-keyed）授權、
  並落在當前行程 env 解析出的 base；本工具**不**另以 FS/process 檢查證明「該 tmp base 確實屬於 transcript 的 config
  root」——此「transcript 證明 → 跨 env 來源的 tmp 根」provenance 由 hook 執行模型保證，並作為**已知且接受**的信任
  假設（config/tmp env skew、偽造 transcript 屬使用者自負，與信任 `cwd`/`tool_input` 同層）。對應 codex review
  round-3「跨 root 授權」一點，即以此明示接受處置。
- **使用者若需更嚴**：可在 `permissions.deny` 以 `Bash(...)` 規則硬擋特定 trusted 子路徑（`deny` 先於放寬層）。

## 7. 測試計畫

- `src/claude_dir_test.ts`（改寫呼叫端為新簽名 `(…, claudeConfigDir, os, uid, osTmpBase)`）：
  - **Windows 形**：`os="windows"`、`uid=null`、`osTmpBase="C:\\Users\\u\\AppData\\Local\\Temp"`、
    `claudeConfigDir="C:/Users/u/.claude"` → 根含 `C:/Users/u/AppData/Local/Temp/claude/<E>/<sid>`（`claude`、無 uid）
    + projects session 根；每根 basename===sid。
  - **macOS 聯集**：`os="darwin"`、`uid=501`、`osTmpBase="/var/folders/x/T"` → tmp 根三個
    （`/var/folders/x/T/claude-501/<E>/<sid>`、`/tmp/claude-501/…`、`/private/tmp/claude-501/…`）+ projects session 根。
  - **Linux 去重**：`os="linux"`、`uid=501`、`osTmpBase="/tmp"` → 與 `/tmp` 相同 → tmp 根僅一個；
    `osTmpBase="/scratch"` → 兩個（`/scratch/claude-501/…` + `/tmp/claude-501/…`）。
  - **`CLAUDE_CODE_TMPDIR` 對齊**：`osTmpBase="/custom/tmp"`（POSIX）→ 根含 `/custom/tmp/claude-<uid>/<E>/<sid>`；
    Windows `osTmpBase="D:/scratch"` → `D:/scratch/claude/<E>/<sid>`（刻意行為、非 fail-closed）。
  - **`CLAUDE_CONFIG_DIR` 對齊**：`claudeConfigDir="/opt/cc"`、transcript=`/opt/cc/projects/<E>/<sid>.jsonl`
    → G5(b) 通過、session 根為 `/opt/cc/projects/<E>/<sid>`；transcript 在 `<home>/.claude/projects/...` 但
    `claudeConfigDir="/opt/cc"` → G5(b) 不符 → `[]`（fail-closed）。
  - **跨來源 provenance（刻意接受、文件化）**：`claudeConfigDir="/opt/cc"`、transcript 於其下、`osTmpBase="/unrelated/tmp"`
    → 仍同時產出 `/opt/cc/projects/<E>/<sid>` 與 `/unrelated/tmp/claude-<uid>/<E>/<sid>`；斷言此為設計刻意（不因 config/tmp
    來源不一致而 fail-closed），對齊 §6.1 provenance 假設。
  - `osTmpBase=null`/空白：Windows → 無 tmp 根（僅 projects session 根）；POSIX → 僅 `/tmp`(+darwin `/private/tmp`)。
  - `uid=null` 於 POSIX → 無 tmp 根；於 Windows → 不受影響。
  - **既有安全負向全保留**：大小寫敏感（`.JSONL`→`[]`）、trim、G5(a) basename 不符/`session_id` 缺失 → `[]`、
    `sid` 安全段（`"."`/`".."`/`"a/b"`/`"a.b"`/含 `\`/空白）→ `[]`、G5(b)（`<configDir>` 外、等於 projects 根）→ `[]`、
    非 `.jsonl`/相對/空/`undefined`/`claudeConfigDir===null` → `[]`。
  - **碰撞免疫**：兩 root（`/a/b` 與 `/a-b`）各自 session 之 trusted 根皆以自身 `<sid>` 結尾、互不涵蓋。
  - **`resolveClaudeConfigDir`**（同檔，單元測）：設 `CLAUDE_CONFIG_DIR` → 回正規化該值（忽略 home）；未設 →
    `<home>/.claude`；`home===null` 且未設 → `null`；空白 `CLAUDE_CONFIG_DIR` → 退回 home 推導。
- `src/permissions/settings_test.ts`（增補）：
  - `loadPermissionRules`：注入 `readText` + env，設 `CLAUDE_CONFIG_DIR=/opt/cc` → 讀 `/opt/cc/settings.json`（非 `<home>/.claude/settings.json`）；未設 → 仍讀 `<home>/.claude/settings.json`（相容）。
- `src/main_test.ts`（增補 e2e；子行程提供 `HOME`/`CLAUDE_PROJECT_DIR`、payload 含 `session_id`/`transcript_path`）：
  - **Windows 案**（`ignore: os !== "windows"`）：讀 `<os.tmpdir()>/claude/<E>/<sid>/tasks/x.output` → `allow`。
  - 保留既有 macOS `/private/tmp/claude-<uid>/<E>/<sid>/tasks/x.output` → `allow`（`ignore: os !== "darwin"`）。
  - **`CLAUDE_CONFIG_DIR` e2e**：設該 env 指向自訂目錄、transcript 置於其下 → 讀該 session `tool-results` → `allow`。
  - N4 回歸：`memory/`、他 `<sid2>` 子目錄、transcript `.jsonl` → `ask`。
- `src/engine/scope_test.ts`／`classify_test.ts`：trusted 機制未變，既有測試維持綠燈（必要時更新傳入根的字面）。
- `deno task check && lint && test` 全綠。

## 8. Operational verification（實作後必做）

`deno task build` 後餵真實 JSON 給 binary（環境含 `USERPROFILE`/`HOME`、`CLAUDE_PROJECT_DIR`、`TEMP`；payload 含
`session_id`/`transcript_path`）：

1. **Windows**：`transcript_path = C:/Users/<u>/.claude/projects/<E>/<sid>.jsonl`，
   讀 `tail -15 "/c/Users/<u>/AppData/Local/Temp/claude/<E>/<sid>/tasks/<id>.output"` → `allow`、`exit 0`
   （本規格起因案例：含 `| grep -v …` 管線亦 `allow`）。
2. 讀同 session `<configDir>/projects/<E>/<sid>/tool-results/<id>` → `allow`（對照組）。
3. `transcript_path` basename 與 `session_id` 不符 → `ask`（G5(a)）；指向 `<configDir>/projects/` 外 → `ask`（G5(b)）。
4. 設 `CLAUDE_CODE_TMPDIR=D:/scratch`、讀 `D:/scratch/claude/<E>/<sid>/tasks/<id>.output` → `allow`（對齊 env 覆寫）。
5. 設 `CLAUDE_CONFIG_DIR=D:/cc`、transcript 置於 `D:/cc/projects/<E>/<sid>.jsonl`、讀其下 `tool-results` → `allow`；
   且確認此時 `D:/cc/settings.json` 的 `permissions` 規則被 `loadPermissionRules` 讀入生效。
6. 讀同專案 `memory/` 或他 session `<E>/<sid2>/…` → `ask`（N4）。

## 9. 變更檔案清單

- 修改：
  - `src/claude_dir.ts`（移除 `posixBasename`/`posixDirname`，改 `node:path/posix`；簽名改
    `(claudeConfigDir, os, uid, osTmpBase)`；tmp 聯集推導 + 去重（純靜態、信任 osTmpBase）；精確變數命名；
    **新增 `resolveClaudeConfigDir(env, home)`**——依 domain 歸位於此檔）。
  - `src/main.ts`（`import { tmpdir }`/`resolveClaudeConfigDir`；讀 `Deno.build.os`/`Deno.uid()`/
    `CLAUDE_CODE_TMPDIR ?? tmpdir()`/`claudeConfigDir` 並傳入；移除 `includePrivateTmp` 計算）。
  - `src/permissions/settings.ts`（`import { resolveClaudeConfigDir } from "../claude_dir.ts"`；`loadPermissionRules`
    以 `resolveClaudeConfigDir(env, home)` 定位使用者 settings；不再自行定義該函式）。
  - `deno.json`（`build` task `--allow-env` 擴充 `CLAUDE_CONFIG_DIR,CLAUDE_CODE_TMPDIR,TMPDIR,TMP,TEMP,SystemRoot,windir`）。
- 測試增補：`src/claude_dir_test.ts`（新簽名 + Windows/聯集/去重/`CLAUDE_CODE_TMPDIR`/`CLAUDE_CONFIG_DIR` 案 +
  `resolveClaudeConfigDir` 單元測）、`src/permissions/settings_test.ts`（configDir-aware `loadPermissionRules` 載入）、
  `src/main_test.ts`（Windows + `CLAUDE_CONFIG_DIR` e2e）、必要時 `src/engine/scope_test.ts`/`classify_test.ts` 更新字面。
- 文件：`CLAUDE.md` 更新「當前 session trusted read roots」一節——納入反編譯證據對照表、`CLAUDE_CODE_TMPDIR ?? os.tmpdir()`
  跨 OS 聯集、`CLAUDE_CONFIG_DIR` 對齊（trusted 閘 + `settings.ts`）、`node:path/posix`、新 allow-env、§6.1 威脅模型。
