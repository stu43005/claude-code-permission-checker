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
5. `<encoded>` 段的編碼方式**官方未公開**。本設計**不解碼**該段（見 §4），故與編碼規則完全脫鉤。

### 1.3 本功能要改的事

把「當前專案的 Claude Code 工具輸出目錄」（`dirname(transcript_path)` ＝ `~/.claude/projects/<encoded>/`）
納入 `isReadScoped` 的 allow 區域，使落在其下的**純唯讀指令路徑**被視為可讀。
**只放寬「讀取位置」**，不放寬任何寫入/執行偵測；且此放寬來源與「使用者 permission 規則」在型別上分離。

## 2. 目標與非目標

### 2.1 目標

- G1：當前專案的 `~/.claude/projects/<encoded>/` 目錄（含其下 `tool-results/`、transcript `.jsonl`、
  `memory/` 等任意深度子路徑）被視為唯讀可讀；落在其下的 allowlist 唯讀指令路徑判為 in-project。
- G2：放寬來源（hook 自身推導的目錄）與使用者 `rules.readScope` **在資料結構上徹底分離**；`rules` 全程不被 mutate。
- G3：優先序「可被 deny 覆蓋」——使用者 `permissions.deny`/`ask` 的 `Read(...)` 規則仍能否決此放寬
  （`deny > ask > allow`，trusted 與 user-allow 同級）。
- G4：跨平台正確（不依賴猜測 `<encoded>` 編碼），且對缺失/不合法輸入 fail-safe 退回現況（`ask`）。

### 2.2 非目標

- N1：**不放行其他專案**的 `~/.claude/projects/*`（least-privilege，只認本 session 的 transcript dirname）。
- N2：不放寬任何寫入型重導向、賦值前綴、非唯讀指令偵測（與既有不變量一致）。
- N3：不改動「遞迴遍歷磁碟根/家目錄根 → deny」之硬性不變量。
- N4：不依賴 `home`/`USERPROFILE` 或 `CLAUDE_PROJECT_DIR` 來重建編碼路徑（已選定「僅用 transcript_path」）。
- N5：不對 `transcript_path` 指向的檔案做存在性 I/O 檢查（純詞法推導，與 `scope.ts` 不碰 FS 的設計一致）。

## 3. 方案選擇

評估三種注入點方案（詳見決策紀錄），採**方案 1**：

- **方案 1（採用）**：在 `ScopeConfig` 新增獨立欄位 `trusted: string[]`，由 `main.ts` 推導後以**獨立參數**
  穿過 `evaluate`/`classify`，於 `isReadScoped` 的 allow 層比對。語義最清晰，使用者規則與工具推導目錄型別分離。
- 方案 2（否決）：在 classify 邊界把目錄併進 `readScope.allow` 的複本。雖不 mutate 原物件，但把兩種來源
  在資料上混為一談，reason/debug 難區分來源，違背「不插入該列表」的精神。
- 方案 3（否決）：當成與專案根同級的 always-allowed root（root-first、不可 deny 覆蓋）。與 G3 衝突。

推導來源採**僅用 `transcript_path`**（不加 home 編碼 fallback）：避免猜測 Claude Code 內部編碼規則，
跨平台正確；缺欄位時不放寬（退回 `ask`）。

## 4. 詳細設計

### 4.1 新模組 `src/claude_dir.ts`（純函式、不碰 FS、不丟例外）

```ts
import { isAbsolute, normalizeAbsolute, toPosix } from "./engine/scope.ts";

/** 已正規化絕對 POSIX 路徑的 dirname；頂層（如 "/x"）→ "/"；無分隔符 → null。 */
function posixDirname(absPosix: string): string | null;

/**
 * 由 hook 傳入的 transcript_path 推導「當前專案的 Claude Code 工具輸出目錄」
 * （~/.claude/projects/<encoded>/）。只取 dirname、不解碼 <encoded>。
 * 僅信任「絕對且 .jsonl 結尾」者；缺失/空白/非絕對/非 .jsonl → null（不放寬）。
 * 回傳已 normalizeAbsolute 的絕對 POSIX 目錄。
 */
export function claudeProjectOutputDir(transcriptPath: string | undefined): string | null;
```

行為規格：

1. `transcriptPath` 為 `undefined`／空字串／僅空白 → `null`。
2. `trim()` 後若非絕對路徑（`isAbsolute` 判定，含 POSIX `/`、Windows `X:/`、UNC `//`）→ `null`。
3. `toPosix(trim).toLowerCase()` 不以 `.jsonl` 結尾 → `null`。
4. 否則回傳 `posixDirname(normalizeAbsolute(trim))`；若 dirname 為 `null`（理論上不會，因已是絕對路徑）→ `null`。

驗證強度＝**最小驗證（絕對 + `.jsonl`）**：`transcript_path` 與 `cwd` 同為 harness 經 stdin 提供的可信輸入，
信任層級一致；不額外要求路徑含 `/.claude/projects/` 段，以免耦合 Claude Code 內部目錄佈局（未來可能變）。

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
- `main.ts` 在計算 `decision` 前：

  ```ts
  const claudeDir = claudeProjectOutputDir(input.transcript_path);
  const trustedReadRoots = claudeDir === null ? [] : [claudeDir];
  decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trustedReadRoots);
  ```

  `rules`（`loadPermissionRules` 之結果）**完全不被 mutate**。

## 5. 資料流

```
stdin JSON ──parseHookInput──▶ HookInput{ transcript_path? }
                                   │
                  claudeProjectOutputDir(transcript_path) ──▶ string|null
                                   │ (filter null)
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

- **Fail-safe**：`claudeProjectOutputDir` 純字串運算、不丟例外；任何不合法輸入 → `null` → `trustedReadRoots = []`
  → `isReadScoped` 行為等同現況（該外部路徑判 `ask`）。最外層 `evaluate`/`main` 的 try/catch 與 `exit 0` 不變。
- **只放寬讀取位置**：寫入型重導向／賦值前綴／非唯讀指令偵測完全不動（中央前置規則與個別 rule 不變）。
- **deny 硬性不變量**：trusted 目錄是 home 的子目錄，永不等於磁碟根/home 根，故 `dangerousRoot` 不會對它成立；
  對 trusted 目錄的遞迴掃描（如 `grep -r <dir>`）走一般唯讀放行、不觸發 deny（與現有 `find ~/.claude` 不 deny 一致）。
  trusted 放寬只影響 allow 層，`classify` 對 builtin `deny` 的短路、不經升級層之邏輯不變。
- **跨專案隔離（N1）**：只放行 `dirname(transcript_path)`＝本 session 的專案目錄；其他專案目錄不在 trusted 內。

## 7. 測試計畫

- `src/claude_dir_test.ts`（新）：
  - 合法絕對 `.jsonl` → 回 dirname（含巢狀路徑、Windows `X:/...jsonl` 於對應平台）。
  - 大小寫：`.JSONL` 結尾亦接受（以 `toLowerCase` 比對）。
  - 前後空白被 `trim`。
  - 非 `.jsonl`（如 `.txt`）、相對路徑、空字串、`undefined` → `null`。
- `src/engine/scope_test.ts`（增補）：
  - `isReadScoped`：trusted root 下路徑回 true；trusted 與 user-allow 並存時皆放行。
  - deny/ask 命中時即使在 trusted 下仍回 false（優先序）。
  - 專案根內路徑不受 trusted 影響仍 root-first true。
  - `rootScope` 產生的 config `trusted` 為 `[]`。
- `src/engine/classify_test.ts`（增補）：
  - 傳入 `trustedReadRoots`，`cat <trusted 下檔案>` → allow。
  - trusted 下但命中 user deny `Read(...)` → ask。
  - 未傳 `trustedReadRoots`（預設 `[]`）→ 同路徑 ask（回歸）。
- `src/main_test.ts`（增補 e2e 子行程）：
  - payload 帶 `transcript_path`（合法 `.jsonl`）、指令讀其 dirname 下 `tool-results` 檔 → allow。
  - 同指令但 payload 不帶 `transcript_path` → ask（佐證放寬確由 transcript_path 啟用）。
- 既有 341 測試與 `deny` 相關 e2e 全數維持綠燈。

## 8. Operational verification（實作後必做）

`deno task build` 後餵真實 JSON 給 binary，至少驗證：

1. 帶 `transcript_path` 讀工具輸出檔 → `allow`、`exit 0`。
2. 不帶 `transcript_path` 同路徑 → `ask`。
3. 讀「別的專案」`~/.claude/projects/<other>/...` → `ask`（跨專案隔離）。
4. 對 trusted 目錄外、且未被任何 `Read()` allow 宣告的家目錄路徑 → 仍 `ask`（未過度放寬）。

## 9. 變更檔案清單

- 新增：`src/claude_dir.ts`、`src/claude_dir_test.ts`。
- 修改：`src/engine/scope.ts`（`ScopeConfig.trusted`、`rootScope`、`isReadScoped`）、
  `src/engine/classify.ts`（新參數 + 組 scope）、`src/engine/evaluate.ts`（新參數轉傳）、
  `src/hook/types.ts`（`transcript_path?`）、`src/main.ts`（推導並傳入）。
- 測試增補：`src/engine/scope_test.ts`、`src/engine/classify_test.ts`、`src/main_test.ts`。
- 文件：`CLAUDE.md` 補一節說明此放寬來源、優先序與「不混入使用者規則」之設計。
