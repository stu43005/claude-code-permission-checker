# 設計規格：讓 research subagent 的唯讀 `gh` CLI 呼叫自動放行

- 日期：2026-09-03
- 狀態：設計（待實作）
- 一句話：修掉三個互相相依的**誤 ask** 根因（超範圍 cwd、endpoint 內 `?` 被當 glob、`grep`/`jq`
  把非路徑位置參數當路徑），使「`cd <專案外> && gh api …?ref=X | jq/grep/head …`」這類純唯讀
  research 指令不再逐一詢問；三個元件皆為 **allowlist 加法**，不放寬任何寫入偵測、不觸碰四類 deny。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，純唯讀且全落專案內才
`allow`，其餘 `ask`，另對四類情形回硬 `deny`（遞迴遍歷磁碟根/家目錄根、整鏈 print-only 偽裝、
sleep 輪詢、名稱重定義）。

實務痛點：research 型 subagent 幾乎整場都在跑唯讀的 `gh api` / `gh search`，但**每一條都被詢問**。

### 1.1 實測基準（以 `dist/permission-checker.exe` 逐條餵 hook JSON 取得，非推論）

取一份 research subagent 的實際指令序列（67 條 Bash 呼叫）作為基準集，全部以
`CLAUDE_PROJECT_DIR` = 該 session 專案根餵給既有 binary：

| 情境 | 結果 |
| --- | --- |
| 原樣 67 條 | **67 ask**，理由全部是「工作目錄超出允許範圍：`D:/`」 |
| 剝掉 `cd /d && ` 前綴後 | 61 ask（60 條為「gh：含動態 token」）、6 allow |
| 再把 `gh api` 的 endpoint 加上引號 | **63 allow**、4 ask |

剩下的 4 條 ask 是本來就該問的：2 條 `for f in …; do gh api …/${f}.go?ref=… ; done`（變數展開）、
1 條 `xargs -I {} sh -c …`、1 條 heredoc 寫檔。

代表性指令形態（下列字面即為基準集內容，供實作與測試直接取用）：

```bash
cd /d && gh api repos/OWNER/REPO/tags?per_page=50 | head -100
cd /d && gh api repos/OWNER/REPO/contents/pkg?ref=v1.18.0 | jq -r '.[] | select(.type=="file") | .name'
cd /d && gh api repos/OWNER/REPO/contents/pkg/x.go?ref=v1.18.0 -H 'Accept: application/vnd.github.raw' 2>&1 | grep -A 10 -B 2 -E 'Retry|backoff'
cd /d && gh api repos/OWNER/REPO/contents/pkg/x.go?ref=v1.18.0 -H 'Accept: application/vnd.github.raw' 2>&1 | wc -l
cd /d && gh api repos/OWNER/REPO/contents/pkg/x.go?ref=v1.18.0 -H 'Accept: application/vnd.github.raw' 2>&1 | sed -n '600,750p'
cd /d && gh search code 'repo:OWNER/REPO SomeSymbol' --language go --limit 10 2>&1
```

### 1.2 三個根因

**根因 1（cwd）**：`cd /d` 是 cmd.exe 的 `cd /d <path>` 習慣被誤搬到 bash——在 Git-Bash 中它等於
`cd D:/`，把 cwd 換到磁碟根。中央前置規則一（`cwd.kind === "known"` 但落在專案根外 → **不可升級**
ask）因此對整條鏈生效。**這條規則本身是對的**，問題在於它對「根本不碰檔案系統的指令」也一律套用。

**根因 2（glob）**：`word.ts` 以詞法方式偵測未加引號的 glob 元字元（`GLOB_CHARS = /[*?[]/`），命中即
視為動態、`staticValue` 回 `null`。`gh api repos/o/r/tags?per_page=50` 的 `?` 因此讓整個 token 變動態，
`gh.ts` 直接回「含動態 token」。此偵測對**路徑**是必要的，但 endpoint 不是檔案系統路徑。

**根因 3（非路徑位置參數）**：`grep` 的 pattern 與 `jq` 的 filter 目前都被當成路徑做 `resolvePath`。
`grep.ts` 的註解明說這是刻意的保守設計（「pattern 通常為相對字串 → 落在專案內 → allow」）；`jq` 則是
被收在 `fileReaderRule` 的 names 裡，filter 落入位置參數。cwd 在專案內時這兩者恰好都解析成專案內而
放行，**一旦 cwd 在專案外就會解析到專案外 → ask**。故根因 3 是根因 1 能否真正生效的前提。

### 1.3 為什麼不能只靠 `permissions.allow`

四條中央前置安全 ask（cwd 超範圍／寫入重導向／賦值前綴／範圍外 `<`）**不可由 `permissions.allow`
升級**（見 `CLAUDE.md`「hook 決策 vs settings.json 權限的優先序」）。因此在 settings.json 加
`Bash(gh api:*)` 對根因 1 完全無效——必須在引擎內處理。

### 1.4 cwd 是否跨 Bash 呼叫繼承（安全前提查證）

若 Claude Code 的 shell cwd 會跨呼叫繼承，則「先跑一條被放行的 `cd /d && gh api …`，下一次呼叫就在
髒 cwd 執行」會是漏洞。實測結果（本機 Claude Code，Git-Bash）：

| 測試 | 觀察 |
| --- | --- |
| `cd /d && pwd` | 輸出 `/d`，工具結果尾端出現 `Shell cwd was reset to D:\claude-code-permission-checker` |
| 上一項之後，下一次呼叫 `pwd` | 輸出專案根 |
| `cd /d && echo … && false`（非零結束碼，未印重設訊息）後，下一次呼叫 `pwd` | 仍為專案根 |
| `pushd /d` | 同樣被重設 |
| 基準集 transcript：67 次 `cd /d` 之後每筆記錄的 `cwd` 欄位 | 恆為專案根（唯一值） |

結論：**cwd 不跨 Bash 呼叫繼承**。但本規格**不把這個 harness 行為當成安全保證**（它未見於官方文件，
且與部分工具說明相衝突），改以 §4.3 護欄 2 在引擎內自行封閉此情境。

## 2. 目標與非目標

### 2.1 目標

1. 「鏈內 `cd` 到專案外 + 純網路唯讀指令 + 純 stdin 過濾器」不再因 cwd 而 ask。
2. `gh` / `curl` 的 endpoint / URL 為「單一 `?` 查詢串」形態（`…/x?k=v`）時不再被判為動態；
   含 `*` / `[` / 多重元字元 / `?` 後含 `/` 者維持 ask（見 §4.2）。
3. `grep` 的 pattern 與 `jq` 的 filter 不再被當作路徑做範圍檢查。
4. 基準集 67 條達成 63 allow / 4 ask（以 build 後 binary 實測驗證）。

### 2.2 非目標

- 不放寬中央前置規則二/三/四（寫入重導向、賦值前綴、範圍外 `<`）。
- 不放寬四類 deny 的任何一類。
- 不新增任何「denylist 式」判定（不列舉危險形式後放行其餘）。
- 不處理變數展開（`${f}`）、`xargs`/`sh -c`、heredoc 寫檔——這些維持 ask。
- 不修 `date` / `file` 既有的「value-flag 路徑值未做範圍檢查」缺口（見 §8.3）。

## 3. 架構與資料流

管線位置（`*` 為本規格改動點）：

```
parse.ts → walk.ts → 閘 1 sleep → 閘 2 名稱重定義 → no-op → 閘 3 printDisguiseDeny → classify.ts → combine.ts
            ^ *1-a                                                                    ^ *1-b
       cwd origin 標記                                                        cwd 豁免判定 + 中央前置

rules/commands/gh.ts   <- *2 nonPathStaticValue
rules/commands/curl.ts <- *2 nonPathStaticValue
rules/commands/grep.ts <- *3 pattern 不做路徑檢查
rules/commands/jq.ts   <- *3 新檔：filter 不做路徑檢查
```

三個元件互相獨立可實作，但**只有三者齊備**基準集才會從 67 ask 變成 63 allow。

## 4. 詳細設計

### 4.1 元件 3：非路徑位置參數（`grep` / `jq`）

#### 4.1.1 已查證事實（本機 binary 實際執行取得，非推測）

**GNU grep 3.0**（`grep --version` / `grep --help`）：

- 用法：`grep [OPTION]... PATTERN [FILE]...`
- `-e, --regexp=PATTERN` 由旗標提供 pattern；`-f, --file=FILE` 由檔案提供 pattern。
- 因此：**未給 `-e` / `-f` 時，第一個位置參數是 PATTERN；給了其中之一時，全部位置參數都是 FILE。**

**jq 1.8.1**（`jq --version` / `jq --help`）：

- 用法：`jq [options] <jq filter> [file...]`；另有 `jq [options] --args <jq filter> [strings...]`
  與 `jq [options] --jsonargs <jq filter> [JSON_TEXTS...]`。
- 無值旗標：`-n/--null-input`、`-R/--raw-input`、`-s/--slurp`、`-c/--compact-output`、
  `-r/--raw-output`、`--raw-output0`、`-j/--join-output`、`-a/--ascii-output`、`-S/--sort-keys`、
  `-C/--color-output`、`-M/--monochrome-output`、`--tab`、`--unbuffered`、`--stream`、
  `--stream-errors`、`--seq`、`--args`、`--jsonargs`、`-e/--exit-status`、`-b/--binary`、
  `-V/--version`、`--build-configuration`、`-h/--help`。
- 吃一個值：`--indent n`（非路徑）、`-f/--from-file`（**路徑**：由檔案載入 filter）、
  `-L/--library-path dir`（**路徑**：模組搜尋目錄）。
- 吃兩個值：`--arg name value`、`--argjson name value`（皆非路徑）；
  `--slurpfile name file`、`--rawfile name file`（**第二個值是路徑**）。
- `--` 終止選項解析。
- jq 的 filter 語言**沒有**寫檔或執行外部程式的構造（無 `system()`、無輸出重導向），故
  **不需要**像 `sed` / `awk` 那樣掃描程式碼找副作用。

#### 4.1.2 `grep` 改動

`factory.ts` 的 `flagGatedReader` 新增選項：

```ts
/** 回 true 時，第一個位置參數視為「非路徑」（如 grep 的 PATTERN），不做範圍檢查。 */
nonPathLeadingPositional?: (argv: Word[]) => boolean;
```

`grep.ts` 傳入的述詞回傳「**未由旗標提供 pattern**」，判定方式（保守方向）：

- 掃描 argv 靜態 token，若出現下列任一則視為「pattern 由旗標提供」→ **不**跳過第一個位置參數：
  `-e`、`--regexp`、`--regexp=…`、`-e…`（黏寫）、`-f`、`--file`、`--file=…`、`-f…`（黏寫）、
  或形如 `-[A-Za-z]+` 的短旗標群集中含 `e` 或 `f`（GNU grep 的 `-ie pattern` 即 `-i -e pattern`）。
- **任一 token 為動態（`staticValue` 回 `null`）時，同樣視為「由旗標提供」**——因為無法確定它是不是
  `-e`。此方向較嚴（多做一次路徑檢查 → 可能多問一次），符合 default-deny。

`-f` / `--file` 的值仍由既有 `pathValueFlags` 做範圍檢查，不變。

安全性：pattern 本來就不是檔案，移除對它的 `resolvePath` **不新增任何檔案存取面**，純粹移除誤 ask。

#### 4.1.3 新增 `src/rules/commands/jq.ts`

`jq` 自 `coreutils.ts` 的 `fileReaderRule` names 中**移除**，改為獨立規則（旗標採 allowlist，
未列入者一律 ask）：

1. 逐 token 掃描；遇到 `--` 之後全部視為位置參數。
2. 無值旗標（上列清單，含短旗標群集逐字母展開）→ 跳過。
3. `--indent`、`--arg`、`--argjson` → 吃掉對應數量的值，值不做路徑檢查。
4. `-f`/`--from-file`、`-L`/`--library-path` → 值做 `resolvePathValue` 範圍檢查；非 `in-project` → ask。
   同時記錄「filter 已由 `-f` 提供」。
5. `--slurpfile`/`--rawfile` → 吃兩個值，**第二個值**做範圍檢查。
6. `--args` / `--jsonargs` → 記錄旗標；其後的位置參數視為字串，**不做路徑檢查**。
7. 未列入 allowlist 的旗標 → `ask`。
8. 位置參數處理：
   - 若 filter 未由 `-f` 提供 → 第一個位置參數是 filter，**不做路徑檢查**。
   - 其餘位置參數：若出現過 `--args`/`--jsonargs` → 視為字串、不檢查；否則視為輸入檔 →
     `resolvePath`，非 `in-project` → ask。
9. 任一 token 動態 → ask。

長短旗標皆需支援 `--opt=value` 與 `--opt value` 兩種寫法。

### 4.2 元件 2：endpoint / URL **操作元**的靜態取值（`gh` / `curl`）

本元件的適用面**限縮到單一操作元**：`gh api` 的 endpoint、`curl` 的 URL。同一條指令中的其他
token（子指令、旗標、旗標值、`-H` header 值等）**一律沿用 `staticValue`**——含未加引號 `?` 者
維持動態 → ask。

由此得到本元件的**強制不變量**（§4.2.5 為其論證，§7.1 為其測試）：

> **被容忍的 `?` 必須嚴格位於「本工具 verdict 所依據的每一個 byte」之後。
> 因此本工具對該指令的判定，對該 token 的任何可能展開結果都相同。**

`src/engine/word.ts` 新增：

```ts
/**
 * 非路徑操作元的靜態取值：僅容忍「單一 `?` 查詢串」形態的未加引號 token
 * （如 gh 的 API endpoint、curl 的 URL）。`*` 與 `[` 一律不容忍。
 * 展開類 part 與含反斜線的未引號 Literal 仍回 null（維持保守）。
 */
export function nonPathStaticValue(word: Word): string | null;
```

判定規則：

- **有 `parts`**：任一 top-level part 為 `DYNAMIC_PART_TYPES`（`SimpleExpansion` /
  `ParameterExpansion` / `CommandExpansion` / `ArithmeticExpansion` / `ProcessSubstitution` /
  `BraceExpansion` / `ExtendedGlob`）→ `null`；`DoubleQuoted` / `LocaleString` 依既有
  `nestedPartIsDynamic` 檢查內層；`Literal` 只在**含反斜線**時算動態。通過後仍須通過下述
  「單一 `?` 查詢串」檢查（引號內的 glob 字元本就不展開，故必然通過，檢查成本為零）。
- **無 `parts`**（未加引號字面值）：仍套用既有的 bash quote removal（`removeBackslashEscapes`），
  再套用「單一 `?` 查詢串」檢查。

**「單一 `?` 查詢串」容忍條件（三項全部成立才容忍，否則回 `null`）**：

1. 值中**未跳脫的 glob 元字元恰好一個**，且該字元是 `?`；`*` 與 `[` 出現即回 `null`。
2. 該 `?` **不在索引 0**（字面前綴非空）。
3. 該 `?` **之後的子字串不含 `/`**（亦不含其他元字元，已由條件 1 保證）。

此形態即 URL / endpoint 的查詢串寫法：`…/tags?per_page=50`、`…/x.go?ref=v1.18.0`、
`https://host/p?q=1`。基準集 60 條與 corpus 中 186 條帶 `?` 的 `gh api` 全部符合。

#### 4.2.1 字面前綴不變量（安全論證的基礎）

bash pathname expansion 有兩條本規格所依賴的性質：

1. **`*` 與 `?` 都不匹配 `/`**（POSIX pathname expansion；`[...]` 亦不含 `/`）。因此展開結果的
   **路徑結構（`/` 的數量與位置）與 pattern 相同**。
2. 展開結果**必定以 pattern 中「第一個未跳脫 glob 元字元之前的字面前綴」開頭**。

由此得到本規格的安全條件：

> **凡安全決策所依據的資訊，必須完全落在字面前綴之內。**

「單一 `?` 查詢串」形態把展開的自由度壓到最小：pattern 形如 `<字面前綴>?<字面後綴>`，其中後綴不含
`/`。因此

- 展開結果必為 `<字面前綴>` + **恰好一個字元** + `<字面後綴>`，長度與結構皆固定；
- 條件 3（`?` 之後不含 `/`）等價於「`?` 位於最後一個 `/` 之後」，故 URL 的 `scheme://host` 與
  endpoint 的所有前段目錄**必然落在字面前綴內**；
- 條件 2 保證前綴非空，故展開結果**不可能以 `-` 開頭**、不會憑空變成旗標。

**各呼叫端仍須各自檢查元字元位置**（見 §4.2.2）作為 defence in depth——條件 3 已涵蓋絕大多數情形，
但無路徑段的 URL（如 `https://ho?t`）不受條件 3 約束，需由 curl 的 authority 護欄擋下。

#### 4.2.2 呼叫端的元字元位置護欄

`word.ts` 一併匯出

```ts
/** 回傳第一個未跳脫 glob 元字元（`*` `?` `[`）的索引；無則回 -1。 */
export function firstGlobMetacharIndex(value: string): number;
```

各呼叫端據此強制「安全決策資訊落在字面前綴內」：

- **`curl.ts`**：對每個 URL 候選值，元字元**必須出現在 authority（`scheme://host[:port]`）之後**——
  亦即 `firstGlobMetacharIndex(u)` 必須大於 `scheme://` 之後第一個 `/` 的索引；否則 `ask`。
  這保證 `resolveUrl` 檢查的 scheme 與 host **完全落在字面前綴內**，展開結果不可能換到別的主機。
- **`gh.ts`**：對 `api` 的 endpoint 操作元，元字元**必須出現在第一個 `/` 之後**；否則 `ask`。
  這保證 endpoint 的第一段（`repos` / `search` / `orgs` …）為字面。

#### 4.2.3 多字展開（multi-word expansion）

一個含 glob 的 word 展開後可能變成**多個 argv word**。本規格對此的處置：

- 所有展開結果共用同一字面前綴，故**沒有任何一個**能以 `-` 開頭 → `ghApiMutates` 的旗標掃描面不會
  被繞過，`curl` 的旗標 allowlist 亦不會被繞過。
- 在「單一 `?` 查詢串」形態下，展開需要 cwd 底下**恰好存在**檔名為 `<字面前綴><任一字元><字面後綴>`
  的檔案；每個展開結果與原 pattern **只差一個字元**，且該字元不可能是 `/`。
- `gh api` 收到多個位置操作元時是**用法錯誤**（gh 自行報錯），不會變成別的請求或寫入操作。
- `curl` 收到多個 URL 時，依 §4.2.1 性質 1、條件 3 與 §4.2.2 的 authority 護欄，這些 URL 的 scheme
  與 host **與已通過網域檢查者相同**，故仍在允許網域內。
- 上述皆須有對應測試（見 §7.1），且測試須包含「在 cwd 實際建立可匹配檔案」的 fixture，證明判定
  只依字面 token、不因檔案系統狀態而改變。

#### 4.2.4 套用點（只針對操作元，不是整條 argv）

兩條規則的取值流程都改為「**先全部 `staticValue`，只對操作元位置做一次補救**」：

`gh.ts`：

1. 對每個 argv token 取 `staticValue`，記下哪些回 `null`。
2. 若**回 `null` 的 token 超過一個** → `ask`（不做補救）。
3. 若子指令（第一個非旗標 token）無法靜態取得 → `ask`。
4. 僅當子指令為 `api`、且唯一的 `null` token 用 `nonPathStaticValue` 可取得值、且該值
   **不以 `-` 開頭**、且它就是 `api` 之後的**第一個位置操作元**（endpoint）時，才採用該值；
   位置不符（例如它其實是某旗標的值）→ `ask`。
5. 對該 endpoint 值套用 §4.2.2 的 `gh` 護欄。

`curl.ts`：

1. 主迴圈維持 `staticValue`；**任何被當作旗標或旗標值消費的 token 為 `null` → 直接 `ask`**
   （旗標與旗標值永不套用寬鬆取值）。
2. 僅當某個 `null` token 落在**位置參數（URL 候選）**位置、且全 argv 只有這一個 `null`、
   且 `nonPathStaticValue` 取得的值不以 `-` 開頭時，才採用該值。
3. 對該 URL 值套用 §4.2.2 的 authority 護欄，再照常送進 `resolveUrl`。

`curl` 對 `{}` `[]` 的既有攔截**不放寬**：那是 curl 自己的 URL 展開語法，由 `resolveUrl` 判為
「形式不安全」而 ask。

其餘所有取值點（路徑相關、旗標、旗標值）**一律沿用 `staticValue`**，不得替換。

#### 4.2.5 verdict 不變量的論證

`gh api`：本工具的判定**完全不讀 endpoint 路徑**——`ghApiMutates` 只掃描旗標
（`-X`/`--method`/`-f`/`-F`/`--field`/`--raw-field`/`--input` 及其黏寫形式）。endpoint token 的
任何展開結果都以非 `-` 的字面前綴開頭（§4.2.1 性質 2 ＋ 容忍條件 2），故**不可能**變成旗標、
不可能改變 `ghApiMutates` 的結果。判定依據的 byte 集合與 endpoint 不相交 → verdict 恆定。

`curl`：本工具的判定依據是旗標 allowlist ＋ `resolveUrl` 的 scheme 與 host。旗標與旗標值不套用
寬鬆取值（§4.2.4），scheme/host 由容忍條件 3（`?` 之後不含 `/`）與 §4.2.2 的 authority 護欄保證
落在字面前綴內。多字展開產生的額外 URL 共用同一 scheme+host，通過同一次網域檢查 → verdict 恆定。

**結論**：argv 確實可能因展開而不同，但**本工具的 allow/ask 判定對所有可能的展開結果完全相同**。
殘餘差異退化為「對同一個已允許主機取得不同的資料」——屬研究結果正確性問題，不是權限判定問題
（記錄於 §9.1）。

### 4.3 元件 1：cwd 無關宣告（放寬中央前置規則一）

#### 4.3.1 型別與宣告

`src/types.ts` 的 `CwdState` `known` 變體新增**可選**欄位：

```ts
| { kind: "known"; path: string; origin?: "chain-cd" } // 已正規化的絕對 posix 路徑
```

- 只有 `src/engine/cwd.ts` 的 `applyPath`（`applyCd` / `gitEffectiveCwd` 的出口）標記
  `origin: "chain-cd"`。
- `src/main.ts` 由 hook JSON 建構的 session cwd **不帶**此欄位。
- **欄位缺席 = 不豁免**（fail-safe）：任何漏標只會多問、不會少問。非測試建構點僅 5 處。

`src/rules/types.ts` 的 `CommandRule` 新增可選述詞：

```ts
/**
 * 此次呼叫的安全判定是否與 cwd 無關，需同時滿足：
 *  (a) 不以 cwd 相對路徑讀取檔案；
 *  (b) 不隱含以 cwd 為操作對象（如 `ls` / `find` 無操作元時作用於 cwd）；
 *  (c) 安全判定所依據的資訊不取決於 shell 對 cwd 的 glob 展開結果
 *      —— 即該資訊完全落在 §4.2.1 定義的「字面前綴」之內。
 * 注意 (c) 是「判定不依賴展開結果」，不是「該指令不含 glob 元字元」：
 * §4.2 容忍的「單一 `?` 查詢串」形態，其 scheme/host/路徑段皆在字面前綴內，
 * 故仍滿足 (c)。
 * 未宣告 = 否（default-deny）。必須為純函式、不得有副作用。
 */
cwdIndependent?(ctx: RuleContext): boolean;
```

#### 4.3.2 `classify.ts` 接線

`classify` 內既有的 inline `RuleContext` 建構抽成具名 const（供 `evaluate` 與 `cwdIndependent`
共用），並在中央前置之前算出豁免旗標：

```ts
/**
 * 護欄 4：argv 必須全為靜態 token。唯一例外是 §4.2 容忍的 endpoint / URL 操作元——
 * 由規則自身在 cwdIndependent 中認定（gh：api 的 endpoint；curl：URL 候選）。
 * 中央側只做「全靜態」的保守判斷，例外由規則側放行。
 */
const allArgvStatic = inv.argv.every((w) => staticValue(w) !== null);

const cwdExempt =
  ruleVerdict?.kind === "allow" &&                 // 護欄 1
  inv.cwd.kind === "known" &&
  inv.cwd.origin === "chain-cd" &&                 // 護欄 2
  (allArgvStatic || (rule?.toleratesNonStaticOperand?.(ctx) ?? false)) && // 護欄 4
  (rule?.cwdIndependent?.(ctx) ?? false);

const central = centralPreflightAsk(inv, scope, cwdExempt);
```

`CommandRule` 因此再加一個可選述詞（未宣告 = 否，default-deny）：

```ts
/**
 * 此次呼叫是否僅含「§4.2 明文容忍且已證明 verdict 不變的 endpoint / URL 操作元」
 * 這一種非靜態 token（其餘 token 皆靜態）。只有 gh / curl 宣告；必須為純函式。
 */
toleratesNonStaticOperand?(ctx: RuleContext): boolean;
```

`centralPreflightAsk` 新增第三參數 `skipCwdCheck: boolean`，**僅**用於跳過規則一；規則二/三/四
不受影響。決策順序其餘部分（步驟 1 動態指令名、步驟 2 rule deny 短路、步驟 4 升級層、步驟 5
rule allow）完全不變。

#### 4.3.3 四道安全護欄

1. **只有指令規則自身回 `allow` 才可能豁免。** 靠 `permissions.allow` 升級的 ask 永不豁免。
   若無此護欄，使用者設了 `Bash(gh:*)` 之後
   `cd /outside && gh api x --input secret.txt` 會被升級成 allow 且跳過 cwd 檢查——這是實質漏洞。
2. **只豁免鏈內 `cd` 造成的 cwd**（`origin === "chain-cd"`）。若 hook 傳入的 session cwd 本身就在
   專案外，代表外部狀態已偏離，一律不豁免、規則一照常 ask。此護欄使 §1.4 的「cwd 若真的跨呼叫
   繼承」情境即使成立也被封住（前提是 harness 如實回報 cwd）。
3. **相對路徑仍以真實 cwd 解析。** 不做「改用專案根解析」這種替換——那會讓
   `cd /other && cat x.txt` 誤判成專案內。有路徑操作元的指令照樣 ask。
4. **該葉指令的 argv 不得含任何非靜態 token。** 具體：豁免要求每個 argv token 的
   `staticValue` 皆非 `null`（即無展開類構造、無未加引號 glob 元字元）；**唯一例外**是
   §4.2 明文容忍、且已通過 verdict 不變量論證的 endpoint / URL 操作元。

   此護欄封住「shell 先展開、指令才拿到結果」這條穿透路徑。若無此護欄：

   - `cd /outside && echo *` —— `echo` 本身不碰檔案系統，但 bash 會先把 `*` 展開成
     `/outside` 的檔名清單，等於**列舉專案外目錄**。
   - `cd /outside && grep *` —— 展開後第一個檔名成為 pattern、其餘成為輸入檔，等於
     **讀取專案外檔案內容**。（`grep pat *` 因 `*` 是第二個位置參數、會做路徑檢查而已被擋，
     但只有一個位置參數時它被當 pattern 跳過，故必須靠本護欄。）

   護欄 4 與 §4.2 的關係：§4.2 容忍的 token **不是路徑操作元**，且已證明 verdict 對其所有展開
   結果不變（§4.2.5）；其餘任何非靜態 token 一律不得享有 cwd 豁免。

#### 4.3.4 宣告清單

**宣告為 cwd 無關（全部仍受 §4.3.3 護欄 4 約束）**：

| 規則 | 宣告條件 | 理由 |
| --- | --- | --- |
| `ghRule` | **僅** `api` 與 `search` 兩個子指令 | 目標由 endpoint / query 明確給定，不看 cwd |
| `curlRule` | 全部 allow 形式 | 只走網路；`-H @file` 由 `resolvePathValue` 以真實 cwd 檢查 |
| `pureUtilRule` | `echo` / `pwd` / `whoami`（**排除 `which`**） | 不接受路徑操作元、不查檔案系統 |

**`ghRule` 必須逐子指令宣告，不可整條規則宣告**：`READ_SUBS` 內的 `repo view`、`issue list` /
`status`、`pr view` / `list` / `status` / `diff` / `checks`、`release view` / `list` 在**未給
`--repo` / `-R`** 時，會以 **cwd 所在的 git repository（及其 remote、當前分支）** 推斷目標倉庫。
因此 `cd /outside && gh pr diff` 查詢的是 `/outside` 那個 repo，而非受保護的專案——這是對 cwd 的
信任邊界依賴，只是依賴的不是本地檔案讀取而是 repo context。`api` 與 `search` 的目標完全由
endpoint / query 決定，不受 cwd 影響，故只有這兩者可豁免。

（本規格**不**額外實作「帶 `--repo` 時也豁免」的例外：基準集與 corpus 中的 research 用法全部是
`gh api` / `gh search`，加上該例外只會擴大判斷面而無實際收益——YAGNI。未宣告者維持現行 ask。）

`pureUtilRule` 的宣告必須寫成排除 `which` 的述詞（`ctx.name !== "which"`），**不可**整條規則
無條件宣告。原因：`which` 依 `PATH` 逐段搜尋可執行檔，而 `PATH` 合法地可能包含 `.` 或空字串段，
兩者都相對於 cwd 解析。若給 `which` cwd 豁免，`cd /outside && which some-name` 就能探測
`/outside/some-name` 是否存在——那是以 cwd 為操作對象的檔案系統查詢，違反 §4.3.1 條件 (b)。
本工具無法靜態得知執行期 `PATH`，故一律不豁免。

**條件宣告（該次呼叫無任何被視為路徑的操作元）**：`flagGatedReader` 新增選項

```ts
/** opt-in：無路徑操作元、非遞迴、未命中 pathValueFlags 時視為 cwd 無關。 */
cwdIndependentWhenNoPaths?: boolean;
/** 上述 opt-in 的例外名單（隱含以 cwd 為操作對象者，如 ls）。 */
cwdDependentNames?: string[];
```

計算式：`cwdIndependentWhenNoPaths === true` **且** 不在 `cwdDependentNames` 內 **且** 該次呼叫
`isRecursive === false` **且** 無 `pathValueFlags` 命中 **且** 需做範圍檢查的位置參數為 0 個。

**單一解析來源（single-parse）契約（強制）**：上述四項條件與 `evaluate` 用來決定 allow/ask 的
argv 解析，**必須來自同一次解析**，不得各自重新掃描 argv。實作方式：`flagGatedReader` 內抽出

```ts
interface ArgvClassification {
  pathOperands: Word[];      // 需做 resolvePath 的位置參數（已扣除 nonPathLeadingPositional）
  pathValueFlagHit: boolean; // 是否命中任一 pathValueFlags
  isRecursive: boolean;
}
function classifyArgv(ctx: RuleContext, opts: FlagGatedReaderOptions): ArgvClassification;
```

`evaluate` 與 `cwdIndependent` **都只讀這個結果**。同一契約套用於：

- `positional-output.ts` 的 `positionalOutputRule`（`uniq` / `xxd`）；
- 手寫述詞的 `sedRule`（沿用既有 `inputPaths`）、`awkRule`（沿用既有 `collectProgram` 回傳的 `pos`）、
  新增的 `jqRule`（沿用其單次掃描結果）。

**為何不改 `RuleVerdict` 契約**：把分類 metadata 塞進 `RuleVerdict` 會強迫 `git` / `deno` / `find` /
`gh` / `curl` 等**不參與 cwd 豁免**的規則一律攜帶用不到的欄位，擴大契約面卻不增加安全性。
在規則內部共用一次解析即可得到同樣的「單一權威解析」保證，且改動面侷限於參與豁免的規則。

**漂移方向分析**：即使兩者仍發生不一致，護欄 1（`ruleVerdict === "allow"` 才可能豁免）使後果受限——
若 `evaluate` 判 ask，無論 `cwdIndependent` 回什麼都不豁免（僅可能多問）。反向不一致
（`evaluate` allow 但 `cwdIndependent` 誤判無路徑）要成立，該路徑操作元必須已被 `resolvePath` 判為
`in-project`；而在專案外的 cwd 下，相對路徑必然解析到專案外 → `evaluate` 早已 ask。故能通過的只剩
**絕對且落在專案內**的路徑——那本來就允許讀取。結論：漂移只會造成多問，不會造成誤放行。

| 規則 | opt-in | 備註 |
| --- | --- | --- |
| `fileReaderRule` | 是 | `cwdDependentNames: ["ls"]`——`ls` 無操作元時列出 cwd |
| `grepRule` | 是 | `rg` 恆為遞迴，計算式自然排除 |
| `sortRule` / `uniqRule` / `xxdRule` / `yqRule` / `tailRule` / `diffRule` | 是 | 無操作元時皆讀 stdin |
| `sedRule` / `awkRule` / `jqRule` | 是（手寫述詞） | 程式碼已與輸入路徑分離；條件為輸入路徑數為 0 |

`uniqRule` / `xxdRule` 出自 `positional-output.ts` 的 `positionalOutputRule`，需在該 factory 內
比照加上同一 opt-in 機制。

**明確不宣告**：

| 規則 | 理由 |
| --- | --- |
| `ls`（`fileReaderRule` 內排除） | 無操作元時列出 cwd |
| `findRule` | `find -name x`（無起始路徑）預設從 cwd 遞迴 |
| `treeRule` | 無操作元時遞迴 cwd |
| `rg`（`grepRule` 內由遞迴條件排除） | 恆為遞迴 |
| `gitRule` / `denoRule` | 以 cwd 決定 repo / 專案 |
| `cdRule` | `cd` 葉指令本身帶的是變更**前**的 cwd，不需豁免 |
| `fileCmdRule`（`file`）/ `dateRule`（`date`） | 其 `valueFlags` 含吃路徑的旗標（`-m`/`-f`、`-r`/`-f`）但未列入 `pathValueFlags`，值目前不做範圍檢查；豁免會擴大該既有缺口（見 §8.3） |

## 5. 核心不變量檢核

| 不變量 | 是否維持 | 說明 |
| --- | --- | --- |
| default-deny | 是 | 三元件皆為 allowlist 加法；未宣告 / 未列入者行為完全不變 |
| deny 四類 | 是 | 閘 1/2/3 仍在 `classify` 之前；遞迴根 deny 仍於 `classify` 內短路 |
| 中央前置規則二/三/四不可升級 | 是 | 不動 |
| 中央前置規則一 | 注意 本次唯一放寬處 | 由 §4.3.3 三道護欄限縮 |
| `permissions.allow` 不能解除 deny | 是 | 不動 |
| 永遠 `exit 0`、例外 → ask | 是 | 不動 |
| `rule.evaluate` / `rule.cwdIndependent` 為純函式 | 是 | 新述詞明訂純函式契約；`classify` 先評估 rule 再做中央前置的既有順序依賴不變 |

## 6. 文件同步

實作完成後同步更新 `CLAUDE.md`：

- 「四條中央前置規則」段落加註規則一的 cwd 豁免條件與三道護欄。
- 「架構（評估管線）」的 `classify.ts` 說明加入 `cwdIndependent` 述詞。
- `scope.ts` / `word.ts` 說明加入 `nonPathStaticValue` 及其「非路徑操作元」適用邊界。
- `rules/` 說明加入新檔 `commands/jq.ts`，並註記 `jq` 已自 `fileReaderRule` 移出。

## 7. 測試計畫

### 7.1 單元測試（allow / ask 兩面 + 邊界）

- `word_test.ts`：`nonPathStaticValue` —— `a?b=1` 回字面值；
  `a*b`、`a[b]c`（含 `*` / `[`）回 `null`；`a?b?c`（兩個 `?`）回 `null`；
  `?abc`（`?` 在索引 0）回 `null`；`a?b/c`（`?` 之後含 `/`）回 `null`；
  `$X`、`$(x)`、`a\b` 回 `null`；引號內容比照 `staticValue`。
  `firstGlobMetacharIndex` —— 無元字元回 `-1`；`\*` 不算；回第一個未跳脫元字元索引。
- `gh_test.ts`：`gh api repos/o/r/tags?per_page=50` → allow；
  `gh api repos/o/r/x?a=1 -X POST` → ask；`gh api ?x` → ask；
  `gh api repos/o/*/x` → ask（含 `*`）；`gh api rep?s/o/r/x` → ask（`?` 之後含 `/`）；
  **操作元限縮**：`gh api x -H Accept:a?b` → ask（旗標值不套用寬鬆取值）；
  `gh issue list --repo o/r?x` → ask（子指令非 `api`）；
  `gh api a?b c?d` → ask（`null` token 超過一個）。
- `curl_test.ts`：允許網域 + `https://host/p?q=1`（未加引號）→ allow；`{}`/`[]` 仍 ask；
  `https://host/a*b` → ask（含 `*`）；`https://ho?t` → ask（authority 護欄）；
  `http?://host/x` → ask（`?` 之後含 `/`）；
  **操作元限縮**：`curl -H Accept:a?b https://host/p` → ask（旗標值不套用寬鬆取值）；
  `curl --max-time 1?0 https://host/p` → ask（同上）。
- **verdict 不變量測試**（§4.2.5）：對同一 endpoint 逐一列出其所有「把 `?` 換成單一字元」的
  可能展開結果，斷言每一個都得到與原 token **相同的 verdict**；`curl` 同理，並額外斷言多個
  展開結果作為多 URL 傳入時 verdict 不變。
- **檔案系統狀態獨立性 fixture 測試**（§4.2.3）：在受測 cwd 底下實際建立可匹配
  `<字面前綴><任一字元><字面後綴>` 的檔案（例如針對 `repos/o/r/tags?per_page=50` 建立
  `repos/o/r/tagsXper_page=50`），斷言判定結果與「該檔案不存在」時**完全相同**，
  證明本工具的決策只依字面 token、不受專案外檔案系統內容影響。
- `grep_test.ts`：`grep -E 'Retry'`（無檔案）→ allow；`grep pat /etc/passwd` → ask（檔案超範圍）；
  `grep -e pat file.txt` → 第一個位置參數視為檔案；`-ie pat file.txt` 群集含 `e` → 同上。
- `jq_test.ts`（新增）：filter 不做路徑檢查；`-f ../outside.jq` → ask；
  `--rawfile n /etc/passwd` → ask；`--arg a b` 不當路徑；`--args` 後位置參數不當路徑；未知旗標 → ask。
- `classify_test.ts`：`cwdIndependent` 三道護欄各自的 allow / ask 兩面。
- **每一條條件宣告規則的 stdin-only 驗收**（涵蓋 §4.3.4 表列全部規則，不只 `grep` / `jq`）：
  對 `cat`、`head`、`wc`、`cut`、`tr`、`nl`、`fold`、`column`、`sort`、`uniq`、`xxd`、`tail`、
  `yq`、`diff`、`sed`、`awk`、`grep`、`jq` 各寫一則 `cd /outside && <cmd> <僅旗標>` → **allow**，
  以及同指令帶一個路徑操作元 → **ask** 的對照，證明 `evaluate` 與 `cwdIndependent` 的單一解析
  在每條規則上都一致。`ls`、`find`、`tree`、`rg`、`git`、`deno`、`file`、`date` 則斷言仍 **ask**。

### 7.2 回歸測試（必須維持 ask / deny）

| 指令 | 期望 | 對應護欄 |
| --- | --- | --- |
| `cd /outside && ls` | ask | `ls` 不宣告 |
| `cd /outside && cat x.txt` | ask | 相對路徑以真實 cwd 解析（護欄 3） |
| `cd /outside && find . -name x` | deny | 遞迴根 deny 不受影響 |
| `cd /outside && find -name x` | ask | `find` 不宣告 |
| `cd /outside && gh api x > out.txt` | ask | 中央前置規則二 |
| `FOO=1 gh api x`（cwd 於專案外，鏈內 cd） | ask | 中央前置規則三 |
| session cwd 本身在專案外 + `gh api x` | ask | 護欄 2 |
| `Bash(gh:*)` 已設定 + `cd /outside && gh api x --input f` | ask | 護欄 1 |
| `cd /outside && grep -r pat .` | deny 或 ask | 遞迴條件排除 |
| `cd /outside && which some-name` | ask | `which` 排除於 `pureUtilRule` 宣告之外（PATH 可含 `.` / 空段） |
| `cd /outside && echo hi` / `pwd` / `whoami` | allow | `pureUtilRule` 其餘三者確實與 cwd 無關 |
| `cd /outside && echo *` | ask | 護欄 4：argv 含非靜態 token（避免列舉專案外目錄） |
| `cd /outside && grep *` | ask | 護欄 4：同上（避免展開成專案外檔案清單） |
| `cd /outside && head -100 *.log` | ask | 護欄 4 ＋ 位置參數路徑檢查 |
| `cd /outside && gh pr diff` | ask | `ghRule` 只宣告 `api` / `search`（repo 由 cwd 推斷） |
| `cd /outside && gh repo view` | ask | 同上 |
| `cd /outside && gh issue list --repo o/r` | ask | 同上（本規格不實作 `--repo` 例外） |
| `cd /outside && gh search code 'x'` | allow | `search` 目標由 query 決定 |

### 7.3 Operational verification

`deno task build` 後，把 §1.1 基準集的 67 條指令逐一以 hook JSON 餵給
`dist/permission-checker.exe`（`CLAUDE_PROJECT_DIR` 設為該 session 專案根），斷言
**63 allow / 4 ask**，且 4 條 ask 分別對應變數展開 ×2、`xargs` ×1、heredoc 寫檔 ×1。

驗證需在**不含**相關 `permissions.allow` 規則的環境進行，以免升級層遮蔽 builtin 分類
（見 `CLAUDE.md` 的 operational verification 注意事項）。

### 7.4 驗收門檻

`deno task check && deno task lint && deno task test` 全綠，且 §7.3 實測數字達標。

## 8. 風險與邊界

### 8.1 中央前置規則一被放寬

這是本規格唯一放寬「不可升級中央前置」的地方。三道護欄使放寬範圍限縮為：
「鏈內 `cd` 造成的 cwd」×「指令規則自身判 allow」×「該規則明確宣告 cwd 無關且本次無路徑操作元」。
三者缺一即回到現行行為。任何新增規則若未宣告 `cwdIndependent`，自動維持現行行為。

### 8.2 `grep` pattern 的 `isDangerousRoot` 掃描維持現狀

`flagGatedReader` 的遞迴根偵測刻意掃描**全部 argv token**（不限位置參數），以免危險根藏在被
value-flag 吃掉的位置。本規格**不改**此掃描，因此 `rg '~' …` 這類「pattern 剛好等於 `~`」的
既有過度 deny 維持不變（安全方向，且與本規格目標無關）。

### 8.3 `date` / `file` 的 value-flag 路徑值未檢查

`dateRule` 的 `-r`/`-f`、`fileCmdRule` 的 `-m`/`-f` 吃路徑但未列入 `pathValueFlags`，其值目前
不做範圍檢查。這是**既有**缺口，本規格不修，但因此**不**替這兩條規則宣告 `cwdIndependent`，
避免在缺口上再疊加 cwd 豁免。

### 8.4 glob 展開的殘餘影響面

`nonPathStaticValue` 讓 `gh api a?b=1` 以字面送進規則判定，但 bash 實際傳給 `gh` 的可能是展開後的
檔名，且可能是多個 argv word。經使用者裁決收緊為「單一 `?` 查詢串」形態後，殘餘影響面為：

- 展開需要 cwd 底下**恰好存在**檔名為 `<字面前綴><任一字元><字面後綴>` 的檔案；
- 每個展開結果與原 token **只差一個字元**，且該字元不可能是 `/`；
- 因此 scheme、host、所有前段路徑皆維持已檢查的字面值，展開**不能**換主機、不能注入旗標、
  不能把 GET 變成寫入；
- 更進一步，依 §4.2.5 的 verdict 不變量，本工具對所有可能展開結果的 allow/ask 判定**完全相同**。

換言之，最壞情況是「對同一個已允許主機取得一個字元不同的 URL 的資料」——是**研究結果正確性**
的問題，不是權限判定的問題。此殘餘面已由使用者在審查中明確接受（見 §9.1）。

### 8.5 未採納的審查建議（記錄理由）

設計審查提出兩項具體做法未照採（其**疑慮本身已處理**）：

1. 「把規則契約改成回傳結構化 metadata（`{ verdict, pathOperandCount, … }`）」——會強迫不參與 cwd
   豁免的規則攜帶用不到的欄位。改以規則內 `classifyArgv` 單一解析達成同樣保證（§4.3.4）。
2. 「cwd 落在專案外時一律拒絕含 glob 元字元的非路徑 token」——**與本規格目標直接衝突**：基準集
   60 條指令的 cwd 正是專案外（`cd /d`），此規則會使功能完全失效。改採同一審查者提出的中間
   方案：收緊為「單一 `?` 查詢串」形態（§4.2），保住全部功能的同時把展開自由度降到一個字元。

## 9. Non-goals / Accepted limitations

### 9.1 「單一 `?` 查詢串」展開仍受 cwd 檔案系統影響（一個字元）

- **Concern**：容忍未加引號的 glob 元字元時，bash 會以（可能在專案外的）cwd 進行 pathname
  expansion，使 `gh` / `curl` 實際收到的 argv 與本工具判定時所見的字面 token 不同；審查者建議
  「cwd 在專案外時一律拒絕 glob 元字元」或完全要求加引號。
- **Decision**：不採用「一律拒絕」，亦不採用「操作元含 glob 即停用 cwd 豁免」。改為
  (a) 收緊成「單一 `?` 查詢串」形態，(b) 適用面限縮到 endpoint / URL **單一操作元**，
  (c) 建立並測試 **verdict 不變量**（§4.2.5）。**接受**其殘餘影響面——執行時取得的 URL 可能
  與指令字面差一個字元。
- **Rationale**（使用者裁決）：「一律拒絕」會使基準集 60/67 條回到 ask、元件 2 等於取消；
  「含 glob 即停用 cwd 豁免」對本基準集效果相同（`cd /d` 與 `?` 同時出現）。而經過 (a)(b)(c)
  之後，殘餘差異已**不影響本工具的權限判定**（verdict 對所有展開結果相同），只可能影響
  research 取得的資料內容；且觸發條件是 cwd 底下恰好存在與 endpoint 僅差一個字元的檔案，
  實務上不會偶發。故取精確化而非取消。

**範圍限定（stale-waiver guard）**：本項接受同時建立在三個前提上——(a) 僅容忍單一 `?` 且其後
不含 `/`；(b) 寬鬆取值只套用於 endpoint / URL 操作元，旗標與旗標值一律不套用；(c) §4.2.5 的
verdict 不變量成立且有測試守護。任一前提日後被放寬（例如開放 `*`、允許 `?` 後含 `/`、對旗標值
套用寬鬆取值、或 verdict 開始依賴 endpoint 路徑），本項不再自動適用，須以新議題重新走審查流程。
