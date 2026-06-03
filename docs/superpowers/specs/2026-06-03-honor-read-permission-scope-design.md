# 設計規格：沿用 Read/Edit/Write 權限規則放寬唯讀指令的路徑範圍

- 日期：2026-06-03
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，
只在「純唯讀且全部落在當前專案內」時回 `allow`，其餘回 `ask`，**永不 `deny`、永遠 `exit 0`**。
既有功能（見 2026-06-01 規格）已會 runtime 讀取 `permissions.allow` 中的 `Bash(...)` 規則，
在 builtin 判 `ask` 時嘗試升級為 `allow`。

### 1.1 痛點

Deno 的 npm 快取放在使用者目錄外（Windows 為 `%LOCALAPPDATA%/deno/npm`，即
`C:\Users\<user>\AppData\Local\deno\npm`），位於**專案範圍外**。使用者已在 settings.json 以
`Read(...)` 規則允許讀取該目錄，期望 agent 能用 `grep`/`cat` 等指令查閱套件原始碼。

但本工具目前：

1. **路徑範圍檢查只認單一專案根**（`scope.ts` 的 `isWithin(root, …)`）。deno 快取在專案外
   → `resolvePathValue` 回 `out-of-project` → 中央/個別規則判 `ask`。
2. **runtime 升級層只讀 `Bash(...)` 規則**（`classify.ts` → `settingsAllows`），
   **完全不看 `Read(...)`/`Edit(...)`/`Write(...)`**。

因此使用者設的 `Read(...)` 對「經 Bash 執行的 grep」毫無作用 —— 這就是痛點根因。

### 1.2 已查證的 Claude Code 語意（官方文件 + GitHub issue 交叉驗證）

來源：<https://code.claude.com/docs/en/permissions>、<https://code.claude.com/docs/en/hooks-guide>、
<https://code.claude.com/docs/en/sandboxing>（信心度：高）。

1. **Bash 工具原生無路徑感知。** 官方：Bash 權限「只檢查 `Bash` 是否在權限清單，不解析指令裡的
   路徑去比對」。→ 使用者看到的「讀專案外就被問」**是本 hook 自己加的**，不是 CC 原生行為。
   故本 hook 回 `allow` 對「沒命中任何 `Bash(...)` 規則、預設會跳提示」的指令**確實能略過提示放行**。
2. **`permissionDecision: "allow"` 的語意**：官方原文「skip the interactive permission prompt」。
   `allow` 不會突破 settings 的 `deny`/`ask`（`deny > ask > allow`，most-restrictive-wins）。
3. **`Read()/Edit()` 規則的官方定位**：文件稱其「套用於 Claude 內建檔案工具，**不**套用於 Bash
   subprocess」。另有 GitHub issue 反映新版存在「未公開的跨工具掃描器」會用 `Read()/Edit()` 的
   **deny** 規則結構性比對來擋 Bash —— 但**那是 deny 方向**；**allow 方向不會自動放行 Bash**。
   故 `Read()` allow 不會讓 CC 自己放行 grep，本 hook 仍是唯一能把該 grep 變 `allow` 的環節
   （此 GitHub issue 細節信心度中、僅供佐證，不影響本功能成立的結論）。
4. **`Read(...)` 路徑模式語法**：遵循 gitignore 規範，四種前綴：
   - `//path` ＝ **檔案系統絕對路徑**（例：`Read(//Users/alice/secrets/**)`）。
   - `~/path` ＝ **家目錄相對**（例：`Read(~/Documents/*.pdf)`）。
   - `/path` ＝ **專案根相對**（例：`Read(/src/**)`）。`/Users/alice` 是專案相對、**不是**絕對。
   - `path` 或 `./path` ＝ **cwd 相對**；裸檔名 `Read(.env)` ≡ `Read(**/.env)`（任意深度）。
   - `*` 匹配單層、`**` 遞迴；無 glob 的純路徑＝字面匹配該檔/該目錄本身（**不遞迴**）。
   - Windows 正規化為 POSIX：`C:\Users\alice` → `/c/Users/alice`；絕對寫法用 `//c/…`。
5. **sandbox 是 OS 層**：若使用者啟用 `sandbox.filesystem`，專案外路徑會在 **OS 層**被擋，
   與 hook 決策無關。預設（未開 sandbox）時本 hook 的 `allow` 完全有效（見 §7 限制）。

### 1.3 本功能要改的事

把「路徑範圍判定」的「allow 區域」從**僅專案根**，擴充為
**專案根 ∪（使用者以 `Read()/Edit()/Write()` allow 宣告、且未被 deny/ask 否決的外部唯讀位置）**。
**只放寬「讀取位置」**，不放寬任何寫入/執行偵測。

## 2. 目標與非目標

### 目標

- runtime 解析三處 settings（專案 `.claude/settings.json`、`.claude/settings.local.json`、
  使用者 `~/.claude/settings.json`）`permissions.{allow,deny,ask}` 中的
  `Read(...)`/`Edit(...)`/`Write(...)` 規則，抽出「外部唯讀範圍」。
- 讓 `scope.ts` 的三態判定在「指令路徑落在外部允許範圍且未被否決」時回 `in-project`，
  使既有唯讀規則自然放行；`classify.ts` 的 cwd 中央前置檢查同步沿用此擴充範圍。
- 全程 fail-safe：任何讀檔／解析失敗退化為「無此來源規則」，永不丟例外、永遠 `exit 0`。

### 非目標（YAGNI，刻意排除）

- **不**處理 `/`（專案相對）與 `path`/`./path`（cwd 相對）前綴：前者解析回專案內、本就 in-scope
  （加了是 no-op）；後者語義模糊且 cwd 另有中央檢查。**只認 `//` 與 `~/`**。
- **不**支援中段 glob（`dir/*.json`、`**/foo`、`a*b/**`）與裸檔名（`.env`≡`**/.env`）：
  無法化約為「乾淨的目錄 root」或「精確單檔」者一律忽略（維持 ask，default-safe）。
- **不**讀 enterprise managed-settings.json。
- **不**放寬任何寫入/執行偵測（寫入重導向、賦值前綴、非唯讀指令）—— 見 §6 不變量。
- **不**引入快取（hook 每次 Bash 呼叫都是獨立進程）。
- **不**改動既有 `Bash(...)` 升級層（`settingsAllows`）：兩機制並存（見 §5）。

## 3. 架構與資料流

新增邏輯掛在既有「settings 載入」與「scope 範圍判定」兩層，不改 parse / walk / combine 職責。

```
main.ts
  ├─ resolveProjectRoot(env)                                （既有）
  ├─ loadPermissionRules(env, root)                          （擴充：附帶 readScope）
  └─ evaluate(command, root, initialCwd, rules)              （既有簽名不變）
        └─ classify(inv, root, rules)                        （既有簽名不變）
              ├─ 由 root + rules.readScope 組裝 ScopeConfig   （新增，於 classify 內）
              ├─ classifyBuiltin(inv, scope)                 （cwd 檢查 + 規則閉包改用 scope）
              │     └─ resolvePath / resolvePathValue(…, scope)（scope.ts 簽名擴充）
              └─ settingsAllows(inv, rules)                  （既有 Bash() 升級層，不變）
```

## 4. 詳細設計

### 4.1 新型別：ReadScope 與 PermissionRules 擴充

於 `src/permissions/path_scope.ts`（新檔）定義：

```ts
/** 由 Read()/Edit()/Write() 規則化約而來的外部唯讀範圍（路徑皆為已正規化的絕對 POSIX 形式）。 */
export interface ReadScope {
  /** 目錄 root（來自結尾 `/**` 的遞迴模式）；以 isWithin 比對「在其下」。 */
  roots: string[];
  /** 精確單一路徑（來自無 glob 的字面模式）；以正規化後字串相等比對。 */
  files: string[];
}

/** 空 ReadScope 常數。 */
export const EMPTY_READ_SCOPE: ReadScope = { roots: [], files: [] };
```

於 `src/permissions/settings.ts` 重構 `PermissionRules`：把既有的 `Bash(...)` 三分類包進 `bash` 子物件，
與新增的 `readScope` 對稱（兩者皆保留 settings 的 `allow`/`deny`/`ask` 三分類，**不在載入層合併**）：

```ts
import { type ReadScope, EMPTY_READ_SCOPE } from "./path_scope.ts";

/** Bash(...) 規則三分類（對齊 settings permissions 結構）。 */
export interface BashRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** Read/Edit/Write 化約的外部唯讀範圍三分類（與 settings 對齊；deny/ask 不在載入層合併）。 */
export interface ReadScopeRules {
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

export interface PermissionRules {
  bash: BashRules; // 原扁平的 { allow, deny, ask } 移入此層
  readScope: ReadScopeRules;
}

export const EMPTY_RULES: PermissionRules = {
  bash: { allow: [], deny: [], ask: [] },
  readScope: { allow: EMPTY_READ_SCOPE, deny: EMPTY_READ_SCOPE, ask: EMPTY_READ_SCOPE },
};
```

> 重構影響：`matcher.ts` 的 `settingsAllows` 改讀 `rules.bash.{deny,ask,allow}`；`settings.ts` 的
> `emptyRules`/`parseFile`/`loadPermissionRules` 改為產出並合併 `bash` 與 `readScope` 兩組。詳見 §4.3、§9。

### 4.2 模式解析：parsePathRule

於 `src/permissions/path_scope.ts` 實作。輸入單一規則字串與已解析的家目錄，輸出一筆 scope entry：

```ts
export type PathScopeEntry =
  | { kind: "root"; path: string }   // 目錄 root，已正規化絕對 POSIX
  | { kind: "file"; path: string };  // 精確單檔，已正規化絕對 POSIX

/**
 * 解析 "Read(...)" / "Edit(...)" / "Write(...)" 規則為外部唯讀 scope entry。
 * 只認 `//`（絕對）與 `~/`（家目錄）前綴；其餘前綴、含 glob 的複雜形式、否定模式 → null（忽略）。
 * home 為 null（無法解析家目錄）時，`~/` 規則一律回 null。
 */
export function parsePathRule(rule: string, home: string | null): PathScopeEntry | null;
```

**演算法（逐步，default-safe：任何不確定 → 回 null）：**

1. 用 `^(Read|Edit|Write)\((.+)\)$` 比對；不符 → null。取括號內字串 `inner`（`.+` 保證非空）。
2. **否定模式**：`inner` 以 `!` 開頭 → null（不支援）。
3. **解析前綴為「半成品絕對 POSIX 字串 `p`」**：
   - `inner` 以 `//` 開頭 → 去掉**一個**前導 `/`，得 `p = inner.slice(1)`（`//c/foo/**` → `/c/foo/**`）。
     若去除後 `p` 仍以 `//` 開頭（多重斜線，如 `///c/...`），不再額外處理，交由 `normalizeAbsolute`
     原樣輸出；此類非標準形式通常比對不到任何實際路徑，維持 ask（default-safe，刻意不特別折疊）。
   - `inner` 以 `~/` 開頭 → `home === null` 回 null；否則 `p = toPosix(home) + "/" + inner.slice(2)`。
   - 其餘（`/path`、`path`、`./path`）→ null（非目標前綴）。
4. **分類 `p`（glob 字元集合定義為 `/[*?[\]]/`，即 `*`、`?`、`[`、`]`；此為 `parsePathRule` 自有常數，
   **不複用** `word.ts` 的 `GLOB_CHARS`——後者用於 shell token 偵測、語意不同。多納入 `]` 只會讓更多
   形式被忽略，更保守、符合 default-safe）：**
   - `p` 以 `/**` 結尾：取 `base = p.slice(0, -3)`；若 `base === ""` → 視為檔案系統根
     `base = "/"`；**若 `base` 仍含任何 glob 字元 → null**（如 `/c/foo*/**`）；
     否則回 `{ kind: "root", path: normalizeAbsolute(base) }`。
   - `p` 完全不含 glob 字元：回 `{ kind: "file", path: normalizeAbsolute(p) }`。
   - 其餘（含 glob 但非乾淨結尾 `/**`，如 `/c/dir/*.json`、`/c/**/foo`）→ null（忽略）。

> **跨平台**：`normalizeAbsolute` 在 Windows 會把 `/c/foo` → `C:/foo`（與專案根、指令路徑同形式）；
> 在 Linux 不套用磁碟轉換（`/c/` 是真 POSIX）。此行為由既有 `scope.ts` 保證，本檔直接複用。
> `toPosix`（反斜線轉斜線）需自 `scope.ts` 匯出供本檔使用（目前為私有，改為 `export`）。

### 4.3 載入層：只讀設定檔、結構化輸出（settings.ts）

載入層**只負責讀取與結構化**，不做任何政策合併——「deny/ask 是否否決放寬」屬決策層的事（見 §4.4），
故此處 `readScope` 的 `allow`/`deny`/`ask` 三桶彼此獨立、**互不合併**。

`parseFile` 改為對 `permissions.{allow,deny,ask}` 三桶各自抽取：
- 既有 `parseRuleList`（Bash）→ 填入該桶的 `BashRules` 欄位。
- 新增 `parsePathRuleList(value, home)`：對每個字串呼叫 `parsePathRule`，把非 null 結果依 `kind`
  收進該桶的 `ReadScope`（`root`→`roots`、`file`→`files`）。Read∪Edit∪Write 已在 `parsePathRule`
  層不分工具一視同仁，故此處只需依 **allow/deny/ask 分桶**。

`loadPermissionRules` 跨三個 settings 檔合併時，對 `bash` 與 `readScope` 的**每一個** allow/deny/ask 桶
各自 union（`BashPattern[]` concat；`ReadScope` 的 `roots`/`files` 各自 concat）。

`home` 由既有 `resolveHome(env)` 取得（已實作；無法解析時回 null，`~/` 規則自然被忽略）。
fail-safe：`parsePathRuleList` 以 try/catch 逐條兜底（`parsePathRule` 本身不應丟例外）；任一檔失敗僅
該檔貢獻空 `BashRules`/`ReadScopeRules`。

### 4.4 scope.ts：ScopeConfig 與三態判定擴充

新增型別與判定函式；既有 `isAbsolute`/`normalizeAbsolute`/`isWithin`/`resolveAgainst` 不變，
`toPosix` 改為 `export`。

```ts
import type { ReadScope } from "../permissions/path_scope.ts";

/** 範圍設定：專案根 + 外部唯讀範圍三分類（allow/deny/ask，與 settings 對齊）。 */
export interface ScopeConfig {
  root: string;
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}

/** 由裸 root 字串組成「無外部放寬」的 ScopeConfig；供既有測試與不需外部範圍的呼叫端使用（向後相容）。 */
export function rootScope(root: string): ScopeConfig {
  return {
    root,
    allow: { roots: [], files: [] },
    deny: { roots: [], files: [] },
    ask: { roots: [], files: [] },
  };
}

/** 單一 ReadScope 是否命中（roots 用 isWithin、files 用精確相等）。 */
function hits(s: ReadScope, absPosix: string): boolean {
  return s.roots.some((r) => isWithin(r, absPosix)) || s.files.some((f) => f === absPosix);
}

/**
 * 已正規化絕對 POSIX 路徑是否落在「允許讀取的位置」（政策合併在此決策層，非載入層）：
 *   專案根內 → true（永遠允許，不受外部 deny/ask 影響，保留「只放寬、不收窄」語義）；
 *   否則（外部路徑）命中 deny → false；命中 ask → false（兩者皆否決放寬，維持 deny>ask>allow）；
 *   否則 命中 allow → true；
 *   其餘 → false。
 */
export function isReadScoped(absPosix: string, scope: ScopeConfig): boolean {
  // 專案內永遠允許（root-first：外部 deny/ask 不得把專案內路徑降級為 ask）。
  if (isWithin(scope.root, absPosix)) return true;
  // 外部路徑：deny > ask 依序否決放寬（兩者皆 veto，分離保留以與 settings 一致），再看 allow。
  if (hits(scope.deny, absPosix)) return false;
  if (hits(scope.ask, absPosix)) return false;
  if (hits(scope.allow, absPosix)) return true;
  return false;
}
```

> 註：`files` 已於載入時 `normalizeAbsolute`，`absPosix` 亦為正規化值，故 `f === absPosix` 字串相等
> 即正確（無需再呼叫 normalize）。`files` 一律精確比對（單檔否決/放行只作用於該檔本身，不遞迴）。
> deny 與 ask 在放寬決策上同為 veto（皆使外部路徑不被視為 in-project），但於載入層與 `ScopeConfig`
> 保持分離，以與 settings 的 `allow`/`deny`/`ask` 結構一致（政策合併集中在 `isReadScoped`）。
>
> 循環依賴：`scope.ts` 對 `path_scope.ts` **僅 `import type { ReadScope }`**（型別編譯期抹除）；
> `path_scope.ts` 反向 `import { normalizeAbsolute, toPosix }`（值）自 `scope.ts`——單向值依賴、無
> runtime 循環，沿用既有 `matcher.ts` ↔ `settings.ts` 的 `import type` 模式。`rootScope` 內聯空
> `ReadScope` 而非匯入 `EMPTY_READ_SCOPE`（值），即為避免反向值匯入。

`resolvePathValue` / `resolvePath` 簽名由「`root: string`」改為「`scope: ScopeConfig`」：

```ts
export function resolvePathValue(value: string | null, cwd: CwdState, scope: ScopeConfig): PathScope {
  if (value === null) return "dynamic";
  let abs: string;
  if (isAbsolute(value)) {
    abs = normalizeAbsolute(value);
  } else {
    if (cwd.kind === "unknown") return "dynamic";
    abs = resolveAgainst(cwd.path, value);
  }
  return isReadScoped(abs, scope) ? "in-project" : "out-of-project";
}

export function resolvePath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope {
  return resolvePathValue(staticValue(arg), cwd, scope);
}
```

行為等價性保證：當 `scope.allow`/`scope.deny`/`scope.ask` 皆空時，`isReadScoped` 退化為「僅
`isWithin(root,…)`」，與既有行為完全一致（既有測試不需改判定，只需改傳參）。

### 4.5 classify.ts：組裝 ScopeConfig 並沿用於 cwd 檢查與規則閉包

`classify(inv, root, rules)` 內由 `root` 與 `rules.readScope` 組裝 `scope`，傳入 `classifyBuiltin`：

```ts
function classifyBuiltin(inv: CommandInvocation, scope: ScopeConfig): RuleVerdict {
  if (inv.name === null) return ask("動態指令名，無法判定");
  const rule = lookupRule(inv.name);
  if (!rule) return ask(`未列入 allowlist 的指令：${inv.name}`);

  // 中央前置規則之一：cwd 範圍（known 但不在「專案 ∪ 外部允許唯讀範圍」）
  if (inv.cwd.kind === "known" && !isReadScoped(normalizeAbsolute(inv.cwd.path), scope)) {
    return ask(`工作目錄超出允許範圍：${inv.cwd.path}`);
  }
  if (hasWriteRedirect(inv.redirects)) return ask(`${inv.name}：寫入型重導向`);
  if (inv.assignments.length > 0) return ask(`${inv.name}：含環境變數賦值前綴，可能改變執行行為`);

  return rule.evaluate({
    name: inv.name,
    argv: inv.argv,
    redirects: inv.redirects,
    assignments: inv.assignments,
    cwd: inv.cwd,
    resolvePath: (w) => resolvePath(w, inv.cwd, scope),
    resolvePathValue: (v) => resolvePathValue(v, inv.cwd, scope),
  });
}

export function classify(inv, root, rules = EMPTY_RULES): RuleVerdict {
  const scope: ScopeConfig = {
    root,
    allow: rules.readScope.allow,
    deny: rules.readScope.deny,
    ask: rules.readScope.ask,
  };
  const v = classifyBuiltin(inv, scope);
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
}
```

> `inv.cwd.path` 在 walk 階段已正規化，但此處仍包一次 `normalizeAbsolute` 以保險（冪等）。
> `RuleContext` 介面與所有個別規則（`rules/commands/*.ts`）**不需改動**：閉包簽名對外不變。
>
> `evaluate.ts` 無需改動（已查證）：其現況為
> `combine(invocations.map((inv) => classify(inv, root, rules)))`（`evaluate.ts:27`），第三引數
> `rules` 已轉發給 `classify`，故 `readScope` 能正確流入 **production** 路徑（非僅單元測試）。
> ⚠️ 維護注意：若該呼叫站日後改回 2 引數（漏傳 `rules`），本功能會在 production 靜默失效、而直接以
> `rules` 呼叫 `classify` 的單元測試仍會綠——屬危險的 false-green，務必維持轉發。

## 5. 與既有 Bash() 升級層（settingsAllows）的關係

兩機制正交、並存，**不**互相取代：

- **Bash() 升級層**（既有）：處理「能靜態還原成完整指令字串、且該字串命中 `Bash(...)` allow」的整條指令放行。
- **Read-scope 放寬**（本功能）：處理「唯讀指令的路徑落在外部允許讀取位置」——即使該指令字串沒有對應的
  `Bash(...)` 規則，只要它本就是 allowlist 內的唯讀指令、且路徑被 `Read()/Edit()/Write()` 涵蓋即放行。

執行順序（見 §4.5）：先跑 `classifyBuiltin`（已含 Read-scope 放寬）；若仍 `ask`，再嘗試 Bash() 升級。

`PermissionRules` 重構後，`settingsAllows` 改讀 `rules.bash.{deny,ask,allow}`（原為 `rules.{…}`），
邏輯與函式簽名不變。

## 6. 安全不變量（不可違反）

1. **只放寬「讀取位置」**：寫入型重導向、賦值前綴、非唯讀指令不在 allowlist —— 這些偵測**原樣不動**，
   且都在 path-scope 之外（與路徑無關）。放寬 in-project 不會讓任何寫入/執行被放行。
2. **維護不變量（明訂）**：allowlist 僅收**唯讀指令**。因為「放寬 in-project」是全域作用於所有
   `resolvePath` 呼叫，故**未來若新增會寫檔的指令，其寫入目標路徑不得依賴本 scope 放寬**——
   該類指令本就不該進 allowlist；若有需要，須另設不吃放寬的判定路徑。
3. **deny/ask 否決放寬、但不收窄專案內**：判定順序為 **root-first**——專案根內路徑永遠 in-project，
   不受外部 deny/ask 影響（保留「只放寬」語義，與 §4.4 行為等價性一致）；**外部**路徑才依序套用
   deny → ask → allow（deny/ask 側任一 `Read/Edit/Write` 命中即否決放寬，§4.4），與
   `deny > ask > allow` 一致，亦與 CC 未公開跨工具掃描器以 Read/Edit deny 擋 Bash 的方向一致。
4. **default-safe**：只認 `//`/`~/` 前綴、`/**` 目錄與精確單檔；其餘形式忽略 → 維持 ask。
   動態 token（`staticValue` 回 null）仍回 `dynamic` → ask。
5. **fail-safe**：解析/讀檔失敗退化為空 `ReadScope`，永不丟例外、永遠 `exit 0`。

## 7. 限制與已知邊界

- **sandbox**：若使用者啟用 `sandbox.filesystem`，專案外路徑在 OS 層被擋，hook `allow` 不足以放行；
  使用者需另把該目錄加入 sandbox 的 `allowRead`。本工具不處理 sandbox（非目標），但 CLAUDE.md 應註記。
- **CC 既有 deny/ask**：本 hook 的 `allow` 不突破 CC 端 `Bash(...)` deny/ask 與 managed deny；
  安全由 CC 再次保證。
- **裸檔名 / 中段 glob 不支援**：如 `Read(.env)`（≡任意深度）、`Read(//c/dir/*.json)` 一律忽略，
  對應指令維持 ask（誤 ask 可接受）。
- **`//**`（整個檔案系統）**：`Read(//**)` 會化約成 root `/`，使一切外部路徑視為可讀。這是使用者
  的明確宣告，照常尊重；其跨平台磁碟比對為 best-effort（`normalizeAbsolute("/")` → `/`）。

## 8. 測試策略

### 8.1 單元測試

- **`path_scope_test.ts`（新）**：`parsePathRule` 對以下逐一驗證——
  - `//` 絕對 `/**` → root；`~/` `/**` → root（含 home 串接）；`~/` 但 home=null → null。
  - 無 glob 單檔（`//c/foo/bar.txt`、`~/.zshrc`）→ file。
  - 中段 glob 或 base 含 glob（`//c/dir/*.json`、`//c/**/foo`、`//c/a*b/**`、`//c/foo]/**`）→ null。
  - 非目標前綴（`/src/**`、`src/**`、`./x`、`.env`）→ null。
  - 否定（`!//c/x`）→ null；非 Read/Edit/Write（`Bash(ls)`）→ null。
  - `Edit(...)`/`Write(...)` 與 `Read(...)` 化約結果一致。
  - Windows 專屬斷言（`//c/...` → `C:/...`）以 `ignore: Deno.build.os !== "windows"` 區分；
    Linux 專屬（`/c/...` 維持 POSIX、區分大小寫）以反向 ignore 區分。
- **`settings_test.ts`（擴充）**：`PermissionRules` 重構後 `bash` 與 `readScope` 各三桶——驗證多檔
  union 後 allow→`readScope.allow`、deny→`readScope.deny`、ask→`readScope.ask` **各自分離不合併**，
  且 `bash.{allow,deny,ask}` 仍正確；缺檔/壞 JSON fail-safe 回空 `BashRules`/`ReadScopeRules`；
  既有斷言改讀 `rules.bash.*`。
- **`scope_test.ts`（擴充）**：`isReadScoped` 與三態——
  - allow.roots 命中（且不在 deny/ask）→ in-project；**外部**路徑同時命中 deny.roots 或 ask.roots
    → out-of-project（分別驗證 deny、ask 皆 veto）。
  - allow.files 精確相等 → in-project；其子路徑不命中（單檔不遞迴）。
  - **專案內路徑即使被 deny.roots/ask.roots 涵蓋仍為 in-project**（root-first，驗證不收窄）。
  - scope.allow/deny/ask 皆空（`rootScope("/proj")`）→ 退化為「僅專案根」與既有行為一致。
  - 既有直接呼叫處改傳 `rootScope("/proj")` 而非裸 `"/proj"`。
- **`classify_test.ts`（擴充）**：建構新結構 `PermissionRules`（`bash`+`readScope`）；cwd 落在外部
  allow root 時唯讀指令放行、落在 deny/ask 時 ask；外部允許目錄內仍含寫入重導向 → ask（驗證 §6.1）。

### 8.2 Operational verification（改規則後必做）

`deno task build` 後，於含下列 settings 的環境餵 JSON 給 binary：

```jsonc
// .claude/settings.json: { "permissions": { "allow": ["Read(//c/Users/<user>/AppData/Local/deno/npm/**)"] } }
```

```bash
# 期望 allow、exit 0（路徑落在 Read() 宣告的外部 root）
echo '{"tool_name":"Bash","tool_input":{"command":"grep -r needle /c/Users/<user>/AppData/Local/deno/npm"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe

# 反例：未被任何 Read() 涵蓋的外部路徑 → 期望 ask
echo '{"tool_name":"Bash","tool_input":{"command":"grep -r needle /c/Windows/System32"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
```

## 9. 檔案變更清單

- **新增** `src/permissions/path_scope.ts`：`ReadScope`、`EMPTY_READ_SCOPE`、`PathScopeEntry`、
  `parsePathRule`。
- **新增** `src/permissions/path_scope_test.ts`。
- **修改** `src/permissions/settings.ts`：重構 `PermissionRules` 為 `{ bash: BashRules; readScope:
  ReadScopeRules }`（既有三分類移入 `bash`，新增 `ReadScopeRules` 之 `allow`/`deny`/`ask`）；
  `EMPTY_RULES`、`emptyRules()`、`parseFile`、`loadPermissionRules` 同步改為產出/合併兩組三桶；
  新增 `parsePathRuleList`、匯入 `path_scope.ts`。
- **修改** `src/permissions/settings_test.ts`：斷言改讀 `rules.bash.*`；補 `readScope.{allow,deny,ask}`
  分離 union 與 fail-safe 案例。
- **修改** `src/permissions/matcher.ts`：`settingsAllows` 改讀 `rules.bash.{deny,ask,allow}`
  （邏輯與簽名不變）。
- **修改** `src/permissions/matcher_test.ts`：建構 `PermissionRules` 的測試改用新結構（`bash` 子物件）。
- **修改** `src/engine/scope.ts`：`toPosix` 改 export、新增 `ScopeConfig`/`isReadScoped`/`rootScope`、
  `resolvePathValue`/`resolvePath` 簽名由 `root: string` 改 `scope: ScopeConfig`；對 `path_scope.ts`
  僅 `import type { ReadScope }`（避免 runtime 循環）。
- **修改** `src/engine/scope_test.ts`：直接呼叫 `resolvePath` 的各處（行 69/79/86/93/100/107 區）由裸
  `"/proj"` 改傳 `rootScope("/proj")`；補放寬/否決/「專案內不被 deny/ask 降級」案例。
- **修改** `src/engine/classify.ts`：組裝 `ScopeConfig`、cwd 檢查與閉包改用 `scope`。
- **修改** `src/engine/classify_test.ts`：改用新結構 `PermissionRules`、補外部 allow/deny/ask 案例。
- **修改** 10 個 `src/rules/commands/*_test.ts` 的 `ctxOf` helper：`resolvePath(w, cwd, "/proj")` 與
  `resolvePathValue(v, cwd, "/proj")` 改傳 `rootScope("/proj")`（檔案：`grep`、`awk`、`coreutils`、
  `deno`、`find`、`gh`、`git`、`sed`、`simple-flag`、`positional-output`）。**production `rules/**`
  規則本體與 `RuleContext` 介面不變**——僅這些測試 helper 因直接呼叫 `scope.ts` 而需配合新簽名。
- **修改** `CLAUDE.md`：於「hook 決策 vs settings.json 權限的優先序」一節補述本機制與 sandbox 限制。
- **修改（若有構造 `PermissionRules` 字面值）** `src/engine/evaluate_test.ts`：改用新結構；行為斷言不變。
- **不改**（production）`main.ts`、`evaluate.ts`（已轉發 `rules`，見 §4.5）、`combine.ts`、`walk.ts`、
  `rules/commands/*.ts`（規則本體）、`rules/types.ts`：簽名與行為皆不變。
