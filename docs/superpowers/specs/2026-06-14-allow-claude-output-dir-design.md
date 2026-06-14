# 設計規格：把當前 session 的 Claude Code 工具輸出目錄視為唯讀延伸範圍

- 日期：2026-06-14
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部
落在當前專案內」時回 `allow`，其餘回 `ask`；僅對「遞迴遍歷磁碟根/家目錄根的唯讀指令」回 `deny`。
路徑範圍判定集中在 `engine/scope.ts` 的 `isReadScoped`：專案根內 root-first 永遠視為 in-project；
專案外路徑才依 `deny → ask → allow`（allow 來自使用者 `Read/Edit/Write` 規則）決定是否放寬。

### 1.1 痛點

Claude Code 把「過大的工具/指令輸出」寫到兩處專案根外的目錄，agent 後續常需用 `cat`/`grep` 等
唯讀指令讀回，但目前一律被判 `ask`，造成每次都要人工確認的摩擦：

1. **工具輸出**：`~/.claude/projects/<encoded>/<session-id>/tool-results/<id>.txt`。
2. **背景任務輸出**：`/tmp/claude-<uid>/<encoded>/<session-id>/tasks/<id>.output`（macOS 上 `/tmp` 為
   `/private/tmp` 的 symlink）。

本功能把**當前 session** 在這兩處的子目錄視為延伸唯讀工作區，允許落在其下的純唯讀指令路徑被讀。
**信任邊界以全域唯一的 `session_id` 為鍵**（見 §1.3、§2.1），不以「整個專案 encoded 目錄」為鍵——
故對 `<encoded>` 段的編碼規則完全脫鉤、且不受編碼碰撞影響。

### 1.2 已查證的 Claude Code 事實

來源：官方文件 <https://code.claude.com/docs/en/hooks>（信心度：高）＋本機實證（信心度：中，POSIX/macOS）。

1. **`transcript_path` 是所有 hook 事件共通的必有輸入欄位**（Common Input Fields），於 stdin JSON 提供。
2. 其值為**絕對路徑**，格式 `~/.claude/projects/<encoded>/<session-id>.jsonl`，**副檔名 `.jsonl`**，
   **檔名（去副檔名）即等於 `session_id` 欄位值**（用於 §4.1 G5(a) session 綁定）。
3. PreToolUse top-level 欄位含：`session_id`、`transcript_path`、`cwd`、`permission_mode`、
   `hook_event_name`、`effort`、`tool_name`、`tool_input`，subagent 情境另含 `agent_id`/`agent_type`。
4. 文件未記載 `transcript_path` 會缺失的情況；跨互動式/headless/排程/subagent 皆存在。
5. **`~/.claude/projects/` 是文件化、穩定的存放根**；其下 `<encoded>` 段編碼規則官方未公開。
   本設計**不解碼、不重算 `<encoded>`**：需要該段時，直接取「已驗證 transcript 之 dirname 的 basename」E
   （即 Claude 對當前 session 所屬目錄的真實編碼段），純讀取、不猜測。
6. **背景任務輸出 base 為 `/tmp/claude-<uid>`**（macOS 實證；`/tmp`→`/private/tmp` symlink，指令可能用任一形式；
   `<uid>` 為數值 user id，實測等於 `id -u`，程式以 `Deno.uid()` 取得）。其下結構
   `claude-<uid>/<encoded>/<session-id>/tasks/...`，與 `~/.claude/projects/<encoded>/` **同一 `<encoded>`**。
   **此 base 非 `$TMPDIR`**（macOS `$TMPDIR` 為 `/var/folders/...`），且**官方未文件化**；本功能以 fail-safe 方式
   重建（base 猜錯/平台不符 → 不匹配 → 不放寬，絕不誤放行）。

### 1.3 本功能要改的事

把「當前 session 的工具/任務輸出子目錄」納入 `isReadScoped` 的 allow 區域：

- `~/.claude/projects/<E>/<session_id>/`（其下 `tool-results/` 等任意深度）。
- `/tmp/claude-<uid>/<E>/<session_id>/`（其下 `tasks/` 等任意深度；macOS 另含 `/private/tmp` 變體）。

其中 `E = basename(dirname(transcript_path))`、`session_id` 為 hook 輸入欄位。**只放寬「讀取位置」**，
不放寬任何寫入/執行偵測；放寬來源與「使用者 permission 規則」在型別上分離。

## 2. 目標與非目標

### 2.1 目標

- G1：**當前 session** 於上述兩處子目錄被視為唯讀可讀；落在其下的 allowlist 唯讀指令路徑判為 in-project。
  仍受 G3/G5/G6 與所有寫入偵測約束、且只放寬唯讀。
- G2：放寬來源（hook 自身推導的目錄）與使用者 `rules.readScope` **在資料結構上徹底分離**；`rules` 全程不被 mutate。
- G3：**trusted 放寬永不覆寫使用者的 Read `deny`/`ask`**。trusted 與 user-allow 同屬 `isReadScoped` 最低的
  「放寬」層，`deny`/`ask` 命中時先回 `false`，結果與「未啟用本功能」時完全相同（見 §6.1）。
- G4：fail-safe——對缺失/不合法輸入、或任一安全閘不符，一律退回現況（`ask`），絕不誤放行（誤 ask 可接受）。
- G5：**兩道 fail-closed 安全閘**（任一不過 → 不放寬，回 `[]`）：
  - **(a) session 綁定**：`basename(normalizeAbsolute(transcript_path))` 必須等於 `<session_id>.jsonl`。
    把推導錨定到**當前 session**；`session_id` 缺失/空白、或不相等 → 不放寬。
  - **(b) 位置綁定**：`dir = dirname(...)` 嚴格位於 `<home>/.claude/projects/` 之下且至少一個非空段
    （即 `<home>/.claude/projects/<E>`）；`home` 無解、或 `dir` 等於 `~/.claude/projects/` 本身 → 不放寬。
- G6：**信任邊界以 `session_id` 為鍵（碰撞免疫）**：所有 trusted 根都以 `.../<session_id>/` 結尾——
  `~/.claude/projects/<E>/<session_id>/` 與 `/tmp/claude-<uid>/<E>/<session_id>/`。因 `session_id` 為全域唯一 UUID，
  **即使 `<E>` 因 Claude 有損編碼而被兩專案共用，`<session_id>` 子樹仍唯一屬當前 session**。`/tmp` 根另需
  `Deno.uid()`（取不到 → 不產生該根）；`E` 取自已驗證 `dir` 的 basename（非重算編碼）。

### 2.2 非目標

- N1：**不放行其他 session / 其他專案**。信任邊界鍵為全域唯一 `session_id`：所有 trusted 根皆 `.../<session_id>/`，
  故他 session（含同專案歷史 session）、他專案一律不在範圍內。**因不使用任何有損編碼，無編碼碰撞殘留。**
  **殘留信任假設（明示）**：仍信任「Claude 送來的 `transcript_path`/`session_id`/`Deno.uid()` 屬於當前 session/
  使用者」——與既有信任 `cwd`/`tool_input` 同一信任層級。
- N2：不放寬任何寫入型重導向、賦值前綴、非唯讀指令偵測（與既有不變量一致）。
- N3：不改動「遞迴遍歷磁碟根/家目錄根 → deny」之硬性不變量。
- N4：**不自動放行** `~/.claude/projects/<E>/memory/`（專案層、跨 session）、`~/.claude/projects/<E>/` 下的
  **歷史 session 子目錄與其他 session 的 transcript**、以及當前 session 的 transcript `.jsonl` 檔本身。
  這些退回現況（`ask`，非封鎖）。理由：它們無法以 `session_id` 唯一鍵涵蓋，納入會重新引入「整個 encoded 目錄」
  的編碼碰撞跨專案風險。
- N5：不對推導出的目錄做存在性 I/O 檢查（純詞法，與 `scope.ts` 不碰 FS 的設計一致）。
- N6：**不修改既有的 `settingsAllows` 升級層行為**（`Bash(...)` allow 把 `ask` 升級為 `allow`）；見 §6.1。

## 3. 方案選擇

注入點採**方案 1**：在 `ScopeConfig` 新增獨立欄位 `trusted: string[]`，由 `main.ts` 組裝後以**獨立參數**
穿過 `evaluate`/`classify`，於 `isReadScoped` 的 allow 層比對。使用者規則與工具推導目錄型別分離。
（方案 2「併進 readScope.allow 複本」、方案 3「當 always-allowed root」分別因混淆來源、與 G3 衝突而否決。）

`trusted` 全部由「當前 session 推導」而來：先以 G5 兩閘驗證 transcript 屬當前 session 且位置正確，
再產出 `~/.claude` 與（若有 uid）`/tmp` 兩類 session 根。任一前置失敗 → `[]` → 行為等同現況（`ask`）。
**設計不含任何 `encode(root)` / 路徑重算編碼**；唯一用到的編碼段 `E` 來自已驗證 `dir` 的 basename（權威、純讀取）。

## 4. 詳細設計

### 4.1 新模組 `src/claude_dir.ts`（純函式、不碰 FS、不丟例外）

```ts
import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";

function posixBasename(absPosix: string): string;
function posixDirname(absPosix: string): string | null;  // 頂層 "/x" → "/"；無分隔符 → null

/**
 * 推導「當前 session 的 Claude Code 工具/任務輸出子目錄」清單（trusted read roots）。
 * 全部以 .../<session_id>/ 結尾（碰撞免疫）。G5 兩閘任一不過或前置缺失 → []（fail-safe）。
 */
export function sessionTrustedReadRoots(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  home: string | null,
  uid: number | null,           // main.ts 傳 Deno.uid()（try/catch，失敗 null）
  includePrivateTmp: boolean,   // main.ts 傳 Deno.build.os === "darwin"
): string[];
```

`sessionTrustedReadRoots` 行為（依序，任一前置失敗回 `[]`）：

1. `home === null`、`sessionId` 空白、`transcriptPath` 空白 → `[]`。
2. `sid = trim(sessionId)`；`t = trim(transcriptPath)`；`t` 非絕對（`isAbsolute`）→ `[]`；
   `toPosix(t)` 不以 `.jsonl` 結尾（**大小寫敏感**）→ `[]`。
3. `abs = normalizeAbsolute(t)`。**G5(a)**：`posixBasename(abs)` 不等於 `sid + ".jsonl"` → `[]`。
4. `dir = posixDirname(abs)`；`dir === null` → `[]`。
5. **G5(b)**：`projectsRoot = normalizeAbsolute(<home>/.claude/projects)`；
   `isWithin(projectsRoot, dir) === false` 或 `dir === projectsRoot` → `[]`。
6. `E = posixBasename(dir)`。`roots = [ normalizeAbsolute(dir + "/" + sid) ]`（~/.claude session 子目錄）。
7. 若 `uid !== null`：`bases = includePrivateTmp ? ["/tmp", "/private/tmp"] : ["/tmp"]`；
   對每個 `b` 推入 `normalizeAbsolute(b + "/claude-" + uid + "/" + E + "/" + sid)`（/tmp session 子目錄）。
8. 回傳 `roots`（1～3 個根，皆 `.../<sid>/`）。

異常案例（皆 fail-safe）：`~/.ssh/<sid>.jsonl`（不在 projects 下 → G5(b) 拒）、basename 與 `session_id` 不符
（G5(a) 拒）、`<home>/.claude/projects/<sid>.jsonl`（dir == projectsRoot → G5(b) 拒）；錯專案 transcript
`<other>/<sid>.jsonl` 即便過閘，其 `<other>/<sid>/` 也不含當前 session 真實資料（session 子樹由唯一 sid 界定）。

### 4.2 `engine/scope.ts`

- `ScopeConfig` 介面新增欄位 `trusted: string[]`（正規化絕對 POSIX 目錄根清單）。
- `rootScope(root)` helper 補 `trusted: []`（向後相容）。
- `isReadScoped(absPosix, scope)` 在現有 `allow` 比對「之後」新增 trusted 比對：

  ```text
  if (isWithin(scope.root, absPosix)) return true;   // root-first（不變）
  if (hits(scope.deny, absPosix)) return false;      // deny 否決（不變）
  if (hits(scope.ask, absPosix)) return false;       // ask 否決（不變）
  if (hits(scope.allow, absPosix)) return true;      // user allow（不變）
  if (scope.trusted.some((r) => isWithin(r, absPosix))) return true;  // trusted（新增，allow 同級）
  return false;
  ```

  優先序維持 `deny > ask > allow`；trusted 與 user-allow 同屬最低「放寬」層，deny/ask 必先否決（G3）。

### 4.3 穿線：`evaluate` / `classify`（新增獨立參數，`rules` 不變）

- `classify(inv, root, rules = EMPTY_RULES, home = null, trustedReadRoots: string[] = [])`：
  組 `ScopeConfig` 時 `trusted: trustedReadRoots`，其餘不變。
- `evaluate(command, root, initialCwd, rules = EMPTY_RULES, home = null, trustedReadRoots: string[] = [])`：
  原樣轉傳 `trustedReadRoots`。
- `combine` 不受影響。兩個新參數皆有預設 `[]`，既有呼叫端無需改動。

### 4.4 `hook/types.ts`、`main.ts` 與 build 權限

- `HookInput` 介面新增 `transcript_path?: string`（`session_id?` 既有）。
- `main.ts`（`home` 既有）組裝 `trustedReadRoots`，`rules` 完全不被 mutate：

  ```ts
  let uid: number | null = null;
  try { uid = Deno.uid(); } catch { uid = null; }  // 權限/平台失敗 → null → 不產生 /tmp 根
  const trusted = sessionTrustedReadRoots(
    input.transcript_path, input.session_id, home, uid, Deno.build.os === "darwin",
  );
  decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);
  ```

- **build/test 權限**：`deno.json` 的 `build` 與 `test` task 需新增 `--allow-sys=uid`（`Deno.uid()` 所需）。
  `Deno.uid()` 已包 try/catch，未授權亦 fail-safe 回 null（僅失去 `/tmp` 來源、不影響安全與 `~/.claude` 來源）。

## 5. 資料流

```text
stdin JSON ─▶ HookInput{ transcript_path?, session_id? }   home = homeDir(env)；uid = Deno.uid()|null
   trusted = sessionTrustedReadRoots(transcript_path, session_id, home, uid, os==='darwin')   (G5 兩閘 → [] 或 1~3 個 .../<sid>/ 根)
                                   ▼
        evaluate(…, rules, home, trusted) → classify(…, trusted)
        ScopeConfig{ root, home, allow, deny, ask, trusted }
        isReadScoped ── allow 層比對 trusted ──▶ in-project / out-of-project
```

`rules.readScope`（使用者規則）與 `trusted`（工具推導）為兩條獨立輸入，僅在 `ScopeConfig`
匯流為不同欄位，全程不交叉污染。

## 6. 錯誤處理與不變量

### 6.1 與既有 Bash-allow 升級層（`settingsAllows`）的關係（重要釐清）

`classify` 在 builtin 判 `ask` 時，會呼叫 `settingsAllows` 嘗試以 `permissions.allow` 的 `Bash(...)` 規則
升級為 `allow`（既有行為）。`settingsAllows` **只比對 `Bash(...)` pattern、不讀 `readScope`**。因此被使用者
`Read(...)` **deny** 的路徑，其指令在 builtin 判 `ask` 後**仍可能**被匹配的 `Bash(cmd:*)` allow 升級。

此性質**與本功能無關、為既有行為**，本功能**不改變任何被 deny 路徑的判定結果**：對被 deny/ask 命中的
trusted 子路徑，`isReadScoped` 先回 `false` → `ask`，後續是否被 Bash-allow 升級，與未啟用 trusted 時完全相同。
故 G3 精確表述為：**trusted 不覆寫 Read deny/ask**（「Read deny 硬擋一切 Bash 升級」是既有 `settingsAllows`
的獨立議題，屬 N6、不在本功能變更內）。要硬擋某 trusted 子路徑，使用者仍須一併在 `Bash(...)` 層 deny。

### 6.2 Fail-safe 與其他不變量

- **Fail-safe**：`sessionTrustedReadRoots` 純字串運算、不丟例外；`Deno.uid()` 於 `main.ts` 包 try/catch。任何
  不合法輸入、安全閘不過、uid 取不到、base 平台不符 → 該根不產生 → 至多 `trusted = []` → 行為等同現況（`ask`）。
  最外層 try/catch 與 `exit 0` 不變。
- **只放寬讀取位置**：寫入型重導向／賦值前綴／非唯讀指令偵測完全不動。
- **deny 硬性不變量**：trusted 目錄皆為深層子目錄（`.../<E>/<sid>`、`/tmp/claude-<uid>/<E>/<sid>`），
  永不等於磁碟根/home 根，`dangerousRoot` 不對它成立；對其遞迴掃描走一般唯讀放行、不觸發 deny。`classify`
  對 builtin `deny` 的短路邏輯不變。
- **跨 session/專案隔離（N1）**：信任鍵為唯一 `session_id`；無有損編碼 → 無碰撞殘留；殘留僅平台信任假設。

## 7. 測試計畫

- `src/claude_dir_test.ts`（新）：
  - 合法（`uid` 給定、`includePrivateTmp=true`）：回 `[ <home>/.claude/projects/<E>/<sid>,
    /tmp/claude-<uid>/<E>/<sid>, /private/tmp/claude-<uid>/<E>/<sid> ]`（皆以 `<sid>` 結尾，`E=basename(dir)`）。
  - `includePrivateTmp=false` → 不含 `/private/tmp` 根；`uid===null` → 僅 `~/.claude` 一根。
  - 大小寫**敏感**：大寫 `.JSONL` → `[]`；前後空白（transcript、sessionId）皆 `trim`。
  - **G5(a) 負向**：basename 與 `session_id` 不符 → `[]`；`session_id` 缺失/空白 → `[]`。
  - **G5(b) 負向**：`<home>/.ssh/<sid>.jsonl` → `[]`；`<home>/.claude/projects/<sid>.jsonl`（dir==projectsRoot）→ `[]`。
  - 非 `.jsonl`、相對、空、`undefined` transcript → `[]`；`home === null` → `[]`。
  - **碰撞免疫（reviewer 指定）**：兩 root `/a/b` 與 `/a-b` 之 session 各有不同 `sid`；斷言各自的 trusted 根
    皆以自身 `<sid>` 結尾、互不涵蓋（即使共用 `<E>=-a-b`，`isWithin` 不會讓 A 的指令命中 B 的 `<sid>` 子樹）。
  - 平台斷言以 `Deno.build.os` 區分（Windows `X:/`、Windows uid 取不到時僅 `~/.claude` 根，明示）。
- `src/engine/scope_test.ts`（增補）：trusted root 下回 true；trusted 與 user-allow 並存皆放行；
  deny/ask 命中時即使在 trusted 下仍 false（G3）；專案根內仍 root-first；`rootScope` 之 `trusted` 為 `[]`。
- `src/engine/classify_test.ts`（增補）：
  - 傳入 `trustedReadRoots`，`cat <trusted 下檔案>` → allow（涵蓋 `~/.claude` 與 `/tmp` 兩種根各一）。
  - **N4 回歸**：讀 `~/.claude/projects/<E>/memory/...`、他 session 子目錄、transcript `.jsonl` → **ask**（不在 trusted 內）。
  - **G3 回歸**：trusted 下但命中 user `Read(...)` deny、且無對應 `Bash(...)` allow → ask。
  - 未傳 `trustedReadRoots`（預設 `[]`）→ 同路徑 ask。
- `src/main_test.ts`（增補 e2e；子行程須提供 `HOME`、`CLAUDE_PROJECT_DIR`；payload 含 `session_id`；驗 `/tmp`
  根需 binary 有 `--allow-sys=uid`，否則該案標記為 macOS/權限相依）：
  - payload 帶合法 `transcript_path` + 相符 `session_id`，讀 `~/.claude/projects/<E>/<sid>/tool-results/<id>` → allow；
    不帶 `transcript_path` → ask；basename 與 `session_id` 不符 → ask（G5(a)）；在 `~/.claude/projects/` 外 → ask（G5(b)）。
  - 讀 `/tmp|/private/tmp/claude-<uid>/<E>/<sid>/tasks/<id>.output` → allow。
  - 讀同專案 `memory/` 或他 `<sid2>` 子目錄 → ask（N4）。
- 既有 341 測試與 `deny` 相關 e2e 全數維持綠燈。

## 8. Operational verification（實作後必做）

`deno task build` 後餵真實 JSON 給 binary（環境含 `HOME`/`USERPROFILE`、`CLAUDE_PROJECT_DIR`；payload 含 `session_id`）：

1. 帶合法 `transcript_path`（`~/.claude/projects/<E>/<session_id>.jsonl`）讀 `<E>/<session_id>/tool-results/<id>` → `allow`、`exit 0`。
2. 讀 `/private/tmp/claude-<uid>/<E>/<session_id>/tasks/<id>.output` 與 `/tmp/...` 兩形式 → `allow`。
3. 讀同專案 `~/.claude/projects/<E>/memory/...` 或他 session `<E>/<sid2>/...` → `ask`（N4）。
4. `transcript_path` basename 與 `session_id` 不符 → `ask`（G5(a)）；指向 `~/.claude/projects/` 外 → `ask`（G5(b)）。
5. 不帶 `transcript_path` 的家目錄路徑、未被任何 `Read()` allow 宣告 → 仍 `ask`。

## 9. 變更檔案清單

- 新增：`src/claude_dir.ts`、`src/claude_dir_test.ts`。
- 修改：`src/engine/scope.ts`（`ScopeConfig.trusted`、`rootScope`、`isReadScoped`）、
  `src/engine/classify.ts`（新參數 + 組 scope）、`src/engine/evaluate.ts`（新參數轉傳）、
  `src/hook/types.ts`（`transcript_path?`）、`src/main.ts`（組裝 session trusted、`Deno.uid()` try/catch）、
  `deno.json`（`build`/`test` task 加 `--allow-sys=uid`）。
- 測試增補：`src/engine/scope_test.ts`、`src/engine/classify_test.ts`、`src/main_test.ts`。
- 文件：`CLAUDE.md` 補一節說明此放寬來源、以 `session_id` 為鍵的兩道安全閘與 `/tmp` 重建（uid + 權威段 E）、
  刻意**不**含 memory/歷史 session（N4）、優先序（含 §6.1）、殘留平台信任假設、`--allow-sys=uid` 權限與
  「不混入使用者規則」之設計。
