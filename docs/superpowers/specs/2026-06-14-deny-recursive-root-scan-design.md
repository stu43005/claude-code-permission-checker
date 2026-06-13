# 設計規格：對「遞迴遍歷磁碟根 / 家目錄根」的唯讀指令回 `deny`

- 日期：2026-06-14
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，
只在「純唯讀且全部落在當前專案內」時回 `allow`，其餘回 `ask`。自誕生以來的核心不變量是
**永不回 `deny`、永遠 `exit 0`**——危險或無法判定者一律交付人工確認（`ask`），絕不主動阻擋。

### 1.1 痛點

某些唯讀指令即使「不寫檔、不執行外部程式」，仍可能造成實質危害：**直接遞迴遍歷整顆磁碟
（`/`）或整個家目錄（`~`）尋找檔案**，例如：

```bash
find / -type d -name "superpowers*" 2>/dev/null | head -50
```

這類操作會掃描跨專案、跨使用者的大量檔案，是偵察 / 資料外洩的典型前置動作。目前本工具對
`find /` 只會回 `ask`（起始路徑超出專案範圍）——但 `ask` 仍可被人為誤批准，或被 settings.json
的 `permissions.allow`（如 `Bash(find *)`）升級為 `allow` 而靜默放行。使用者要求：**這類遞迴
遍歷磁碟根 / 家目錄根的行為必須直接 `deny`，不可被任何途徑解除。**

### 1.2 已查證的事實（unbash 解析行為，實機驗證）

來源：`npm:unbash@3.0.0`，以 `parse()` 實際解析驗證（信心度：高）。

1. **unbash 不展開 tilde。** `~` 解析為**純字面 Word**（`value: "~"`、無 `parts`）；`~/.claude`、
   `~/foo` 同理（`value` 即整串、無 `parts`）。故 `~` 必須在判定層**詞法偵測**，不能靠變數展開。
2. **`$HOME` / `${HOME}` 是可靜態識別的家目錄根。** 實測結構：
   - `$HOME` → `parts: [{ type: "SimpleExpansion", text: "$HOME" }]`（變數名在 `text` 去掉開頭 `$`）。
   - `${HOME}` → `parts: [{ type: "ParameterExpansion", text: "${HOME}", parameter: "HOME" }]`。
   - `$HOME/foo` → `parts: [SimpleExpansion "$HOME", Literal "/foo"]`（**有子目錄**）。
   - `$HOME/` → `parts: [SimpleExpansion "$HOME", Literal "/"]`（純結尾斜線 = 家目錄本身）。
   - `$HOMER` → `parts: [{ type: "SimpleExpansion", text: "$HOMER" }]`（變數名 `HOMER` ≠ `HOME`）。
   - `$USERPROFILE` → `parts: [{ type: "SimpleExpansion", text: "$USERPROFILE" }]`。
   雖然 `$HOME` 的**值**需 runtime 展開（動態），但「單獨的 `$HOME`/`${HOME}` 恆指向家目錄根」
   這件事**不需展開即可靜態確定**——語義上等同 `~`。
3. **`$HOME/foo`、`$HOMER`、`${HOME:-/x}`（帶修飾子）不可靜態確定為家目錄根**：前者有子目錄、
   中者是不同變數、後者展開結果依預設值而定 → 一律維持動態 → `ask`。

### 1.3 已查證的 Claude Code 語意

`PreToolUse` hook 回 `deny` 的語意（信心度：高，沿用前序規格 2026-06-03 §1.2 之查證）：
hook 的 `permissionDecision: "deny"` 會**阻止該工具呼叫**並把理由回饋給模型，且優先序為
`deny > ask > allow`（most-restrictive-wins）。本工具自身回 `deny` 即可硬性阻擋，且**不被**
`permissions.allow` 升級層解除（見 §5）。

**`permissionDecisionReason` 在 deny 時會回饋給 agent（模型可見）**：依官方 hooks 語義，
`deny` 的 `permissionDecisionReason` 會作為回饋送回模型（`allow` 的 reason 不給模型、`ask` 的
reason 給使用者）。因此 deny 理由**不能只描述操作**（如「這是遞迴遍歷操作」——沒解釋原因），
**必須同時交代：① 被禁止的事、② 為何危險、③ 可行的替代做法**，讓 agent 能理解並改用安全形式
（見 §4.6 deny 理由措辭規範）。

### 1.4 本功能要改的事

把核心不變量從「永不回 `deny`」**收窄**為：**僅當唯讀指令會「遞迴遍歷」一個「恰好等於磁碟根
或家目錄根」的路徑時回 `deny`；其餘一切維持原本的 allow / ask，永不 `deny`。**

## 2. 目標與非目標

### 2.1 設計決策（經使用者確認的四項取捨）

1. **觸發面＝路徑導向**，非指令導向：以「掃描 / 起始路徑落在危險根」為核心條件，跨指令適用，
   而非為單一指令（如 find）寫死。
2. **根的範圍＝恰好等於根**：只認「正規化後恰好等於」磁碟根（`/`、`X:/`）或家目錄根
   （`~`、`$HOME`、家目錄絕對路徑）。任何更深的路徑（`/usr`、`~/.claude`、`~/foo`）**不** `deny`，
   維持原行為。
3. **deny 硬度＝硬 deny、不可解除**：優先序 `deny > ask > allow`。即使使用者在 settings.json 以
   `permissions.allow` 放行該形式也無法解除（`permissions.allow` 升級層只能把 `ask` 變 `allow`，
   永遠碰不到 `deny`）。
4. **觸發條件＝只擋遞迴遍歷**：僅當指令會「遍歷整顆樹」時才 `deny`；非遞迴地碰到根本身
   （`ls -l ~`、`cat /`、`grep / file` 之 pattern）**不** `deny`，維持原 allow / ask。

### 2.2 目標

- 引入第三種 verdict `deny`，貫穿 `Verdict` / `RuleVerdict` / `combine` / `classify` / hook 輸出。
- 在 `scope.ts` 提供「危險根偵測」述詞（含 `~` 字面、lone `$HOME`/`${HOME}` 展開、靜態絕對路徑
  等於磁碟根/家目錄根三種來源）。
- 在 4 個會遞迴遍歷的唯讀指令（`find`、`tree`、`ls`、`grep` 家族）接上遞迴閘門：當「遞迴啟用」
  且「遍歷根參數命中危險根」時回 `deny`。
- `deny` 為硬性：`classify` 在 builtin 回 `deny` 時直接回傳，**不經** `settingsAllows` 升級層。
- 全程 fail-safe：任何例外仍退化為 `ask`、永遠 `exit 0`（既有保證不變）。

### 2.3 非目標（YAGNI，刻意排除）

- **不**擴大到非遞迴指令碰根：`ls -l ~`、`cat /`、`stat /`、`grep / file`、`sed -n p /`、
  `awk '{print}' /` 等一律維持原 allow / ask，不 `deny`。
- **不**擴大到「淺層系統目錄」：`/usr`、`/etc`、`/var`、`/System` 等非恰好根的目錄不 `deny`。
- **不**修正 tilde 一般展開的既有不精確（`~/foo`、`~/.claude` 仍被當作專案內字面路徑 → `allow`）。
  本功能只新增 deny，不改既有 allow/ask 對非根 tilde 路徑的判定。
- **不**處理 `cd ~ && …` / `cd $HOME && …` 的 cwd tilde 追蹤（cwd 變為 `~`/`$HOME` 時，walk 既有
  行為決定 cwd 狀態；本功能不為此新增 cwd 層 deny）。
- **不**為 `find ~ -maxdepth 0`（語義上不遞迴）特別豁免——find 一律視為遞迴，碰根即 `deny`
  （安全方向的 over-deny，罕見且可接受）。
- **不**處理 allowlist 外的指令（如 `du`、`fd`、`rm`）：它們本就 `ask`（未列管），不在本功能範圍。
- **不**引入快取、**不**讀 enterprise managed-settings。

## 3. 架構與資料流

新增邏輯掛在既有管線的兩處：「verdict 模型 + 合併」與「scope 危險根偵測 + 規則遞迴閘門」，
不改 parse / walk 職責。

```
main.ts
  ├─ resolveProjectRoot(env)                                  （既有）
  ├─ homeDir(env)  ← 讀 HOME / USERPROFILE，正規化          （新增）
  ├─ loadPermissionRules(env, root)                           （既有）
  └─ evaluate(command, root, initialCwd, rules, home)         （新增 home 參數）
        └─ classify(inv, root, rules, home)                   （新增 home；deny 短路）
              ├─ classifyBuiltin → CommandRule.evaluate(ctx)  （ctx 新增 isDangerousRoot）
              │     find / tree / ls / grep 家族：遞迴閘門 → deny()
              └─ combine(verdicts[])                          （deny > ask > allow）
```

### 3.1 危險根偵測在哪一層

- **詞法層（不需 env）**：`~` / `~/` 字面、lone `$HOME`/`${HOME}`/`$HOME/` 展開、`$USERPROFILE`
  （僅 Windows）→ 直接判為家目錄根；`/`、`X:/`（磁碟根）由路徑正規化判定。
- **需 home env**：靜態絕對路徑「恰好等於家目錄」（如 `find /Users/alice`）需與 `home` 比對。
  `home` 由 `main.ts` 從 `HOME`（跨平台）/ `USERPROFILE`（Windows）取得，穿入 `ScopeConfig`。
  env 缺失時 `home = null`，此時僅「絕對路徑等於 home」這條失效（退化為 `ask`）；`~`/`$HOME`
  仍可判定（不依賴 env 值）。

## 4. 詳細設計

### 4.1 Verdict 三態化

- `src/types.ts`：`export type Verdict = "allow" | "ask" | "deny";`
- `src/rules/types.ts`：
  - `RuleVerdict` 增加 `| { kind: "deny"; reason: string }`。
  - 新增建構子 `export const deny = (reason: string): RuleVerdict => ({ kind: "deny", reason });`
  - `RuleContext` 增加 `isDangerousRoot(arg: Word): boolean;`
- `src/engine/combine.ts`：優先序改為 **deny > ask > allow**：
  - 先掃一遍：任一 `deny` → 回 `{ verdict: "deny", reason: <首個 deny 理由> }`。
  - 否則任一 `ask` → 回 `{ verdict: "ask", reason: <首個 ask 理由> }`。
  - 否則 → `allow`。
- `src/hook/types.ts` / `src/hook/io.ts`：`Verdict` 已由 `types.ts` 匯入，三態自動涵蓋；
  `renderDecision` 把 `verdict` 直接填入 `permissionDecision`，`deny` → hook 的 `"deny"`。

### 4.2 危險根偵測（`src/engine/scope.ts`）

新增兩個函式 + `ScopeConfig` 增加 `home` 欄位：

```ts
// ScopeConfig 增加：
export interface ScopeConfig {
  root: string;
  home: string | null;   // 新增：正規化後的家目錄絕對路徑，env 缺失為 null
  allow: ReadScope;
  deny: ReadScope;
  ask: ReadScope;
}
// rootScope(root) 一併補 home: null。
```

> **必填欄位的連帶影響**：`home` 為**必填**（與 `root`/`allow`/`deny`/`ask` 一致）。除了
> `rootScope`，既有測試 helper `src/engine/scope_test.ts` 的 `scopeWith`（直接構造 raw
> `ScopeConfig` 字面值、未經 `rootScope`）也必須補 `home: null`，否則 `deno task check` 會因缺
> 必填欄位而失敗。此 helper 更新已列入 §8、§10。`src/engine/classify_test.ts` 的字面值是
> `PermissionRules` 型別（含 `readScope`，非 `ScopeConfig`），**不受影響**。

```ts
/** 已正規化絕對 POSIX 路徑是否為磁碟根（/、X:/）或恰好等於家目錄。 */
export function isDangerousRootAbs(absPosix: string, home: string | null): boolean {
  if (absPosix === "/") return true;
  if (/^[A-Za-z]:\/$/.test(absPosix)) return true;
  if (home !== null && absPosix === normalizeAbsolute(home)) return true;
  return false;
}
```

```ts
/**
 * Word 是否指向「磁碟根 / 家目錄根」：
 *   1) lone home expansion（$HOME / ${HOME} / $HOME/ / $USERPROFILE[Windows]）→ true
 *   2) 字面 ~ 或 ~/                                                          → true
 *   3) 靜態絕對/相對解析後 isDangerousRootAbs                                 → true
 *   其餘（動態、cwd 未知的相對路徑、子目錄）                                  → false
 */
export function dangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean
```

`dangerousRoot` 的判定順序：

1. **lone home expansion**（先於 staticValue，因展開類 Word 的 staticValue 為 null）：
   - `arg.parts` 恰一個 `SimpleExpansion` 且 `part.text.slice(1)` ∈ `homeNames` → true。
   - `arg.parts` 恰一個 `ParameterExpansion` 且 `part.text === "${" + part.parameter + "}"`
     （**純形式、排除 `${HOME:-x}` 等修飾子**）且 `part.parameter` ∈ `homeNames` → true。
     > 任何修飾（operator `:-`/`:=`、index、indirect `!`、length `#` 等）都會讓 `text` 不等於
     > `${<parameter>}`（實測 `${HOME:-/x}` 的 `text` 為 `"${HOME:-/x}"`），故單以 `text` 比對即可
     > 排除所有修飾形式，implementer 不需逐欄位（index/operator/…）檢查。
   - `arg.parts` 為 `[<上述 home expansion>, Literal]` 且該 Literal 的 `value === "/"`（純結尾
     斜線）→ true。
   - `homeNames`：`["HOME"]`；當 `Deno.build.os === "windows"` 時為 `["HOME", "USERPROFILE"]`。
2. **靜態值**：`const v = staticValue(arg);`
   - `v === null` → false（動態，不可確認）。
   - `v === "~" || v === "~/"` → true（家目錄根；unbash 不展開 tilde）。
   - 其餘：沿用既有 `resolvePathValue` 的絕對/相對解析得 `abs`（絕對 → `normalizeAbsolute(v)`；
     相對且 `cwd.kind === "known"` → `resolveAgainst(cwd.path, v)`；`cwd.kind === "unknown"` 的
     相對路徑 → false），再回傳 `isDangerousRootAbs(abs, home)`。

> 註：tilde 偵測只認**恰好** `~` 或 `~/`；`~/foo`、`~/.claude` 的 `value` 為整串、非 `~`，
> 故不命中（維持非根、不 `deny`）。`$HOME/foo` 的 parts 為 `[exp, Literal "/foo"]`，Literal
> 非 `"/"`，故不命中。

WordPart 型別取用：`SimpleExpansion`/`ParameterExpansion`/`Literal` 皆由 `src/deps.ts` 的
`WordPart` union 提供；以 `part.type` 字串窄化後存取 `text` / `parameter` / `value`。

### 4.3 RuleContext 綁定（`src/engine/classify.ts`）

`classifyBuiltin` 改名/簽名擴充以接收 `scope`（已含 `home`），並在建構傳給 `rule.evaluate` 的
ctx 時，新增 `isDangerousRoot`：

```ts
isDangerousRoot: (w) => dangerousRoot(w, inv.cwd, scope.home),
```

`classify` 簽名新增 `home`（或改為從呼叫端組好的 `scope` 取得），並建立含 `home` 的 `ScopeConfig`。
**deny 短路**：

```ts
const v = classifyBuiltin(inv, scope);
if (v.kind === "deny") return v;        // 硬 deny：不經 settingsAllows
if (v.kind === "allow") return v;
if (settingsAllows(inv, rules)) return allow();
return v;                                // ask
```

### 4.4 遞迴閘門接線（4 個指令）

遞迴矩陣（allowlist 內僅這些會遍歷目錄樹）：

| 指令 | 遞迴條件 | 遍歷根參數 |
|---|---|---|
| `find` | 預設遞迴（永遠） | 起始路徑（第一個 `-` 開頭 token 前的位置參數） |
| `tree` | 預設遞迴（永遠） | 位置參數 |
| `ls` | `-R` / `--recursive` | 位置參數 |
| `grep`/`egrep`/`fgrep` | `-r`/`-R`/`--recursive`/`--dereference-recursive`（含短旗標群集如 `-rn`） | 位置參數 |
| `rg` | 預設遞迴（永遠） | 位置參數 |

**(a) `src/rules/commands/find.ts`**：在既有 `starts` 迴圈中，於 `resolvePath` 檢查**之前**插入：

```ts
for (const s of starts) {
  if (ctx.isDangerousRoot(s)) {
    return deny(recursiveRootDenyReason("find", s.value));
  }
}
for (const s of starts) {
  if (ctx.resolvePath(s) !== "in-project") {
    return ask(`find：起始路徑超出專案範圍或無法解析（${s.value}）`);
  }
}
```

（ACTION_FLAGS 寫檔/執行偵測維持在最前，順序：action → deny(根) → ask(範圍)。）

> **`$HOME`/`${HOME}` 為何會進入 `starts`**：`SimpleExpansion`/`ParameterExpansion` 屬
> `word.ts` 的 `DYNAMIC_PART_TYPES`，故 `staticValue($HOME)` 為 `null`。find.ts 的 `starts`
> 蒐集迴圈以 `t !== null && t.startsWith("-")` 判斷是否 break；`t` 為 `null` 時**不** break，
> `$HOME` 因而被收進 `starts`，交由 `isDangerousRoot` 偵測為家目錄根。implementer 不需為
> `$HOME` 在 starts 蒐集上做額外處理。

**(b) `src/rules/factory.ts`**：`FlagGatedReaderOptions` 新增可選 `recursive?: (name: string,
argv: Word[]) => boolean;`。在 `positionals` 迴圈內、於現有 `!== "in-project"` 判斷**之前**插入：

```ts
const isRecursive = opts.recursive?.(ctx.name, ctx.argv) ?? false;
for (const arg of positionals(ctx.argv, valueFlags)) {
  if (isRecursive && ctx.isDangerousRoot(arg)) {
    return deny(recursiveRootDenyReason(ctx.name, arg.value));
  }
  const scope = ctx.resolvePath(arg);
  if (scope !== "in-project") {
    return ask(`${ctx.name}：路徑超出專案範圍或無法靜態解析（${arg.value}）`);
  }
}
```

> 為避免 `isRecursive` 對每個 positional 重複計算，於迴圈外算一次。

**(c) `src/rules/commands/simple-flag.ts` `treeRule`**：新增 `recursive: () => true`。

**(d) `src/rules/commands/coreutils.ts` `fileReaderRule`**：新增
`recursive: (n, a) => n === "ls" && hasAnyFlag(a, [exact("-R", "--recursive")])`。
（`fileReaderRule` 涵蓋 `cat`/`head`/`ls`/… 共用群組；此述詞只讓 `ls` 且帶 `-R` 時遞迴，其餘
指令永遠非遞迴。需 `import { hasAnyFlag } from "../flags.ts"; import { exact } from "../flags.ts";`）

**(e) `src/rules/commands/grep.ts` `grepRule`**：新增
```ts
recursive: (n, a) =>
  n === "rg" ||
  hasAnyFlag(a, [
    exact("-r", "-R", "--recursive", "--dereference-recursive"),
    shortClusterHasR,   // 短旗標群集含 r/R，如 -rn、-Rl
  ]),
```
其中 `shortClusterHasR: FlagMatcher = (t) => /^-[A-Za-z]+$/.test(t) && !t.includes("=") && /[rR]/.test(t.slice(1));`
（僅作用於 grep 家族的遞迴偵測；漏判時退回 `ask`，安全方向。）

> 註：grep 的 `-r` 仍保留在 `VALUE_FLAGS`（rg `--replace` 吃值用）；遞迴偵測獨立掃 argv，與吃值
> 處理互不影響。`grep / file`（pattern `/`，無遞迴旗標）→ `isRecursive` 為 false → 不 `deny`，
> `/` 經 `resolvePath` 落 `out-of-project` → `ask`（維持現況）。

### 4.5 `src/main.ts` 與 `src/engine/evaluate.ts` 穿入 home

- `main.ts`：新增 `homeDir(env): string | null`——讀 `HOME`，否則（Windows）讀 `USERPROFILE`；
  取得後 `normalizeAbsolute(trim)`，空值/未設定 → `null`。把 `home` 傳入 `evaluate(...)`。
- `evaluate.ts`：簽名新增 `home: string | null = null`，向下傳給 `classify(inv, root, rules, home)`。
- build 的 `--allow-env=CLAUDE_PROJECT_DIR,HOME,USERPROFILE` 已含 HOME/USERPROFILE，**無需改**。

### 4.6 deny 理由措辭規範（reason 會回饋給 agent）

因 `deny` 的 `permissionDecisionReason` 會送回模型（見 §1.3），所有 deny 理由**必須**包含三要素：
① 被禁止的事、② 為何危險、③ 可行替代。為統一措辭、避免各處重複，新增共用 helper（置於
`src/rules/types.ts`，與 `deny()` 同檔）：

```ts
/** 產生「遞迴遍歷磁碟根/家目錄根」的 deny 理由（會回饋給 agent，故須解釋原因 + 替代）。 */
export function recursiveRootDenyReason(name: string, target: string): string {
  return `已禁止：${name} 會遞迴遍歷磁碟根或家目錄根（${target}）。` +
    `此操作會掃描跨專案、跨使用者的大量檔案，屬資料外洩 / 偵察的高風險行為。` +
    `請改為指定專案內的具體子目錄（例如 ./src），而非 / 或 ~。`;
}
```

- find.ts、factory.ts 的 deny 一律呼叫 `deny(recursiveRootDenyReason(ctx.name, arg.value))`
  （find 用 `s.value`）。
- **反例（禁止）**：`deny("find：遞迴遍歷磁碟根或家目錄根")`——只描述操作、未解釋為何禁止、
  未給替代，agent 收到後無從理解與修正。

## 5. 與 `permissions.allow` 升級層的互動

- `deny` 在 `classify` 中**先於** `settingsAllows` 判定並短路回傳：builtin 回 `deny` 即定案，
  `permissions.allow`（如 `Bash(find *)`）無法把它升級為 `allow`。符合「硬 deny、不可解除」。
- `permissions.allow` 升級層的職責不變：僅把 builtin 的 `ask` 在命中 allow（且未被 deny/ask）時
  升級為 `allow`，永遠碰不到 `deny`。
- 與 Claude Code 端語意一致：hook `deny` 為 most-restrictive，CC 不會因 `permissions.allow` 而放行。

## 6. 不變量（改動後）

- **default-safe**：未明確判定為安全唯讀的一律 `ask`；新增遞迴指令形式時，未涵蓋者 fallback `ask`。
- **deny 僅限「遞迴遍歷恰好等於磁碟根/家目錄根的唯讀指令」**；其餘一切維持「永不 `deny`」。
- **deny 漏判是安全的**：遞迴偵測或根偵測若漏判（如 grep `-rn` 群集未覆蓋、`home` env 缺失），
  只會退回 `ask`，**絕不**誤放行。故遞迴偵測採「列舉觸發條件」不違反 allowlist 核心原則
  （allowlist 原則約束的是 allow vs ask；deny vs ask 方向漏判退回 ask 仍安全）。
- **永遠 `exit 0`、任何例外 → `ask`**（fail-safe 不變）。
- **只新增 deny，不放寬任何既有判定**：寫入重導向、賦值前綴、非唯讀指令偵測一律不動。

## 7. 行為對照表

| 指令 | 現況 | 之後 |
|---|---|---|
| `find / -type d -name "superpowers*"` | ask | **deny** |
| `find ~` | allow（tilde 誤放行） | **deny** |
| `find $HOME` / `find ${HOME}` / `find $HOME/` | ask（動態） | **deny** |
| `tree ~` / `rg x /` | allow / ask | **deny** |
| `grep -r x /` / `ls -R ~` / `grep -rn foo $HOME` | ask | **deny** |
| `find $USERPROFILE` | ask | Windows → **deny**；Linux → ask |
| `find ~/.claude` / `find ~/foo` | allow | allow（不 deny） |
| `find $HOME/foo`（子目錄，動態） | ask | ask |
| `find $HOMER` / `find ${HOME:-/tmp}` | ask | ask |
| `ls -l ~` / `cat /` / `stat /` | allow / ask / ask | 不變（非遞迴，不 deny） |
| `grep / README.md`（pattern `/`，非遞迴） | ask | ask（不 deny） |
| `find /usr` / `du ~`（du 未列管） | ask | ask |
| `find .`（專案內） | allow | allow |
| `cat README.md && find / -name x`（複合） | ask | **deny**（最弱環節取 deny） |

## 8. 測試需求

每個改動點都需 allow / ask / **deny** 三面 + 邊界測試：

- `combine_test.ts`：deny 優先（deny+ask+allow → deny；ask+allow → ask；全 allow → allow；
  deny 理由取首個）。
- `scope_test.ts`：先更新 `scopeWith` helper 補 `home: null`（否則 `deno task check` 失敗）；
  `isDangerousRootAbs`（`/`、`C:/`、家目錄、`/usr` 否、子目錄否）；
  `dangerousRoot`（`~`、`~/`、`~/foo` 否、lone `$HOME`/`${HOME}`/`$HOME/`、`$HOME/foo` 否、
  `$HOMER` 否、`${HOME:-/x}` 否、靜態絕對等於 home、`home=null` 時絕對家路徑退化否、磁碟根、
  cwd 未知的相對路徑否）。平台相關（`$USERPROFILE`、`X:/`）用
  `Deno.test({ ignore: Deno.build.os !== "windows", ... })` 區分。
- `classify_test.ts`：deny 短路（builtin deny 不被 `settingsAllows` 升級，即使 rules 含
  `Bash(find *)` 仍 deny）。
- `find_test.ts`：`find /`、`find ~`、`find $HOME` → deny；`find ~/.claude`、`find .` → 非 deny；
  `find / -delete` 之 action 偵測仍優先（順序）。deny 理由須含解釋（斷言 reason 含「已禁止」
  與替代建議關鍵字，驗證 §4.6 措辭規範——reason 會回饋給 agent）。
- `types_test.ts`（或併入 find/factory 測試）：`recursiveRootDenyReason(name, target)` 輸出含
  ① 禁止字樣、② 風險說明、③ 替代建議三要素，且包含傳入的 name 與 target。
- `factory_test.ts`（或對應規則測試）：`recursive` 述詞為 true 時 dangerous-root → deny；
  為 false 時 dangerous-root → ask。
- `coreutils_test.ts`：`ls -R ~` → deny；`ls -l ~` → 非 deny；`cat /` → 非 deny。
- `grep_test.ts`：`grep -r x /`、`grep -rn x $HOME`、`rg x ~` → deny；`grep / file`、
  `grep x /`（無 -r）→ 非 deny。
- `simple-flag_test.ts`：`tree ~`、`tree /` → deny；`tree ./sub` → 非 deny。
- `main_test.ts`（e2e 子行程）：餵 `find / -name x` 的 hook JSON，斷言 `permissionDecision: "deny"`
  且 `exit 0`；餵 `find ~/.claude` 斷言非 deny。

**Operational verification（build 後必做）**：

```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"find / -type d -name x"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny、exit 0
echo '{"tool_name":"Bash","tool_input":{"command":"find $HOME -name x"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny
echo '{"tool_name":"Bash","tool_input":{"command":"ls -l ~"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望非 deny
```

## 9. 文件更新（`CLAUDE.md`）

- 把「永不回 `deny`」核心不變量改寫為：**「僅對『遞迴遍歷磁碟根/家目錄根的唯讀指令』回 `deny`；
  其餘維持 allow / ask，永不主動 `deny`。」**
- 「核心不變量」「架構（評估管線）」「三條中央前置規則」段落補上 deny 三態與 `deny > ask > allow`
  優先序、`isDangerousRoot` 述詞、4 指令遞迴閘門、deny 不被 `permissions.allow` 升級的語義。
- 「hook 決策 vs settings.json 權限的優先序」段補：本工具現會主動回 `deny`（硬性、不可由
  `permissions.allow` 解除）。

## 10. 變更檔案清單

| 檔案 | 變更 |
|---|---|
| `src/types.ts` | `Verdict` 加 `"deny"` |
| `src/rules/types.ts` | `RuleVerdict` 加 deny 態、`deny()` ctor、`recursiveRootDenyReason()` helper、`RuleContext.isDangerousRoot` |
| `src/engine/combine.ts` | `deny > ask > allow` |
| `src/engine/scope.ts` | `ScopeConfig.home`、`isDangerousRootAbs`、`dangerousRoot`、`rootScope` 補 home |
| `src/engine/classify.ts` | 綁 `isDangerousRoot`、deny 短路、scope 帶 home |
| `src/engine/evaluate.ts` | 簽名加 `home`，向下傳 |
| `src/main.ts` | `homeDir(env)`，傳入 evaluate |
| `src/rules/factory.ts` | `recursive?` 選項 + 迴圈內 deny |
| `src/rules/commands/find.ts` | starts 的 isDangerousRoot → deny |
| `src/rules/commands/simple-flag.ts` | `treeRule` 加 `recursive: () => true` |
| `src/rules/commands/coreutils.ts` | `fileReaderRule` 加 ls `-R` 遞迴述詞 |
| `src/rules/commands/grep.ts` | `grepRule` 加 grep/rg 遞迴述詞 |
| `src/engine/scope_test.ts` | `scopeWith` helper 補 `home: null`（必填欄位）；新增 `isDangerousRootAbs`/`dangerousRoot` 測試 |
| `CLAUDE.md` | 不變量與管線說明更新 |
| 對應 `*_test.ts` | 三面 + 邊界測試 |
