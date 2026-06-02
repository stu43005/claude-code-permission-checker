# 設計規格：runtime 讀取 permissions.allow 以升級 ask → allow

- 日期：2026-06-01
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，
只在「純唯讀且全部落在當前專案內」時回 `allow`，其餘回 `ask`，**永不 `deny`、永遠 `exit 0`**。

### 1.1 痛點

跨 hook 與 settings.json 的有效權限優先序為 **deny > ask > allow（most-restrictive-wins）**。
因此當使用者已在 `permissions.allow` 明確放行某指令、但本工具因無法判定為唯讀而回 `ask` 時，
`ask` 會蓋過 settings 的 `allow`，使用者反而每次都被詢問。

### 1.2 已查證的 Claude Code 語意（官方文件）

1. **hook 的 `allow` 不會繞過 settings 的 `deny`/`ask`。** 官方：「Returning `allow` skips the
   interactive prompt but does **not** override permission rules. If a deny rule matches, the call
   is blocked even when your hook returns allow. If an ask rule matches, the user is still prompted.」
   → 安全層面：即使我們誤回 `allow`，凡命中使用者 `deny`/`ask` 的指令，Claude Code 仍會擋下／詢問。
2. **複合指令逐子指令獨立匹配。** 官方：「A rule must match **each subcommand independently**」，
   分隔符 `&& || ; | |& & newline`。→ 與本工具既有的「攤平成多筆 invocation + 最弱環節」一致。
3. **`Bash(x:*)` ≡ `Bash(x *)`**：trailing wildcard 帶**詞界**——前綴後須接空白或字串結尾。
   `Bash(ls *)` 匹配 `ls`、`ls -la`，但不匹配 `lsof`。無空白的 `Bash(ls*)` 連 `lsof` 都匹配。
   無 `*` 的 `Bash(ls)` 為 **exact**。
4. **settings 來源優先序**：Managed > Local > Project > User；`deny` 為 most-restrictive 合併，
   `allow`/`ask` 為 union。對「規則集合」而言三類各自取 union 即可，跨類仍以 deny>ask>allow 收斂。

### 1.3 權限矩陣（hook × settings 有效判定）

「settings 有效判定」指同一指令命中多條規則後，以 deny>ask>allow 收斂的單一結果。
最終結果＝取 hook 與 settings 兩者中最嚴格者。

| hook ↓ \ settings → | deny | ask | allow | 無命中 |
|---|---|---|---|---|
| **hook `allow`** | 擋下 | 詢問 | 放行 | 放行 |
| **hook `ask`** | 擋下 | 詢問 | **詢問（痛點）** | 詢問 |

本功能**只**把 `(hook=ask, settings=allow)` 這一格從「詢問」改為「放行」：當 builtin 本來要回
`ask`、且該 invocation 命中 settings `allow`（且未命中 deny/ask）時，改回 `allow`。其餘格子不動。

## 2. 目標與非目標

### 目標

- runtime 讀取「專案 `.claude/settings.json`」「專案 `.claude/settings.local.json`」
  「使用者 `~/.claude/settings.json`」三處的 `permissions`，解析其中的 `Bash(...)` 規則。
- 對每個 builtin 會判 `ask` 的 invocation，逐 invocation 比對：命中 `allow` 且未命中 `deny`/`ask`
  → 升級為 `allow`；否則維持 `ask`。
- 全程 fail-safe：任何讀檔／解析失敗都不丟例外，退化為「拿不到該來源規則」（即維持 ask）。

### 非目標（YAGNI，刻意排除）

- 不讀 enterprise managed-settings.json。
- 不對 builtin 已判 `allow` 的指令做 `deny` 降級（Claude Code 自身保證 deny，無安全必要）。
- 不還原帶環境變數賦值前綴（`VAR=val cmd`）的 invocation：此類一律不升級、維持 ask（理由見 §4.2）。
- 不支援 pattern 中段萬用字元（如 `Bash(git * --x)`）或其他 gitignore 式 glob：無法可靠解析的
  pattern 形式一律視為不命中（保守，維持 ask）。
- 不引入快取：hook 每次 Bash 呼叫都是獨立進程，無跨呼叫狀態。

## 3. 架構與資料流

新增邏輯掛在既有管線「classify（逐指令判定）」這一層，不改變 parse / walk / combine 的職責。

```
main.ts
  ├─ resolveProjectRoot(env)                    （既有）
  ├─ loadPermissionRules(env, root)  ← 新增      （讀 3 個 settings，回 PermissionRules）
  └─ evaluate(command, root, initialCwd, rules) ← 新增 rules 參數
        parse → walk → classify(inv, root, rules) → combine
                              └─ builtin 判定為 ask 時，嘗試 settings 升級
```

- **`loadPermissionRules`**：在 `main.ts` 解析完 root 後呼叫一次，結果傳入 `evaluate`，
  再傳入每個 `classify`。所有 invocation 共用同一份規則。
- **fail-safe**：`loadPermissionRules` 內部對每個檔案 try/catch；任何錯誤該檔貢獻空集合。
  最終一定回傳一個合法的 `PermissionRules`（可能三類皆空），永不丟例外、永不回 null。
  空規則時 `classify` 行為與現況完全相同（向後相容）。

## 4. 元件設計

### 4.1 `src/permissions/settings.ts`（載入與合併）

職責：解析三個 settings 檔來源，抽出 `permissions.allow/deny/ask` 中的 `Bash(...)` 規則字串，
各自 union 成三個 pattern 陣列。

型別與簽名（沿用 `src/project.ts` 既有的 `EnvReader`）：

```ts
import type { EnvReader } from "../project.ts";
import type { BashPattern } from "./matcher.ts";

export interface PermissionRules {
  allow: BashPattern[];
  deny: BashPattern[];
  ask: BashPattern[];
}

/** 空規則常數；單一定義於本檔並 export，供 classify.ts / evaluate.ts 作為預設參數。 */
export const EMPTY_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

/** 讀檔器：回傳檔案內容字串；不存在 / 無法讀 → null。注入以利測試。 */
export type ReadText = (path: string) => string | null;

/** 預設讀檔器：任何錯誤（NotFound / 權限 / 路徑為目錄 / I/O）一律吞掉回 null，不區分類型、不重拋。 */
export const defaultReadText: ReadText = (path) => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null; // 全部視為「拿不到此來源」
  }
};

/**
 * 解析三個來源並合併。env 用於解析使用者家目錄。readText 預設為 defaultReadText。
 * 任一檔失敗僅該檔貢獻空集合；本函式永不丟例外、永不回 null。
 */
export function loadPermissionRules(
  env: EnvReader,
  root: string,
  readText?: ReadText,
): PermissionRules;
```

設定檔路徑解析：

- 專案：`${root}/.claude/settings.json`、`${root}/.claude/settings.local.json`
  （`root` 已是正規化的絕對 posix 路徑）。
- 使用者家目錄：Windows 取 `USERPROFILE`（缺則 `HOME`）；非 Windows 取 `HOME`（缺則 `USERPROFILE`）。
  以 `Deno.build.os === "windows"` 判定平台。家目錄解析不到（兩者皆空）→ 略過使用者來源。
  使用者檔路徑由 `${home}/.claude/settings.json` 組成後，**須通過 `scope.ts` 的 `normalizeAbsolute`**
  （與 root 同樣處理）再交給 `readText`。理由：`USERPROFILE` 可能是 `C:\Users\X`（反斜線），而 Git-Bash
  下 `HOME` 可能是 MSYS 形式 `/c/Users/X`；`normalizeAbsolute` 會把兩者都正規化為 `C:/Users/X`
  （MSYS→drive 轉換僅在 Windows 套用），確保都能被 `Deno.readTextFileSync` 開啟。

解析單一檔內容：

- `readText` 回 null → 該檔貢獻空集合。
- `JSON.parse` 失敗 → 該檔貢獻空集合（try/catch）。
- 取 `parsed.permissions`；若非物件 → 空集合。
- 對 `permissions.allow` / `permissions.deny` / `permissions.ask` 各自：若非陣列 → 視為空。
  逐元素：若為字串則交給 `parseBashRule`（見 §4.3）；非字串或解析回 null（非 `Bash(...)`
  或無法解析的形式）則略過。

合併：三類各自把三個來源的 pattern 陣列串接（union；不需去重，重複不影響匹配正確性）。

### 4.2 `src/permissions/matcher.ts`（指令還原與 pattern 匹配）

職責：(a) 把 `CommandInvocation` 還原成可比對的指令字串；(b) 解析 `Bash(...)` 規則字串成
`BashPattern`；(c) 字串對 pattern 的匹配；(d) 綜合判定某 invocation 是否應依 settings 升級。

```ts
import type { CommandInvocation } from "../types.ts";
import type { PermissionRules } from "./settings.ts";
import { staticValue } from "../engine/word.ts";

export type BashPattern =
  | { kind: "exact"; text: string }            // Bash(git status)
  | { kind: "prefix-boundary"; prefix: string } // Bash(x:*) ≡ Bash(x *)：前綴後接空白或結尾
  | { kind: "prefix-loose"; prefix: string };   // Bash(x*)：純前綴、不要求詞界

/**
 * 還原 invocation 為單一指令字串供比對。
 * 規則：name 非 null、無賦值前綴、且每個 argv Word 皆為靜態，才可還原。
 *   - name === null（動態指令名）→ null
 *   - assignments.length > 0（含 VAR=val 前綴）→ null（見下方理由）
 *   - 任一 argv Word 動態（staticValue 回 null）→ null
 * 否則回傳 [name, ...argv 靜態值].join(" ")。重導向不納入還原字串。
 */
export function reconstructCommand(inv: CommandInvocation): string | null;

/** 解析 "Bash(...)" 規則字串；非 Bash(...) 或無法解析的 pattern 形式 → null。 */
export function parseBashRule(rule: string): BashPattern | null;

/** 單一指令字串是否命中某 pattern。 */
export function matchesPattern(cmd: string, pat: BashPattern): boolean;

/** 是否命中任一 pattern。 */
export function matchesAny(cmd: string, pats: BashPattern[]): boolean;

/**
 * 綜合判定：此 invocation 是否應依 settings 升級為 allow。
 *   cmd = reconstructCommand(inv)；null → false
 *   matchesAny(cmd, rules.deny) 或 matchesAny(cmd, rules.ask) → false（完整優先序）
 *   matchesAny(cmd, rules.allow) → true；否則 false
 */
export function settingsAllows(inv: CommandInvocation, rules: PermissionRules): boolean;
```

**賦值前綴不升級的理由**：env 前綴（`LD_PRELOAD`/`BASH_ENV` 等）可改變執行行為，是 builtin 判 ask 的
安全理由之一；且 Claude Code 的 `Bash(cmd:*)` 規則比對的是字面字串，`VAR=x cmd` 字面以 `VAR=` 開頭，
本就不會命中 `cmd:*`。故跳過升級既保守又與 Claude Code 行為一致。

**含未引號 glob 實參不升級的後果**：依 `word.ts`，未引號的 glob 實參（`*` / `?` / `[`，如 `ls *.txt`
的 `*.txt`）會被 `isStatic` 判為動態 → `staticValue` 回 null → `reconstructCommand` 回 null → 一律不升級、
維持 ask（保守，與 default-deny 一致）。注意 settings 規則中的 `*`（如 `Bash(ls *)`）是 **pattern 的萬用字元**，
用來匹配指令前綴，不會被用來放行「指令含展開後 glob 實參」的情形——兩者語意不同，使用者若預期
`Bash(ls *)` 能放行 `ls *.txt` 會落空（但這是安全方向的保守，非 bug）。

**引號與空白**：`staticValue` 回傳的是**去引號後**的字面值，`reconstructCommand` 以單一空白 join、
不重新加引號、不逸出內含空白。故含空白的引號實參與使用者字面不同（`grep "foo bar" f` →
`"grep foo bar f"`），可能無法命中對應 pattern（保守，維持 ask，符合 default-deny）；反向「拆開後多 token
意外命中較寬 pattern」最壞只是輸出一個會被 Claude Code deny/ask 覆蓋的 allow，無安全危害（best-effort 一致性層）。

**型別循環引用**：`settings.ts` 與 `matcher.ts` 互相引用對方的型別（`BashPattern` ↔ `PermissionRules`）。
兩邊**務必都用 `import type`**——僅型別的循環在編譯期被抹除，不產生 runtime 循環；勿改為值匯入，否則會
形成真正的循環相依。`EMPTY_RULES`（值）只單向由 `classify.ts` / `evaluate.ts` 匯入，無循環。

`parseBashRule` 解析步驟：

1. 字串須形如 `Bash(<inner>)`（前綴 `Bash(`、結尾 `)`）；否則回 null（忽略 `Read(...)`、`Edit(...)` 等
   非 Bash 工具規則）。
2. 取出 `<inner>`；若 `inner === ""`（規則為 `Bash()`）→ 回 null（無意義的空規則）。
3. 若 `inner` 以 `:*` 結尾：令 `p` = `inner` 去掉結尾 `":*"`；**若 `p === ""` 或 `p` 含 `*` → 回 null**；
   否則 → `{ kind: "prefix-boundary", prefix: p }`。
4. 否則若 `inner` 以 ` *`（空白接星號）結尾：令 `p` = `inner` 去掉結尾 `" *"`；
   **若 `p === ""` 或 `p` 含 `*` → 回 null**；否則 → `{ kind: "prefix-boundary", prefix: p }`。
5. 否則若 `inner` 以 `*` 結尾（此時必非 `:*` 或 ` *`，已由步驟 3/4 處理）：令 `p` = `inner` 去掉結尾 `"*"`；
   **若 `p === ""` 或 `p` 含 `*` → 回 null**；否則 → `{ kind: "prefix-loose", prefix: p }`。
6. 否則若 `inner` 不含 `*`（步驟 2 已保證非空）→ `{ kind: "exact", text: inner }`。
7. 其餘（中段 `*`、多個 `*` 等無法可靠解析的形式）→ null。

**拒絕空 prefix 至關重要**：`Bash(*)` / `Bash(:*)` / `Bash( *)` 去掉通配後 `p === ""`，若不擋會產生
匹配「所有指令」的 pattern，等於一條規則就把所有 ask 升級為 allow——直接違反本工具「誤 allow 不可接受」
的核心不變量（Claude Code 的 deny/ask 雖仍會擋真正危險者，但本工具自身契約不容許這種放行）。故一律回 null。
同理「prefix 中段含 `*`」（如 `Bash(git * status:*)`）也落到 null，與「中段萬用字元不支援」的非目標自洽。
經此處理後，`matchesPattern` 收到的 `prefix` / `exact text` 必為非空字串。

`matchesPattern` 規則：

- `exact`：`cmd === pat.text`。
- `prefix-boundary`：`cmd === pat.prefix || cmd.startsWith(pat.prefix + " ")`。
- `prefix-loose`：`cmd.startsWith(pat.prefix)`。

**deny/ask 比對為 best-effort 一致性層**：最終 deny/ask 由 Claude Code 強制保證，故比對器對無法解析的
pattern 形式一律當作不命中是可接受的——最壞情況只是我們輸出了會被 Claude Code 覆蓋的 allow，無安全危害。

### 4.3 `src/engine/classify.ts`（整合升級）

把既有判定主體抽成 `classifyBuiltin`，外層 `classify` 在 builtin 判 ask 時嘗試升級：

```ts
import { settingsAllows } from "../permissions/matcher.ts";
import { EMPTY_RULES } from "../permissions/settings.ts";
import type { PermissionRules } from "../permissions/settings.ts";
import { allow } from "../rules/types.ts";

/** 既有判定主體（原 classify 內容原封不動搬入）。 */
function classifyBuiltin(inv: CommandInvocation, root: string): RuleVerdict { /* ... */ }

/** builtin 判定；若為 ask 且命中 settings allow（且未命中 deny/ask）→ 升級為 allow。 */
export function classify(
  inv: CommandInvocation,
  root: string,
  rules: PermissionRules = EMPTY_RULES,
): RuleVerdict {
  const v = classifyBuiltin(inv, root);
  if (v.kind === "allow") return v;
  if (settingsAllows(inv, rules)) return allow();
  return v;
}
```

`rules` 帶預設空集合，既有 `classify(inv, root)` 呼叫（如測試）無須改動即相容。

### 4.4 `src/engine/evaluate.ts`

新增 `rules` 參數（預設空集合）並下傳至 `classify`；其餘流程不變：

完整結構（既有的 fail-safe `try/catch`、`errors` 檢查、no-op 分支一律保留，僅新增 `rules` 參數與下傳）：

```ts
import { EMPTY_RULES } from "../permissions/settings.ts";
import type { PermissionRules } from "../permissions/settings.ts";

export function evaluate(
  command: string,
  root: string,
  initialCwd: CwdState,
  rules: PermissionRules = EMPTY_RULES,
): Decision {
  try {
    const { script, errors } = parseCommand(command);
    if (errors.length > 0) {
      return { verdict: "ask", reason: "指令語法無法可靠解析" };
    }
    const invocations = walk(script, initialCwd, root);
    if (invocations.length === 0) {
      return { verdict: "allow", reason: "無可執行指令（no-op）" };
    }
    return combine(invocations.map((inv) => classify(inv, root, rules)));
  } catch (_err) {
    return { verdict: "ask", reason: "權限檢查器內部錯誤，保守交付人工確認" };
  }
}
```

唯一變更是新增 `rules` 參數並傳入 `classify`；其餘（try/catch fail-safe、語法錯誤 → ask、
no-op allow 訊息 `"無可執行指令（no-op）"`）一律不動。

### 4.5 `src/engine/combine.ts`（allow 訊息正確性）

現行 allow 分支固定回 `"純唯讀指令，全部路徑位於專案內"`。經 settings 升級放行的指令未必唯讀、
未必在專案內，該訊息會失真。改為對兩種放行機制都成立的中性措辭：

```ts
return { verdict: "allow", reason: "全部指令均通過（唯讀放行或命中 permissions.allow）" };
```

現行測試（`combine_test.ts` / `evaluate_test.ts`）均只斷言 `verdict`、未斷言此 allow `reason` 字串，
故改字串不會打破既有斷言；順帶在測試補上對新 reason 的覆蓋（見 §6）。

### 4.6 `src/main.ts`

解析 root 後載入規則並傳入 evaluate：

```ts
const root = resolveProjectRoot(Deno.env);
// ... root === null → ask（不變）...
const rules = loadPermissionRules(Deno.env, root);
decision = evaluate(command, root, initialCwd(input.cwd, root), rules);
```

`loadPermissionRules` 已 fail-safe，不需額外 try/catch；`main` 既有的最外層 try/catch 仍為總兜底。

## 5. 建置與權限旗標（必改）

編譯後 binary 需新增檔案讀取與家目錄環境變數權限，否則讀檔丟例外、功能形同未啟用。`deno.json` build：

```
deno compile --allow-read --allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE --output dist/permission-checker src/main.ts
```

- 新增 `--allow-read`（不限路徑：root 與家目錄皆為 runtime 動態值）。
- `--allow-env` 由單一 `CLAUDE_PROJECT_DIR` 擴充為 `CLAUDE_PROJECT_DIR,HOME,USERPROFILE`。

`test` 任務已含 `--allow-env --allow-read`，無須改動。`main_test.ts` 子行程 e2e 啟動的
`deno run` 指令需同步帶 `--allow-read` 與 `--allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE`，
並透過環境變數指向測試 fixture（見 §6）。

## 6. 測試策略

以依賴注入（`ReadText`、`EnvReader`）與版本控制 fixture 避免 FS 寫入，`test` 任務權限維持不變。

- **`src/permissions/settings_test.ts`**
  - 單檔解析：allow/deny/ask 三類各自抽出 `Bash(...)`；非 `Bash(...)` 規則（`Read(...)` 等）被略過；
    非字串元素被略過。
  - 錯誤容忍：`readText` 回 null（檔不存在）、JSON 壞掉、`permissions` 非物件、三類非陣列 → 各回空集合、不丟例外。
  - 三來源合併（union）：專案 + local + 使用者規則皆併入。
  - 家目錄解析：以注入 `EnvReader` 驗證 Windows 取 `USERPROFILE`、非 Windows 取 `HOME`
    （平台相關斷言用 `Deno.test({ ignore: Deno.build.os !== "windows", ... })` 區分）；
    用記錄請求路徑的假 `readText` 驗證組出的三個路徑正確。
  - fallback：Windows 下 `USERPROFILE` 未設、`HOME` 有值 → 退而取 `HOME`（用記錄路徑的假 `readText` 驗證）。
  - MSYS 家目錄（Windows-only，`ignore: Deno.build.os !== "windows"`）：`HOME=/c/Users/X` 經
    `normalizeAbsolute` 後組出的使用者檔路徑為 `C:/Users/X/.claude/settings.json`。
- **`src/permissions/matcher_test.ts`**
  - `parseBashRule`：`Bash(npm test:*)`→prefix-boundary、`Bash(ls *)`→prefix-boundary、
    `Bash(ls*)`→prefix-loose、`Bash(git status)`→exact、`Read(./x)`→null、`Bash(git * --x)`→null、`Bash(git * status:*)`→null（中段 `*`）、
    `Bash()`→null、`Bash(*)`→null、`Bash(:*)`→null、`Bash( *)`→null（空 prefix，匹配一切，必拒）。
  - `matchesPattern`：boundary 命中 `ls`、`ls -la`，不命中 `lsof`；loose 命中 `lsof`；
    exact 僅命中完全相等。
  - `reconstructCommand`：name+靜態 argv → `"git diff --stat"`；含空白的引號實參去引號後以單空白 join
    （`grep "foo bar" f` → `"grep foo bar f"`）；動態 argv（變數 / `$()` / 未引號 glob）→ null；
    有賦值前綴 → null；動態 name → null。
  - `settingsAllows`：命中 allow → true；同時命中 deny → false；同時命中 ask → false；
    三類皆不命中 → false；`reconstructCommand` 回 null → false。
- **`src/engine/classify_test.ts`（新增案例）**
  - builtin 判 ask 的指令命中 settings allow → 升級 allow。
  - builtin 已 allow 的指令不受 rules 影響（即使 rules 為空或含該指令）。
  - 命中 allow 但同時命中 deny / ask → 維持 ask。
  - 不帶 rules 參數呼叫 → 行為同現況。
- **`src/engine/combine_test.ts`**：現有測試僅斷言 `verdict`、未覆蓋 `reason`；新增一條斷言全 allow 時
  `reason === "全部指令均通過（唯讀放行或命中 permissions.allow）"`，補上對 allow 訊息的覆蓋。
- **`src/engine/evaluate_test.ts`**：複合指令逐 invocation——一筆 builtin-allow + 一筆 settings-allow
  → 整體 allow；其中一筆兩者皆不放行 → 整體 ask（最弱環節）。
- **`src/main_test.ts`（e2e）**：新增 fixture 目錄（版本控制，無需寫檔），內含
  `.claude/settings.json`（含一條 `Bash(...)` allow）；以 `CLAUDE_PROJECT_DIR` 指向該 fixture、
  並設定 `USERPROFILE`/`HOME` 指向另一 fixture 家目錄，驗證原本會 ask 的指令因 settings allow 升級為
  allow，且 `exit 0`。

## 7. Operational verification（改規則後務必做，不可只信單元測試）

`deno task build` 後直接餵 JSON 給 binary，於真實檔案系統驗證：

1. 在某測試專案 `D:/proj/.claude/settings.json` 寫入 `{"permissions":{"allow":["Bash(npm test:*)"]}}`。
2. 餵原本會 ask 的指令，期望 **allow、exit 0**：
   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"npm test --silent"},"cwd":"D:/proj"}' \
     | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe
   ```
3. 改成 `{"permissions":{"allow":["Bash(npm test:*)"],"deny":["Bash(npm test:*)"]}}`，
   餵同一指令，期望維持 **ask**（deny 否決升級）。
4. 餵未列入 allow 的指令（如 `rm -rf x`），期望維持 **ask**。

## 8. 核心不變量（本變更須維持）

- **永不 `deny`、永遠 `exit 0`**：新增邏輯只把 `ask` 升級為 `allow`，不產生 deny。
- **default-deny / 誤 ask 可接受、誤 allow 不可接受**：升級僅在「能靜態還原指令字串 + 命中使用者自寫
  allow + 未命中 deny/ask」三者同時成立時發生；任何不確定（動態 token、無法解析的 pattern、讀檔失敗）
  一律退回 ask。
- **fail-safe**：所有讀檔／解析包在 try/catch，最壞退化為空規則（等同現況）。
