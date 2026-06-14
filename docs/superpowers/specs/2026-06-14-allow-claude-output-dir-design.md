# 設計規格：把當前專案的 Claude Code 工具輸出目錄視為唯讀延伸範圍

- 日期：2026-06-14
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部
落在當前專案內」時回 `allow`，其餘回 `ask`；僅對「遞迴遍歷磁碟根/家目錄根的唯讀指令」回 `deny`。
路徑範圍判定集中在 `engine/scope.ts` 的 `isReadScoped`：專案根內 root-first 永遠視為 in-project；
專案外路徑才依 `deny → ask → allow`（allow 來自使用者 `Read/Edit/Write` 規則）決定是否放寬。

### 1.1 痛點

Claude Code 在工具輸出過大時，會把完整輸出寫進檔案，路徑形如：

```
~/.claude/projects/<encoded-project-path>/<session-id>/tool-results/<id>.txt
```

agent 後續常需要用 `cat`/`grep` 等唯讀指令讀回這些輸出檔。但該目錄位於**使用者家目錄下、專案根外**，
故目前 `isReadScoped` 判為 out-of-project → 唯讀指令被判 `ask`，每次讀工具輸出都要人工確認，造成摩擦。

同一目錄下還有 transcript（`<session-id>.jsonl`）與 `memory/` 等，皆為當前專案的工作衍生物，
概念上應視為「專案的延伸工作區」而允許唯讀存取。

### 1.2 已查證的 Claude Code 事實（官方文件）

來源：<https://code.claude.com/docs/en/hooks>（信心度：高）。

1. **`transcript_path` 是所有 hook 事件共通的必有輸入欄位**（Common Input Fields），於 stdin JSON 提供。
2. 其值為**絕對路徑**，指向當前 session 的對話檔，格式 `~/.claude/projects/<encoded>/<session-id>.jsonl`，
   **副檔名為 `.jsonl`**。
3. PreToolUse top-level 欄位含：`session_id`、`transcript_path`、`cwd`、`permission_mode`、
   `hook_event_name`、`effort`、`tool_name`、`tool_input`，以及 subagent 情境下的 `agent_id`/`agent_type`。
4. 文件未記載 `transcript_path` 會缺失的情況；跨互動式/headless/排程/subagent 皆存在。
5. **`~/.claude/projects/` 是文件化、穩定的存放根**；其下 `<encoded>` 段的編碼方式**官方未公開**。
   本設計**不解碼** `<encoded>` 段；僅把「推導出的目錄是否落在 `~/.claude/projects/` 之下」當作安全閘
   （見 §4.1）——耦合的只有穩定的 `~/.claude/projects/` 前綴，不耦合易變的編碼規則。

### 1.3 本功能要改的事

把「當前專案的 Claude Code 工具輸出目錄」（`dirname(transcript_path)`，且經驗證確實位於
`<home>/.claude/projects/<encoded>/`）納入 `isReadScoped` 的 allow 區域，使落在其下的**純唯讀指令路徑**
被視為可讀。**只放寬「讀取位置」**，不放寬任何寫入/執行偵測；且此放寬來源與「使用者 permission 規則」
在型別上分離。

## 2. 目標與非目標

### 2.1 目標

- G1：當前專案的 `~/.claude/projects/<encoded>/` 目錄（含其下 `tool-results/`、transcript `.jsonl`、
  `memory/` 等任意深度子路徑）被視為唯讀可讀；落在其下的 allowlist 唯讀指令路徑判為 in-project。
- G2：放寬來源（hook 自身推導的目錄）與使用者 `rules.readScope` **在資料結構上徹底分離**；`rules` 全程不被 mutate。
- G3：**trusted 放寬永不覆寫使用者的 Read `deny`/`ask`**。trusted 與 user-allow 同屬 `isReadScoped` 最低的
  「放寬」層，故 `deny`/`ask` 命中時 `isReadScoped` 一律先回 `false`：被 deny/ask 命中的 trusted 子路徑
  **被排除於放寬之外**，其判定結果與「未啟用本功能」時**完全相同**（見 §6.1 對既有 Bash-allow 升級層的釐清）。
- G4：跨平台正確（推導不依賴猜測 `<encoded>` 編碼），且對缺失/不合法輸入 fail-safe 退回現況（`ask`）。
- G5：**安全閘**——只有當推導目錄經驗證**嚴格位於 `<home>/.claude/projects/` 之下且其下至少有一個非空段**
  （即 `<home>/.claude/projects/<encoded>`）時才放寬；`home` 無法解析、或推導目錄等於 `~/.claude/projects/`
  本身/家目錄/磁碟根/任意較廣父目錄時，一律不放寬（回 `null`）。

### 2.2 非目標

- N1：**不放行其他專案**的 `~/.claude/projects/*`（least-privilege，只認本 session 的 transcript dirname）。
- N2：不放寬任何寫入型重導向、賦值前綴、非唯讀指令偵測（與既有不變量一致）。
- N3：不改動「遞迴遍歷磁碟根/家目錄根 → deny」之硬性不變量。
- N4：不**解碼** `<encoded>` 段、不由 `home`+編碼重建目錄。`home` 僅用於 G5 安全閘比對，**不**參與目錄推導。
- N5：不對 `transcript_path` 指向的檔案做存在性 I/O 檢查（純詞法推導，與 `scope.ts` 不碰 FS 的設計一致）。
- N6：**不修改既有的 `settingsAllows` 升級層行為**（`Bash(...)` allow 把 `ask` 升級為 `allow` 的既有語意）。
  本功能不擴張、也不收窄該層；見 §6.1。

## 3. 方案選擇

評估三種注入點方案（詳見決策紀錄），採**方案 1**：

- **方案 1（採用）**：在 `ScopeConfig` 新增獨立欄位 `trusted: string[]`，由 `main.ts` 推導後以**獨立參數**
  穿過 `evaluate`/`classify`，於 `isReadScoped` 的 allow 層比對。語義最清晰，使用者規則與工具推導目錄型別分離。
- 方案 2（否決）：在 classify 邊界把目錄併進 `readScope.allow` 的複本。雖不 mutate 原物件，但把兩種來源
  在資料上混為一談，reason/debug 難區分來源，違背「不插入該列表」的精神。
- 方案 3（否決）：當成與專案根同級的 always-allowed root（root-first、不可 deny 覆蓋）。與 G3 衝突。

推導來源採**僅用 `transcript_path` 的 dirname**（不由 `home`+編碼重建目錄，避免猜測 Claude Code 編碼規則）；
`home` 僅作為 G5 安全閘的比對基準。缺欄位/驗證不過時不放寬（退回 `ask`）。

## 4. 詳細設計

### 4.1 新模組 `src/claude_dir.ts`（純函式、不碰 FS、不丟例外）

```ts
import { isAbsolute, isWithin, normalizeAbsolute, toPosix } from "./engine/scope.ts";

/** 已正規化絕對 POSIX 路徑的 dirname；頂層（如 "/x"）→ "/"；無分隔符 → null。 */
function posixDirname(absPosix: string): string | null;

/**
 * 由 hook 傳入的 transcript_path 推導「當前專案的 Claude Code 工具輸出目錄」
 * （~/.claude/projects/<encoded>/）。只取 dirname、不解碼 <encoded>。
 * 安全閘：推導目錄須嚴格位於 <home>/.claude/projects/ 之下且其下至少一個非空段。
 * home 無法解析、transcript 缺失/空白/非絕對/非 .jsonl、或未通過安全閘 → null（不放寬）。
 * 回傳已 normalizeAbsolute 的絕對 POSIX 目錄。
 */
export function claudeProjectOutputDir(
  transcriptPath: string | undefined,
  home: string | null,
): string | null;
```

行為規格（依序）：

1. `home === null` → `null`（無從套用 G5 安全閘）。
2. `transcriptPath` 為 `undefined`／空字串／僅空白 → `null`。
3. `trim()` 後若非絕對路徑（`isAbsolute`，含 POSIX `/`、Windows `X:/`、UNC `//`）→ `null`。
4. `toPosix(trim).toLowerCase()` 不以 `.jsonl` 結尾 → `null`。
5. `dir = posixDirname(normalizeAbsolute(trim))`；`dir === null` → `null`。
6. **G5 安全閘**：令 `projectsRoot = normalizeAbsolute(<home>/.claude/projects)`。
   要求 `isWithin(projectsRoot, dir) === true` **且** `dir !== projectsRoot`（即嚴格在其下、至少一段非空編碼段）。
   不滿足 → `null`。
7. 回傳 `dir`。

說明：正常情況 `dir` 恰為 `projectsRoot/<encoded>`（剛好低一段），通過閘門。攻擊/異常情況如
`/Users/alice/.ssh/session.jsonl`（`dir = /Users/alice/.ssh`）不在 `projectsRoot` 下 → 拒絕；
`~/.claude/projects/x.jsonl`（`dir = ~/.claude/projects` 本身）→ 等於 `projectsRoot` → 拒絕（無編碼段）。

### 4.2 `engine/scope.ts`

- `ScopeConfig` 介面新增欄位：`trusted: string[]`（正規化絕對 POSIX 目錄根清單）。
- `rootScope(root)` helper 補 `trusted: []`（向後相容既有測試與不需此功能的呼叫端）。
- `isReadScoped(absPosix, scope)` 在現有 `allow` 比對「之後」新增 trusted 比對：

  ```
  if (isWithin(scope.root, absPosix)) return true;   // root-first（不變）
  if (hits(scope.deny, absPosix)) return false;      // deny 否決（不變）
  if (hits(scope.ask, absPosix)) return false;       // ask 否決（不變）
  if (hits(scope.allow, absPosix)) return true;      // user allow（不變）
  if (scope.trusted.some((r) => isWithin(r, absPosix))) return true;  // trusted（新增，allow 同級）
  return false;
  ```

  優先序維持 `deny > ask > allow`；trusted 與 user-allow 同屬最低的「放寬」層，故 deny/ask 必定先否決（G3）。

### 4.3 穿線：`evaluate` / `classify`（新增獨立參數，`rules` 不變）

- `classify(inv, root, rules = EMPTY_RULES, home = null, trustedReadRoots: string[] = [])`：
  組 `ScopeConfig` 時 `trusted: trustedReadRoots`，其餘不變。
- `evaluate(command, root, initialCwd, rules = EMPTY_RULES, home = null, trustedReadRoots: string[] = [])`：
  原樣轉傳 `trustedReadRoots` 給每次 `classify` 呼叫。
- `combine` 不受影響。
- 兩個新參數皆有預設 `[]`，既有呼叫端（測試）無需改動。

### 4.4 `hook/types.ts` 與 `main.ts`

- `HookInput` 介面新增 `transcript_path?: string`。
- `main.ts` 在計算 `decision` 前（`home` 已由既有 `homeDir(Deno.env)` 取得）：

  ```ts
  const claudeDir = claudeProjectOutputDir(input.transcript_path, home);
  const trustedReadRoots = claudeDir === null ? [] : [claudeDir];
  decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trustedReadRoots);
  ```

  `rules`（`loadPermissionRules` 之結果）**完全不被 mutate**。

## 5. 資料流

```
stdin JSON ──parseHookInput──▶ HookInput{ transcript_path? }
                                   │           home = homeDir(env)
                  claudeProjectOutputDir(transcript_path, home) ──▶ string|null
                                   │ (G5 安全閘；filter null)
                                   ▼
main.ts: trustedReadRoots: string[]
                                   │
        evaluate(…, rules, home, trustedReadRoots)
                                   │
        classify(…, rules, home, trustedReadRoots)
                                   │
        ScopeConfig{ root, home, allow, deny, ask, trusted: trustedReadRoots }
                                   │
        isReadScoped ── allow 層比對 trusted ──▶ in-project / out-of-project
```

`rules.readScope`（使用者規則）與 `trustedReadRoots`（工具推導）為兩條獨立輸入，僅在 `ScopeConfig`
匯流為不同欄位，全程不交叉污染。

## 6. 錯誤處理與不變量

### 6.1 與既有 Bash-allow 升級層（`settingsAllows`）的關係（重要釐清）

`classify` 在 builtin 判 `ask` 時，會呼叫 `settingsAllows` 嘗試以 `permissions.allow` 的 `Bash(...)` 規則
升級為 `allow`（既有行為，見 `matcher.ts`）。`settingsAllows` **只比對 `Bash(...)` pattern、不讀 `readScope`**。
因此一個被使用者 `Read(...)` **deny** 的路徑，其指令在 builtin 判 `ask` 後，**仍可能**被一條匹配的
`Bash(cmd:*)` allow 規則升級為 `allow`。

此性質**與本功能無關、為既有行為**，且本功能**不改變任何被 deny 路徑的判定結果**：

- 對「被 Read deny/ask 命中」的 trusted 子路徑：`isReadScoped` 因 deny/ask 先回 `false` → out-of-project → `ask`，
  接著是否被 `Bash(...)` allow 升級，**與未啟用 trusted 時完全相同**。trusted 在此情境下不參與、不放行（G3）。
- 換言之，trusted 只在「**未**被任何 deny/ask 命中」時才把路徑視為 in-project；它**從不**把已被 deny 的路徑改回 allow。

故 G3 的保證精確表述為：**trusted 不覆寫 Read deny/ask**（不是「Read deny 能硬擋一切 Bash 升級」——後者是
既有 `settingsAllows` 的獨立議題，屬 N6 範圍、不在本功能變更內）。要對某 trusted 子路徑「硬擋」，使用者
仍須一併在 `Bash(...)` 層 deny（與既有所有外部路徑一致）。

### 6.2 Fail-safe 與其他不變量

- **Fail-safe**：`claudeProjectOutputDir` 純字串運算、不丟例外；任何不合法輸入或未過安全閘 → `null`
  → `trustedReadRoots = []` → `isReadScoped` 行為等同現況（該外部路徑判 `ask`）。最外層 `evaluate`/`main`
  的 try/catch 與 `exit 0` 不變。
- **只放寬讀取位置**：寫入型重導向／賦值前綴／非唯讀指令偵測完全不動。
- **deny 硬性不變量**：trusted 目錄是 home 的子目錄（且嚴格在 `~/.claude/projects/` 下），永不等於磁碟根/home 根，
  故 `dangerousRoot` 不會對它成立；對 trusted 目錄的遞迴掃描（如 `grep -r <dir>`）走一般唯讀放行、不觸發 deny
  （與現有 `find ~/.claude` 不 deny 一致）。`classify` 對 builtin `deny` 的短路、不經升級層之邏輯不變。
- **跨專案隔離（N1）**：只放行 `dirname(transcript_path)`＝本 session 的專案目錄；其他專案目錄不在 trusted 內。

## 7. 測試計畫

- `src/claude_dir_test.ts`（新）：
  - 合法絕對 `.jsonl` 且在 `<home>/.claude/projects/<encoded>/` 下 → 回 dirname（含巢狀 session 子路徑）。
  - 大小寫：`.JSONL` 結尾亦接受（以 `toLowerCase` 比對）。
  - 前後空白被 `trim`。
  - **安全閘負向**：`<home>/.ssh/x.jsonl`（不在 projects 下）→ `null`；`<home>/.claude/projects/x.jsonl`
    （dir 等於 projectsRoot，無編碼段）→ `null`；完全在 projects 外的絕對 `.jsonl` → `null`。
  - 非 `.jsonl`（如 `.txt`）、相對路徑、空字串、`undefined` → `null`。
  - `home === null` → `null`（即使 transcript 合法）。
  - 平台相關斷言以 `Deno.build.os` 區分（Windows `X:/` 寫法另測）。
- `src/engine/scope_test.ts`（增補）：
  - `isReadScoped`：trusted root 下路徑回 true；trusted 與 user-allow 並存時皆放行。
  - deny/ask 命中時即使在 trusted 下仍回 false（優先序；對應 G3）。
  - 專案根內路徑不受 trusted 影響仍 root-first true。
  - `rootScope` 產生的 config `trusted` 為 `[]`。
- `src/engine/classify_test.ts`（增補）：
  - 傳入 `trustedReadRoots`，`cat <trusted 下檔案>` → allow。
  - **G3 回歸**：trusted 下但命中 user `Read(...)` deny 的路徑、且**無**對應 `Bash(...)` allow → ask
    （trusted 不覆寫 Read deny）。
  - 未傳 `trustedReadRoots`（預設 `[]`）→ 同路徑 ask（回歸）。
- `src/main_test.ts`（增補 e2e 子行程；注意子行程環境須提供 `HOME` 才能過 G5 安全閘）：
  - payload 帶 `transcript_path`（合法 `.jsonl`，位於 `$HOME/.claude/projects/<encoded>/`）、指令讀其 dirname
    下 `tool-results` 檔 → allow。
  - 同指令但 payload 不帶 `transcript_path` → ask（佐證放寬確由 transcript_path 啟用）。
  - payload 帶「在 `~/.claude/projects/` 外」的絕對 `.jsonl`（如 `$HOME/.ssh/x.jsonl`）、讀其 dirname 下檔案
    → ask（安全閘負向）。
- 既有 341 測試與 `deny` 相關 e2e 全數維持綠燈。

## 8. Operational verification（實作後必做）

`deno task build` 後餵真實 JSON 給 binary（環境須含 `HOME`/`USERPROFILE` 以過安全閘），至少驗證：

1. 帶合法 `transcript_path`（在 `~/.claude/projects/<encoded>/`）讀工具輸出檔 → `allow`、`exit 0`。
2. 不帶 `transcript_path` 同路徑 → `ask`。
3. 讀「別的專案」`~/.claude/projects/<other>/...` → `ask`（跨專案隔離）。
4. `transcript_path` 指向 `~/.claude/projects/` 外（如 `~/.ssh/x.jsonl`）、讀其 dirname 下檔案 → `ask`（安全閘）。
5. trusted 目錄外、且未被任何 `Read()` allow 宣告的家目錄路徑 → 仍 `ask`（未過度放寬）。

## 9. 變更檔案清單

- 新增：`src/claude_dir.ts`、`src/claude_dir_test.ts`。
- 修改：`src/engine/scope.ts`（`ScopeConfig.trusted`、`rootScope`、`isReadScoped`）、
  `src/engine/classify.ts`（新參數 + 組 scope）、`src/engine/evaluate.ts`（新參數轉傳）、
  `src/hook/types.ts`（`transcript_path?`）、`src/main.ts`（推導並傳入，含 `home`）。
- 測試增補：`src/engine/scope_test.ts`、`src/engine/classify_test.ts`、`src/main_test.ts`。
- 文件：`CLAUDE.md` 補一節說明此放寬來源、安全閘、優先序（含 §6.1 與既有 Bash-allow 升級層的關係）
  與「不混入使用者規則」之設計。
