# 設計規格：把當前專案的 Claude Code 工具輸出目錄視為唯讀延伸範圍

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

1. **工具輸出**：`~/.claude/projects/<encoded>/<session-id>/tool-results/<id>.txt`。同一專案目錄
   `~/.claude/projects/<encoded>/` 下還有各 session 的 transcript（`<session-id>.jsonl`）與 `memory/`。
2. **背景任務輸出**：`/tmp/claude-<uid>/<encoded>/<session-id>/tasks/<id>.output`（macOS 上 `/tmp` 為
   `/private/tmp` 的 symlink）。

本功能**刻意**把「當前專案」在這兩處的目錄視為延伸唯讀工作區（範圍見 §2.1），允許落在其下的純唯讀
指令路徑被讀。`<encoded>` 兩處用同一套編碼（§1.2.6）。

### 1.2 已查證的 Claude Code 事實

來源：官方文件 <https://code.claude.com/docs/en/hooks>（信心度：高）＋本機實證逆向（信心度：中，POSIX/macOS）。

1. **`transcript_path` 是所有 hook 事件共通的必有輸入欄位**（Common Input Fields），於 stdin JSON 提供。
2. 其值為**絕對路徑**，格式 `~/.claude/projects/<encoded>/<session-id>.jsonl`，**副檔名 `.jsonl`**，
   **檔名（去副檔名）即等於 `session_id` 欄位值**（用於 §4.1 G5(a)）。
3. PreToolUse top-level 欄位含：`session_id`、`transcript_path`、`cwd`、`permission_mode`、
   `hook_event_name`、`effort`、`tool_name`、`tool_input`，subagent 情境另含 `agent_id`/`agent_type`。
4. 文件未記載 `transcript_path` 會缺失的情況；跨互動式/headless/排程/subagent 皆存在。
5. **`~/.claude/projects/` 是文件化、穩定的存放根**。
6. **`<encoded>` 段編碼規則官方未公開**；經本機對 8 個真實目錄逆向實證（含 worktree 的 `.claude`→`--claude`）：
   把專案絕對路徑中**所有非 `[A-Za-z0-9]` 字元逐一換成 `-`、大小寫保留**（例：`/Users/me/Sources/foo-bar`
   → `-Users-me-Sources-foo-bar`）。基準為**專案路徑**，正常運作等於 `CLAUDE_PROJECT_DIR`（`encode(CLAUDE_PROJECT_DIR)`
   實測等於實際 encoded 目錄、亦等於當前 session transcript 與 `/tmp/claude-<uid>` 下的 encoded 段）。
   此（有損）編碼**僅用作 G5(c) 這道 fail-safe 驗證閘**，**不用於建構任何 trusted 路徑**：猜錯/Claude 改版/
   Windows 寫法不符 → 閘 mismatch → **不放寬**（退回 `ask`），**絕不誤放行**。實作須再以 research/實證複核
   （尤其 Windows、含空白/非 ASCII 路徑），但因 fail-safe，複核落差只影響「是否放寬」、不影響安全。
   **建構** trusted 路徑時一律改用「權威編碼段」E（見 §1.2.7），不用此有損 encode（避免碰撞建構出他專案路徑）。
7. **背景任務輸出 base 為 `/tmp/claude-<uid>`**（macOS 實證；`/tmp`→`/private/tmp` symlink，指令可能用任一形式；
   `<uid>` 為數值 user id，實測等於 `id -u`，程式以 `Deno.uid()` 取得）。其下結構
   `claude-<uid>/<encoded>/<session-id>/tasks/...`，與 `~/.claude/projects/<encoded>/` **同一 `<encoded>`**。
   **此 base 非 `$TMPDIR`**（macOS `$TMPDIR` 為 `/var/folders/...`，與此無關），且**官方未文件化**（base 猜錯/
   平台不符 → 不匹配 → 不放寬）。因兩處 `<encoded>` 相同，本功能取 `~/.claude` 已驗證目錄的**權威編碼段**
   E = `basename(dirname(transcript_path))` 來建構 `/tmp` 根，**不**用有損 `encode(root)`（見 §4.1、§2.1 G6）。

### 1.3 本功能要改的事

把「當前專案的 Claude Code 工具輸出目錄」（§1.1 兩處）納入 `isReadScoped` 的 allow 區域，使落在其下的
**純唯讀指令路徑**被視為可讀。**只放寬「讀取位置」**，不放寬任何寫入/執行偵測；且此放寬來源與「使用者
permission 規則」在型別上分離。

## 2. 目標與非目標

### 2.1 目標

- G1：當前專案於 `~/.claude/projects/<encoded>/` 目錄（含其下 `tool-results/`、各 session 的 transcript
  `.jsonl`、`memory/` 等**任意深度**子路徑）被視為唯讀可讀。**這是刻意的權限擴張**：涵蓋同一專案的
  **歷史 session 與 memory**，理由：(a) 皆為「當前專案」自身的 Claude 衍生物、使用者本機自有資料；
  (b) agent 常需跨 session 回看；(c) 仍受 G3/G5/G6 與所有寫入偵測約束、且只放寬唯讀。跨「專案」不放寬（N1）。
- G2：放寬來源（hook 自身推導的目錄）與使用者 `rules.readScope` **在資料結構上徹底分離**；`rules` 全程不被 mutate。
- G3：**trusted 放寬永不覆寫使用者的 Read `deny`/`ask`**。trusted 與 user-allow 同屬 `isReadScoped` 最低的
  「放寬」層，`deny`/`ask` 命中時先回 `false`，結果與「未啟用本功能」時完全相同（見 §6.1）。
- G4：fail-safe——對缺失/不合法輸入、或任一安全閘不符，一律退回現況（`ask`），絕不誤放行（誤 ask 可接受）。
- G5：**`~/.claude/projects` 來源的三道 fail-closed 安全閘**（任一不過 → 不放寬此來源，回 `null`）：
  - **(a) session 綁定**：`basename(normalizeAbsolute(transcript_path))` 必須等於 `<session_id>.jsonl`。
  - **(b) 位置綁定**：`dir = dirname(...)` 嚴格位於 `<home>/.claude/projects/` 之下且至少一個非空段；`home` 無解 → 不放寬。
  - **(c) 專案綁定**：`basename(dir)` 必須等於 `encode(root)`（封「自洽但錯專案」的 `<other>/<同一 session_id>.jsonl`）。
  - (b)+(c) 等價於要求 `dir === normalizeAbsolute(<home>/.claude/projects/encode(root))`（§4.1 以此單一等式表達）。
- G6：**`/tmp/claude-<uid>` 來源的 task 輸出根**：僅在 G5 已產生 ~/.claude 目錄（`projectDir`）時才啟用，
  取其**權威編碼段** E = `basename(projectDir)`（Claude 對當前專案的真實編碼，非我們的有損 encode），
  建構 `<base>/claude-<uid>/E`，`base ∈ {/tmp, macOS 另加 /private/tmp}`，涵蓋當前專案所有 session。
  uid 取不到（Windows/權限）或 `projectDir` 為 null → 不產生此根。**因 E 為權威段，不會因編碼碰撞建構出他專案路徑。**

### 2.2 非目標

- N1：**不放行其他專案**。兩來源皆綁定當前 session/專案：`~/.claude` 來源信任 session 綁定後的權威 transcript
  dirname（G5(a)+(b)），並以 G5(c) `encode(root)` 閘再防「自洽錯專案」；`/tmp` 來源用該權威 dirname 的編碼段 E
  建構（非有損 encode），且僅在 ~/.claude 來源已驗證時才啟用。**殘留風險（明示）**：

  - (i) **G5(c) 閘的編碼碰撞（複合條件）**：有損 `encode` 僅用於 G5(c) 這道**驗證閘**（不再用於建構任何路徑）。
    要因碰撞誤放行，須**同時**：Claude 送來指向他專案 `<other>` 的 transcript、其 basename 又自洽等於當前
    `session_id`、且 `encode(current root)` 又恰好碰撞等於 `<other>`——三者皆成立才會通過。極窄複合條件、列為已知殘留。
    `/tmp` 來源因改用權威段 E、已無「單條件建構碰撞」。
  - (ii) **平台信任假設**：仍信任「Claude 送來的 `transcript_path`/`session_id`/`CLAUDE_PROJECT_DIR`/`Deno.uid()`
    屬於當前 session/專案/使用者」——與既有信任 `cwd`/`tool_input` 同一信任層級。

- N2：不放寬任何寫入型重導向、賦值前綴、非唯讀指令偵測（與既有不變量一致）。
- N3：不改動「遞迴遍歷磁碟根/家目錄根 → deny」之硬性不變量。
- N4：**目錄推導/重建只用**：`~/.claude` 來源用 `transcript_path` 的 dirname；`/tmp` 來源用 `uid`+`encode(root)`。
  `session_id`/`home`/`root`+`encode` 僅作 G5/G6 綁定，`encode(root)` 僅作 fail-safe 比對，不用來在推導路徑上
  依賴猜測編碼產生「可獨立成立」的結果（`/tmp` 來源的 `encode` 同樣只指當前 root、且其值錯只會 fail-safe 不匹配）。
- N5：不對推導出的目錄/檔案做存在性 I/O 檢查（純詞法，與 `scope.ts` 不碰 FS 的設計一致）。
- N6：**不修改既有的 `settingsAllows` 升級層行為**（`Bash(...)` allow 把 `ask` 升級為 `allow`）；見 §6.1。

## 3. 方案選擇

注入點採**方案 1**：在 `ScopeConfig` 新增獨立欄位 `trusted: string[]`，由 `main.ts` 組裝後以**獨立參數**
穿過 `evaluate`/`classify`，於 `isReadScoped` 的 allow 層比對。使用者規則與工具推導目錄型別分離。
（方案 2「併進 readScope.allow 複本」、方案 3「當 always-allowed root」分別因混淆來源、與 G3 衝突而否決。）

`trusted` 由兩來源組成（皆綁定當前 session/專案）：`~/.claude` 來源 = 權威 `dirname(transcript_path)`（G5 三閘）；
`/tmp` 來源 = `/tmp/claude-<uid>/E`（E = 該權威 dirname 的編碼段，macOS 另含 `/private/tmp` 變體），僅在 ~/.claude
來源已驗證時才啟用。~/.claude 來源失敗 → 兩來源皆無；uid 取不到 → 僅缺 `/tmp` 根；皆無 → `trusted = []` → 行為等同現況（`ask`）。

## 4. 詳細設計

### 4.1 新模組 `src/claude_dir.ts`（純函式、不碰 FS、不丟例外）

```ts
import { isAbsolute, normalizeAbsolute, toPosix } from "./engine/scope.ts";

function posixBasename(absPosix: string): string;
function posixDirname(absPosix: string): string | null;  // 頂層 "/x" → "/"；無分隔符 → null

/** 專案路徑編碼（§1.2.6）：非 [A-Za-z0-9] 一律換 '-'、大小寫保留。 */
export function encodeProjectPath(path: string): string;  // toPosix(path).replace(/[^A-Za-z0-9]/g, "-")

/** ~/.claude/projects 來源：三道 fail-closed 安全閘（G5）全過才回目錄，否則 null。 */
export function claudeProjectOutputDir(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  root: string,
  home: string | null,
): string | null;

/**
 * /tmp/claude-<uid> 來源（G6）：用「已驗證的 ~/.claude 目錄」之權威編碼段 E = basename(projectDir)
 * 建構 task 輸出根 <base>/claude-<uid>/E；不使用有損 encode(root) 建構（避免碰撞建構出他專案路徑）。
 * projectDir 須為 claudeProjectOutputDir 的非 null 回傳；uid===null → []。
 */
export function claudeTaskOutputRoots(
  projectDir: string,
  uid: number | null,
  includePrivateTmp: boolean,  // main.ts 傳 Deno.build.os === "darwin"
): string[];
```

`claudeProjectOutputDir` 行為（依序，任一失敗回 `null`）：

1. `home === null` → `null`。
2. `sessionId` 為 `undefined`/空白 → `null`。
3. `transcriptPath` 為 `undefined`/空白 → `null`。
4. `t = trim(transcriptPath)`；非絕對路徑（`isAbsolute`）→ `null`。
5. `toPosix(t)` 不以 `.jsonl` 結尾（**大小寫敏感**；實際格式即小寫，與 step 6 的 `.jsonl` 字面一致）→ `null`。
6. `abs = normalizeAbsolute(t)`。**G5(a)**：若 `posixBasename(abs)` 不等於 `trim(sessionId) + ".jsonl"` → `null`。
7. `dir = posixDirname(abs)`；`dir === null` → `null`。
8. **G5(b)+(c)**：`expected = normalizeAbsolute(<home>/.claude/projects/ + encodeProjectPath(normalizeAbsolute(root)))`；
   若 `dir !== expected` → `null`。
9. 回傳 `dir`。

`claudeTaskOutputRoots` 行為：

1. `uid === null` → `[]`（Windows / `Deno.uid()` 不可用）。
2. `E = posixBasename(projectDir)`（**權威編碼段**，來自已通過 G5 三閘的 ~/.claude 目錄；非有損 encode）。
3. `bases = includePrivateTmp ? ["/tmp", "/private/tmp"] : ["/tmp"]`。
4. 回傳 `bases.map((b) => normalizeAbsolute(b + "/claude-" + uid + "/" + E))`（macOS 兩根、Linux 一根）。

因 E 取自「session 綁定後的權威 transcript dirname」而非有損 `encode(root)`，`/tmp` 根不會因編碼碰撞被建構成
他專案路徑；且僅在 ~/.claude 來源已驗證（`projectDir !== null`）時才呼叫此函式 → 與 session/transcript 同錨。
異常案例（皆 fail-safe）：~/.claude 來源未過 G5 → 無 `projectDir` → `/tmp` 來源亦不產生；uid 取不到 / base 平台不符 → 無 `/tmp` 根。

### 4.2 `engine/scope.ts`

- `ScopeConfig` 介面新增欄位 `trusted: string[]`（正規化絕對 POSIX 目錄根清單）。
- `rootScope(root)` helper 補 `trusted: []`（向後相容）。
- `isReadScoped(absPosix, scope)` 在現有 `allow` 比對「之後」新增 trusted 比對：

  ```
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
- `main.ts`（`root`、`home` 既有）組裝 `trustedReadRoots`，`rules` 完全不被 mutate：

  ```ts
  const trusted: string[] = [];
  const cdir = claudeProjectOutputDir(input.transcript_path, input.session_id, root, home);
  if (cdir !== null) {
    trusted.push(cdir);                                  // ~/.claude 來源（權威 dir）
    let uid: number | null = null;
    try { uid = Deno.uid(); } catch { uid = null; }      // 權限/平台失敗 → null → 不產生 /tmp 根
    trusted.push(...claudeTaskOutputRoots(cdir, uid, Deno.build.os === "darwin"));  // /tmp 來源用 cdir 的權威 E
  }
  decision = evaluate(command, root, initialCwd(input.cwd, root), rules, home, trusted);
  ```

- **build/test 權限**：`deno.json` 的 `build` 與 `test` task 需新增 `--allow-sys=uid`（`Deno.uid()` 所需）。
  `Deno.uid()` 已包 try/catch，未授權亦 fail-safe 回 null（僅失去 `/tmp` 來源、不影響安全與 `~/.claude` 來源）。

## 5. 資料流

```text
stdin JSON ─▶ HookInput{ transcript_path?, session_id? }   root = CLAUDE_PROJECT_DIR；home = homeDir(env)；uid = Deno.uid()|null
   cdir = claudeProjectOutputDir(transcript_path, session_id, root, home)  ─▶ string|null   (G5 三閘)
   if cdir !== null:  trusted += cdir;  trusted += claudeTaskOutputRoots(cdir, uid, os==='darwin')  (G6，用 cdir 的權威 E)
                                   ▼
main.ts: trustedReadRoots: string[]
        evaluate(…, rules, home, trustedReadRoots) → classify(…, trustedReadRoots)
        ScopeConfig{ root, home, allow, deny, ask, trusted: trustedReadRoots }
        isReadScoped ── allow 層比對 trusted ──▶ in-project / out-of-project
```

`rules.readScope`（使用者規則）與 `trustedReadRoots`（工具推導）為兩條獨立輸入，僅在 `ScopeConfig`
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

- **Fail-safe**：`claude_dir.ts` 兩函式純字串運算、不丟例外；`Deno.uid()` 於 `main.ts` 包 try/catch。任何
  不合法輸入、安全閘不過、uid 取不到、編碼/ base 逆向落差（含 Windows/特殊字元）→ 該來源不貢獻根 → 至多
  `trusted = []` → 行為等同現況（`ask`）。最外層 try/catch 與 `exit 0` 不變。
- **只放寬讀取位置**：寫入型重導向／賦值前綴／非唯讀指令偵測完全不動。
- **deny 硬性不變量**：trusted 目錄皆為深層子目錄（`~/.claude/projects/<enc>`、`/tmp/claude-<uid>/<enc>`），
  永不等於磁碟根/home 根，`dangerousRoot` 不對它成立；對其遞迴掃描走一般唯讀放行、不觸發 deny。`classify`
  對 builtin `deny` 的短路邏輯不變。
- **跨專案隔離（N1）**：兩來源皆綁定當前 `root`；已知殘留見 §2.2 N1。

## 7. 測試計畫

- `src/claude_dir_test.ts`（新）：
  - `encodeProjectPath`：`/Users/me/Sources/foo-bar` → `-Users-me-Sources-foo-bar`；點/空白/worktree（`.claude`→`--claude`）。
  - `claudeProjectOutputDir` 合法：絕對 `.jsonl`、basename == `<session_id>.jsonl`、`dir == <home>/.claude/projects/encode(root)` → 回 dir。
  - 大小寫**敏感**：大寫 `.JSONL` 結尾 → `null`（與 step 6 小寫字面一致）；前後空白（transcript、sessionId）皆 `trim`。
  - **G5(a) 負向**：basename 與 `session_id` 不符 → `null`；`session_id` 缺失/空白 → `null`。
  - **G5(c) 負向（自洽錯專案）**：`<home>/.claude/projects/<other>/<同一 id>.jsonl`（`<other>` ≠ `encode(root)`）→ `null`。
  - **G5(b) 負向**：`<home>/.ssh/<id>.jsonl` → `null`；`<home>/.claude/projects/<id>.jsonl`（少一段）→ `null`。
  - 非 `.jsonl`、相對、空、`undefined` → `null`；`home === null` → `null`。
  - `claudeTaskOutputRoots(projectDir, uid, includePrivateTmp)`：`uid===null` → `[]`；`includePrivateTmp=true` →
    `["/tmp/claude-<uid>/E","/private/tmp/claude-<uid>/E"]`（`E = basename(projectDir)`）；`false` → 單一 `/tmp` 根；
    根的 basename == `E`（即沿用權威編碼段、非重算 encode）。
  - **編碼碰撞（reviewer 指定）**：以 `root=/a/b` 與 `root=/a-b`（皆 encode → `-a-b`）建構案例，斷言：
    `/tmp` 根 basename 取自 `projectDir` 的權威 E（兩專案各自 transcript 的真實段不同）→ 不會互相建構出對方路徑；
    G5(c) 閘對 `/a/b` 僅在 transcript 的 `<other>` 恰等於 `encode(/a/b)=-a-b` 時才通過（複合條件，明示為已知殘留）。
  - 平台斷言以 `Deno.build.os` 區分（Windows `X:/`、Windows uid/編碼可能 fail-safe-disable，明示）。
- `src/engine/scope_test.ts`（增補）：trusted root 下回 true；trusted 與 user-allow 並存皆放行；
  deny/ask 命中時即使在 trusted 下仍 false（G3）；專案根內仍 root-first；`rootScope` 之 `trusted` 為 `[]`。
- `src/engine/classify_test.ts`（增補）：
  - 傳入 `trustedReadRoots`，`cat <trusted 下檔案>` → allow（涵蓋 `~/.claude` 與 `/tmp` 兩種根各一）。
  - **G1 刻意擴張回歸**：讀 `~/.claude` trusted 下他 session 子路徑與 `memory/` 檔 → allow。
  - **G3 回歸**：trusted 下但命中 user `Read(...)` deny、且無對應 `Bash(...)` allow → ask。
  - 未傳 `trustedReadRoots`（預設 `[]`）→ 同路徑 ask。
- `src/main_test.ts`（增補 e2e；子行程須提供 `HOME`、`CLAUDE_PROJECT_DIR`；payload 含 `session_id`；驗 `/tmp`
  根需 binary 有 `--allow-sys=uid`，否則該案標記為 macOS/權限相依）：
  - payload 帶合法 `transcript_path` + 相符 `session_id`，讀 `~/.claude` 工具輸出檔 → allow；不帶 → ask；
    basename 與 `session_id` 不符 → ask（G5(a)）；encoded 段 ≠ `encode(root)` → ask（G5(c)）；在 projects 外 → ask（G5(b)）。
  - 讀 `/tmp/claude-<uid>/<E>/<session>/tasks/<id>.output`（`E` 同 `~/.claude` 目錄編碼段）→ allow；讀別專案 `<other>` 下同類路徑 → ask。
- 既有 341 測試與 `deny` 相關 e2e 全數維持綠燈。

## 8. Operational verification（實作後必做）

`deno task build` 後餵真實 JSON 給 binary（環境含 `HOME`/`USERPROFILE`、`CLAUDE_PROJECT_DIR`；payload 含 `session_id`）：

1. 帶合法 `transcript_path`（`~/.claude/projects/<encode(root)>/<session_id>.jsonl`）讀工具輸出檔 → `allow`、`exit 0`。
2. 讀 `/private/tmp/claude-<uid>/<E>/<session>/tasks/<id>.output` 與 `/tmp/...` 兩形式（`E` 為 `~/.claude` 目錄之權威編碼段）→ `allow`。
3. `transcript_path` 指向別專案 `<other>` 但 `session_id` 自洽 → `ask`（G5(c)）；讀別專案 `/tmp/.../<other>/...` → `ask`。
4. `transcript_path` basename 與 `session_id` 不符 → `ask`（G5(a)）；指向 `~/.claude/projects/` 外 → `ask`（G5(b)）。
5. 不帶 `transcript_path` 且非 `/tmp` 來源的家目錄路徑、未被任何 `Read()` allow 宣告 → 仍 `ask`。

## 9. 變更檔案清單

- 新增：`src/claude_dir.ts`、`src/claude_dir_test.ts`。
- 修改：`src/engine/scope.ts`（`ScopeConfig.trusted`、`rootScope`、`isReadScoped`）、
  `src/engine/classify.ts`（新參數 + 組 scope）、`src/engine/evaluate.ts`（新參數轉傳）、
  `src/hook/types.ts`（`transcript_path?`）、`src/main.ts`（組裝兩來源 trusted、`Deno.uid()` try/catch）、
  `deno.json`（`build`/`test` task 加 `--allow-sys=uid`）。
- 測試增補：`src/engine/scope_test.ts`、`src/engine/classify_test.ts`、`src/main_test.ts`。
- 文件：`CLAUDE.md` 補一節說明兩個放寬來源、三道安全閘（session/位置/專案綁定）與 `/tmp` 重建（uid+encode）、
  逆向編碼/base 為 fail-safe、刻意的歷史 session/memory 擴張、優先序（含 §6.1）、已知殘留（編碼碰撞、平台信任假設）、
  `--allow-sys=uid` 權限與「不混入使用者規則」之設計。
