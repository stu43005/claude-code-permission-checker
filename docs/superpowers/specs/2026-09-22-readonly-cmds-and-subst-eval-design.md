# 唯讀指令 allowlist 擴充 + command substitution 靜態求值

日期：2026-09-22
狀態：設計

## 背景

本工具是 Claude Code 的 `PreToolUse`（matcher: `Bash`）hook，只在「純唯讀且全部落在當前專案內」
時回 `allow`。實際使用中反覆出現四類被詢問、但實為唯讀的指令，以及一個會讓後續判定失準的
cwd 解析缺口。

### 觸發本次設計的實測結果

以當前 binary（commit `65fcec4`）餵入 hook JSON，得到：

| 指令 | 決策 | 理由 |
|---|---|---|
| `gh api … \| base64 -d \| grep … \| head -40` | ask | 未列入 allowlist 的指令：`base64` |
| `test -f node_modules/tarn/README.md && cat … \| head -100` | ask | 未列入 allowlist 的指令：`test` |
| `npm view markdown-it version && npm view marked version` | ask | 未列入 allowlist 的指令：`npm` |
| `cd "$(cygpath -u 'D:/path/to/project')"` | ask | 未列入 allowlist 的指令：`cygpath` |

### cwd 解析缺口

`src/engine/cwd.ts` 的 `applyCd` 只接受靜態 token；參數為 command substitution 時回 `unknown`。
而 `src/engine/classify.ts` 的中央前置規則一只在 `inv.cwd.kind === "known"` 時檢查 cwd 範圍。
兩者相乘產生兩個相反方向的問題，皆經實測確認：

1. **誤殺（本次的主要需求）**：agent 在專案內工作時，把 `cd /d/path/to/project` 寫成
   `cd "$(cygpath -u 'D:/path/to/project')"`，cwd 變 unknown，後續所有相對路徑操作元都解析失敗。
   實測 `cd "$(echo D:/proj)" && cat README.md` → ask（`cat：路徑超出專案範圍或無法靜態解析`），
   而等價的 `cd /d/proj/src && cat main.ts` → allow。

2. **誤放（既有 under-ask）**：把 cd 目標寫成動態即可跳過 cwd 範圍檢查。
   實測 `cd "$(echo D:/外部路徑)" && git log --oneline -3` → **allow**，
   而等價的 `cd D:/外部路徑 && git log --oneline -3` → ask（`工作目錄超出允許範圍`）。

`src/main.ts` 的 `initialCwd` 在缺 `cwd` 欄位時 fallback 到專案根，因此**初始 cwd 恆為 known**；
任何 `unknown` 都必然源自鏈內 `cd` 或 `git -C <動態>`。

## 目標

1. `base64`、`test`、`npm`（唯讀子指令）、`cygpath` 四者的安全唯讀形式自動放行。
2. `cd "$(<可靜態求值的指令>)"` 能推導出具體 cwd，使鏈內後續指令的相對路徑正常解析。
3. 堵住「動態 cd 目標繞過中央前置規則一」的 under-ask 缺口。
4. 修復既有的 tilde 漏洞：未加引號的 `~/…` 路徑操作元目前被當成專案內相對路徑而放行
   （實測 `cat ~/.ssh/id_rsa` → allow），見元件五。

## 非目標

見文末「Non-goals / Accepted limitations」。

## 設計總覽

管線位置（既有管線見 CLAUDE.md「架構（評估管線）」）：

```
parse → walk ─┬─ applyCd ── 新增：staticValue 失敗時改試 evalSubstitutionWord()
              └─ …
           → 閘①②③ → classify ── 中央前置規則一：新增 cwd.kind === "unknown" → ask
                          └─ lookupRule → 新增 4 條規則
```

### 新增檔案

| 檔案 | 職責 |
|---|---|
| `src/engine/subst_eval.ts` | command substitution 靜態求值框架：`SubstEvaluator` 註冊表 + `evalSubstitutionWord` |
| `src/rules/commands/base64.ts` | base64 規則（獨立，不得併入 `fileReaderRule`——理由見元件四） |
| `src/rules/commands/cygpath.ts` | cygpath 指令規則 |
| `src/rules/commands/test.ts` | `test` 規則 |
| `src/rules/commands/npm.ts` | npm 子指令 allowlist |

### 修改檔案

| 檔案 | 改動 |
|---|---|
| `src/engine/cwd.ts` | `applyCd` 取值改為「先 `staticValue`，失敗再試 `evalSubstitutionWord`」；`cd -` / `cd ~` 語義修正 |
| `src/engine/classify.ts` | `centralPreflightAsk` 規則一擴充 `unknown` 分支 |
| `src/engine/scope.ts` | `resolvePath`／`resolvePathValue` 套用 tilde 展開語義（修既有漏洞，見元件五） |
| `src/rules/allowlist.ts` | 註冊四條新規則（`coreutils.ts` 不動） |
| `CLAUDE.md` | 同步管線、不變量與已接受限制 |

## 元件一：求值框架（`src/engine/subst_eval.ts`）

```ts
export interface SubstEvaluator {
  names: string[];
  /** 純函式、不碰檔案系統。argv 為呼叫端已確認的靜態字串；無法求值 → null。 */
  evaluate(argv: string[], cwd: CwdState): string | null;
}

/** 整個 Word 恰為單一 $(…) 且內層可靜態求值時回字串，否則 null。 */
export function evalSubstitutionWord(word: Word, cwd: CwdState): string | null;
```

### 求值成立要件

全部滿足才求值，任一不成立回 `null`（→ cwd unknown → 由規則一 ask）：

1. word 的 `parts` 恰為一個 `DoubleQuoted`，且該 `DoubleQuoted.parts` 恰為一個
   `CommandExpansion`。實測本專案解析器：`cd "$(cygpath -u 'D:/proj')"` 為此形；
   混合形態的 `DoubleQuoted.parts` 會是 `[CommandExpansion, Literal]`
   （`cd "$(echo foo)/sub"`）或 `[Literal, CommandExpansion]`（`cd "pre$(echo foo)"`），
   兩者皆排除。
2. **未加引號的 substitution 一律不求值**，即使其 `parts` 恰為一個 `CommandExpansion`
   （`cd $(echo foo)` 即為此形）。理由：bash 對未加引號的展開結果施以 word splitting 與
   空值移除，語義與「求值成單一字串」不同——`cd $(echo -n)` 展開後是**零個參數**，
   實際執行的是 `cd`（無參數 → `$HOME`），而非 cd 到空字串。求值成空字串再交給
   `applyPath` 會得到「cwd 不變」，與真實行為相反。
3. 內層 `Script` 恰含一個 `Statement`、其 `command` 為單一 `Command`；有 pipeline、`&&`/`;`、
   控制流、重導向或賦值前綴一律不求值。
4. 指令名靜態且命中註冊表。
5. 所有 argv 皆靜態（`staticValue` 非 null），**且無任何 argv 命中下方的
   `hasUnquotedLeadingTilde` 述詞**。此條件對所有求值器一體適用，不由個別求值器各自處理。
6. 註冊的求值器回非 null。
7. 求值結果不含換行字元（多行輸出用作 cd 目標無意義，保守放棄）。
8. 求值結果非空字串。空字串沒有任何安全的解釋：`applyPath` 會把它接成「cwd 不變」，
   而 bash 在加引號時是 cd 到空字串（失敗、cwd 不變）、未加引號時是 cd 到 `$HOME`。
   統一回 `null`。

### 共用述詞：`hasUnquotedLeadingTilde(word)`

tilde 展開在本設計中出現在兩個位置——`cd` 的目標 word（元件二）與求值器的 argv（要件 5）——
語義相同，因此以單一述詞表達，避免兩處判定漂移：

```
hasUnquotedLeadingTilde(word) :=
     (word.parts 為空       且 word.value 以 "~" 開頭)
  || (word.parts 非空       且 word.parts[0] 是 Literal 且其 value 以 "~" 開頭)
```

**只看 `staticValue` 的結果字串永遠不夠**：引號會抑制 tilde expansion，而 `staticValue` 已把引號
資訊抹除。實測三種 word 的 `staticValue` 都不足以區分：

| word | `parts` | `staticValue` | bash 實際 |
|---|---|---|---|
| `~/src` | `[]` | `~/src` | 展開為 `$HOME/src` |
| `"~"` | `["DoubleQuoted"]` | `~` | **不**展開，相對子目錄 `./~` |
| `~/"src"` | `["Literal(~/)", "DoubleQuoted"]` | `~/src` | 開頭 `~` **仍**展開 → `$HOME/src` |

第三列是混合形態，第一個 part 未加引號，因此述詞的第二個分支不可省略。此形態同樣會出現在
substitution 內層：實測 `cd "$(echo ~/"src")"` 的內層 argv[0] 即為該結構、`staticValue` 回
`~/src`；外層 substitution 的雙引號**不會**抑制內層的 tilde expansion。

### 支援展開的 tilde 形態

述詞命中只代表「這個 token 會被 bash 做 tilde expansion」，**不代表本設計知道它展開成什麼**。
僅以下兩種形態有明確、可靜態決定的展開結果：

- `~`（整個 token 就是 `~`）→ home
- `~/<rest>` → home + `/<rest>`

其餘一切形態一律視為**不可解析**（`cd` → `UNKNOWN`；路徑操作元 → 超出讀取範圍 → ask），
包括：

- `~<username>`（展開為該使用者的 home，本工具無從得知其他使用者的 home 路徑）
- `~+`（展開為 `$PWD`）、`~-`（展開為 `$OLDPWD`，靜態不可知）
- `~+<N>` / `~-<N>` / `~<N>`（directory stack 項目）

實作上必須明確列出這兩種支援形態並對其餘回退，不可寫成「以 `~` 開頭就當 home」——那會把
`~otheruser/x` 錯誤地映射到當前使用者的 home，並據此做出範圍判定。

home 未知時（環境變數缺失），支援形態同樣退回不可解析，絕不退回「當成相對路徑」。

### shell home 與 settings home 是兩個不同的值

tilde 展開必須用 **bash 的 home**，即 `HOME` 環境變數——不可沿用既有的 `resolveHome`。
`src/permissions/settings.ts` 的 `resolveHome` 在 Windows 上**優先 `USERPROFILE`**、
`HOME` 只是 fallback；而 bash 的 tilde expansion 只看 `HOME`。

兩者在典型 Git Bash 環境下正規化後相同（實測本機 `HOME=/c/Users/A35214`、
`USERPROFILE=C:\Users\A35214`，經 `normalizeAbsolute` 皆為 `C:/Users/A35214`），但這是環境巧合
而非保證：Git Bash 允許自訂 `HOME`。兩者不同時會產生具體的誤放行——使用者設了
`Read(~/cache/**)`（其 `~` 由 `resolveHome` 解為 `USERPROFILE/cache`），而指令 `cat ~/cache/x`
實際讀的是 `HOME/cache/x`；若展開時誤用 `resolveHome`，就會拿「已授權的 USERPROFILE 路徑」
去核准「未授權的 HOME 路徑」。

因此：

- **shell home**（本設計的 tilde 展開，含 `cd` 目標與路徑操作元）：只讀 `HOME`；
  未設定或為空 → 不可解析（`cd` → `UNKNOWN`；路徑操作元 → 超出範圍 → ask）
- **settings home**（`Read(~/…)` 等權限規則、`<home>/.claude` 的定位）：維持既有 `resolveHome`，
  語義不變

`HOME` 已在 `deno task build` 的 `--allow-env` 清單中，無需調整編譯權限。

### 註冊成員與各自的求值邊界

各成員的邊界依據見「查證依據」節。設計原則：**只要輸出可能取決於檔案系統狀態、環境變數、
或執行期 shell 選項，一律回 `null`**。

#### cygpath

**僅在 `Deno.build.os === "windows"` 啟用**，非 Windows 平台一律回 `null`。理由：cygpath 是
Cygwin/MSYS2 工具，在 Linux/macOS 不存在；而求值所依賴的「`/d/x` 與 `D:/x` 等價」這條性質，
正是 `scope.ts` 的 `normalizeAbsolute` 僅在 Windows 套用的磁碟機正規化（Linux 上 `/d/x` 是真實
POSIX 路徑，兩者不可混同）。

可求值旗標：`-u`、`-w`、`-m`、`-t unix|windows|mixed`、`-a`、`-C <cp>`、`-i`。

求值結果即「操作元路徑原樣」：`-u`/`-w`/`-m` 三者只改變磁碟機與斜線的書寫形式，而
`applyPath` 隨即呼叫 `normalizeAbsolute`，`D:/x`、`D:\x`、`/d/x` 在 Windows 上會正規化成同一字串，
故不需實作實際的字元轉換。`-a` 額外要求 cwd 為 known（相對路徑以 cwd 展開）。

不可求值旗標（回 `null`）：

- 查檔案系統：`-d`、`-t dos`、`-s`（DOS 8.3 短名）、`-l`（長名還原）、`-M`（binary/text）
- 輸出與輸入無關：`-D`/`-H`/`-O`/`-P`/`-S`/`-W`/`-F`/`-A`
- 讀檔取操作元／選項：`-f`、`-o`
- 輸出形式與 `normalizeAbsolute` 不保證等價：`-U`（`/proc/cygdrive/…`）、`-r`（`\\?\…`）、
  `-p`（PATH 列表，非單一路徑）

未知旗標亦回 `null`。

操作元必須恰為一個。

#### dirname / basename

純字串運算，無平台限制。語義：

- `dirname`：去除尾斜線後取父段；`/`→`/`、`/a`→`/`、`/a/b/`→`/a`、`a`→`.`、空字串→`.`、
  `/a//b`→`/a`、`./a`→`.`。
- `basename`：去除尾斜線後取末段，可選再移除後綴；`/`→`/`、`/a/b/`→`b`、`a`→`a`、
  `/a/b.txt .txt`→`b`。

可求值形態：`dirname <NAME>`（恰一操作元、無旗標）、`basename <NAME>`、
`basename <NAME> <SUFFIX>`、`basename -s <SUFFIX> <NAME>`。多操作元（含 `-a`/`--multiple`）與
`-z`/`--zero`（以 NUL 分隔）一律回 `null`。

#### pwd

`cwd.kind === "known"` 時回 `cwd.path`，否則 `null`。帶任何旗標（含 `-P`，解 symlink）回 `null`。

#### echo

可求值形態：無旗標、或僅帶 `-n`；**且所有操作元皆不含反斜線字元**。輸出為操作元以單一空格
join。

反斜線的限制是必要的：bash 的 `xpg_echo` shopt 若為 on，builtin `echo` 預設就會解釋反斜線跳脫，
而該 shopt 是執行期 shell 狀態、靜態不可知。操作元不含反斜線時兩種狀態結果一致，才可安全求值。
帶 `-e`（明確啟用跳脫）一律回 `null`。

`-n` 不影響求值結果：command substitution 本就會剝除尾端換行。

#### printf

可求值形態（皆要求格式字串與操作元不含反斜線）：

- `printf '%s' <ARG>`（恰一操作元）
- 格式字串不含 `%` 也不含反斜線、且無操作元時，回該字面字串

其餘一律 `null`。與 echo 相反，printf 的**格式字串永遠解釋反斜線**（即使不含 `%`），
故「純字面格式」不等於原樣輸出，必須排除含反斜線者。`%b`、`%q`、`-v`、以及格式字串重複套用
多個操作元的形態一律不求值。

## 元件二：cwd 接線與 `cd` 語義修正（`src/engine/cwd.ts`）

`applyCd` 的取值改為：

```
val = staticValue(suffix[0]) ?? evalSubstitutionWord(suffix[0], cwd)
val === null → UNKNOWN
```

同時修正兩個既有缺陷。目前 `staticValue` 對 `-` 與 `~` 分別回字面 `"-"` 與 `"~"`，被 `applyPath`
當成相對路徑接成 `<cwd>/-`、`<cwd>/~`——這會讓 cwd 被判定成一個**專案內的錯誤路徑**而放行。改為：

- `cd -`：回上一個工作目錄，靜態不可知 → `UNKNOWN`
- `cd ~` / `cd ~/<rest>`：home 已知時解析為 home（或 home + rest），home 未知 → `UNKNOWN`

**tilde 展開必須依 word 結構判定，不能只看結果字串**，依據與對照表見元件一的
`hasUnquotedLeadingTilde`。`cd` 目標套用該述詞的方式為：

- 命中述詞、`parts` 為空（未加引號的純字面 token）、**且形態為「支援展開的 tilde 形態」之一**
  → 以 **shell home**（`HOME`）展開（未設定時 `UNKNOWN`）。`~user`、`~+`、`~-` 等其餘形態
  → `UNKNOWN`
- 命中述詞、但 `parts` 非空（混合引號形態，如 `cd ~/"src"`）→ `UNKNOWN`。開頭未加引號的 `~`
  會被 bash 展開、後段卻是引號內容；正確模擬需逐 part 重建語義，超出本設計範圍，故保守放棄。
- 未命中述詞（整體被引號包裝、或由 substitution 產生的字面 `~`）→ **維持既有相對路徑語義**
  （`<cwd>/~`），該行為對這些情形本就是正確的

（`cd` 無參數已是 `UNKNOWN`，不變。）

## 元件三：中央前置規則一擴充（`src/engine/classify.ts`）

`centralPreflightAsk` 的規則一改為：`skipCwdCheck` 為 false 時，除既有的
「`known` 但不在允許範圍 → ask」外，新增「`cwd.kind === "unknown"` → ask」。

理由：初始 cwd 恆為 known，故 unknown 必然源自鏈內 `cd`（或 `git -C <動態>`）——即「指令將在一個
本工具無法確定的目錄執行」，這正是規則一要防的情形。

此 ask 與規則一既有行為一致，屬**不可升級**的中央前置 ask。cwd 豁免路徑不受影響：五道護欄的
第 (2) 條本就要求 `inv.cwd.kind === "known"` 且 `origin === "chain-cd"`，unknown 永遠無法滿足，
故 `skipCwdCheck` 在 unknown 下恆為 false，無需額外處理。

## 元件四：四條 allowlist 規則

### base64（獨立規則，`src/rules/commands/base64.ts`）

**不得併入 `fileReaderRule`。** `base64` 的 `-w`/`--wrap` 吃一個整數值，若把它加進
`fileReaderRule` 的 `valueFlags`，該設定會套用到該規則的**全部** `names`——而
GNU `md5sum`/`sha256sum` 的 `-w` 是 `--warn`（不吃值，警告格式錯誤的 checksum 行）。
屆時 `md5sum -c -w /outside/checksums` 的 `/outside/checksums` 會被 `positionals()` 當成
value-flag 的值而跳過，失去唯一的路徑操作元、在專案內 cwd 下取得 allow，但 md5sum 實際會讀取
該外部檔。這是對既有指令的安全回歸。

改為獨立規則，以 `CommandSpec` 描述旗標（每個旗標只描述一次、只作用於本規則）：

- `-d`/`--decode`、`-i`/`--ignore-garbage`：`value: "none"`
- `-w`/`--wrap`：`value: "required"`（不是路徑，故不設 `valueIsPath`）
- `positionals: "paths"`：位置參數是要讀取的檔案，做範圍檢查

`base64` 無任何輸出到檔案的旗標，輸出恆為 stdout，故不需 `askFlags`。未知旗標由 `CommandSpec`
路徑自動 ask。

不宣告 `cwdIndependent`：有路徑操作元時依賴 cwd 解析。

### test（`src/rules/commands/test.ts`）

只允許「單一一元檔案測試運算子 + 一個操作元」形態：argv 恰為 2 個 token，第一個屬於運算子集合，
第二個做 `resolvePath` 範圍檢查。

運算子集合：`-b -c -d -e -f -g -h -k -L -p -r -s -S -u -w -x -O -G -N`。

明確排除（→ ask）：

- `-a`：一元時是 `-e` 的舊別名、二元時是邏輯 AND，語義由參數個數決定，排除以免歧義
- `-o`：一元時測試 shell option、二元時是邏輯 OR，同上
- `-t`：操作元是 fd 整數，不是路徑
- `-n`/`-z`、`-v`/`-R`：操作元分別是字串與變數名，不是路徑
- 所有二元運算子（`=`、`-eq`、`-nt` 等）、邏輯運算子（`!`、`(`、`)`）、多運算子組合
- argv 少於或多於 2 個的一切形態（含 `test -f` 單參數——POSIX 下它是「非空字串測試」而非檔案測試）

不宣告 `cwdIndependent`：操作元為相對路徑時依賴 cwd 解析。

### npm（`src/rules/commands/npm.ts`）

比照 `git.ts` 的子指令 allowlist 結構：維護唯讀子指令集合，集合內才 allow、其餘 ask。

**allowlist 的判準是「不探索本機專案」**，比「唯讀」更嚴格。npm 對本機查詢類子指令會沿目錄樹
**向上**尋找 package.json 決定 effective prefix，並讀取該處的 package.json / .npmrc——那個位置
可能在允許範圍之外，且沒有任何操作元可供本工具檢查（詳見「查證依據」的實測）。

**允許的子指令**：

- `view`、`info`、`show`、`v`：**必須帶至少一個操作元**。無操作元時 npm 改為檢視「當前專案」，
  即觸發上述向上探索，故無操作元形態一律 ask。
- `ping`：僅測試 registry 連線。
- `whoami`：輸出登入帳號名（不輸出憑證內容）。

**無子指令形態**：僅 `npm --version` / `npm -v` allow。

其餘一律 ask，包括 `ls`/`list`/`la`/`ll`、`outdated`、`explain`/`why`、`root`、`prefix`、
`pkg get`、`config get`/`get`——這些都依賴本機專案探索。`config get` 另有獨立風險：它讀取的
`.npmrc` 層級同樣經向上探索決定，而 `.npmrc` 可能含 registry auth token 設定。

**旗標 allowlist**（未知旗標一律 ask，如此亦免疫 npm 版本漂移）。範圍縮小後只保留對
`view`/`ping`/`whoami` 有意義者：
`--json`/`-j`、`--long`/`-l`、`--parseable`/`-p`、`--unicode`/`--no-unicode`、
`--color`/`--no-color`、`--offline`、`--prefer-offline`、`--prefer-online`、`--otp <code>`。

`--depth`、`--omit`、`--include`、`--all`、`--package-lock-only` 只對已移除的本機查詢子指令有
意義，不納入；`-w`/`--workspace` 更是直接指向本機專案探索，一律 ask。

明確 ask 的旗標（會改變讀寫位置或由誰執行什麼程式）：`--prefix`、`--userconfig`、
`--globalconfig`、`--cache`、`--script-shell`、`--node-options`、`--editor`、`-g`/`--global`、
`--foreground-scripts`、`--registry`。

**位置參數必須是 registry package spec，否則 ask**。不可無條件豁免路徑檢查：npm 以
`npm-package-arg` 解析操作元，除 registry spec 外也接受目錄、檔案、tarball、URL 與 git spec，
並會實際讀取本機目標。實測 `npm view <含 package.json 的任意目錄>` 會**讀取並印出該目錄
package.json 的內容**（name、version、description 等），構成呼叫者指定的專案外讀取——這超出
「npm 自身 cache/log」的已接受例外。

因此操作元必須匹配嚴格的 registry package spec 形態才 allow：

- 可選的 scope 前綴 `@<scope>/`，其後一個套件名
- 可選的 `@<version|range|tag>` 後綴
- **不得**以 `.`、`/`、`~`、`-` 開頭；不得含 `\`、`:`（排除 `file:`、`http(s):`、`git+ssh:`、
  磁碟機字母如 `C:`）；除 scope 的那一個 `/` 外不得再含 `/`

不符者一律 ask，不嘗試對其做 `resolvePath`——本規則的立場是「只認得套件名」，路徑形態交給使用者
確認。動態 token 一律 ask（不臆測其展開結果）。

### cygpath（`src/rules/commands/cygpath.ts`）

旗標 allowlist，依「是否查詢檔案系統」分為兩類形態，兩類的操作元處理與 cwd 豁免資格不同。
不分類會產生自相矛盾的契約：既宣告 `cwdIndependent`（跳過中央前置規則一）、又聲稱操作元受規則一
約束，兩者不可能同時成立。

注意「可執行 allow」與「可靜態求值」（元件一）是兩個不同的集合，前者是後者的超集：
`-U`、`-r`、`-p` 不碰檔案系統、執行上安全，但其輸出形式（`/proc/cygdrive/…`、`\\?\…`、
PATH 列表）無法保證與 `normalizeAbsolute` 等價，故不可用於 cwd 求值。

**形態 A — 純字串轉換**（不碰檔案系統）：
`-u`、`-w`、`-m`、`-t unix|windows|mixed`、`-a`、`-C <cp>`、`-i`、`-U`、`-r`、`-p`、`-h`、`-V`

- 操作元**不做**路徑範圍檢查：cygpath 在此形態下只做路徑字串的書寫形式轉換，不開檔、不讀內容，
  也不回報該路徑的任何檔案系統狀態，因此不洩漏「路徑字串本身」以外的資訊——而該字串是使用者
  自己打進指令的。
- 宣告 `cwdIndependent`：判定完全不依賴 cwd。

**形態 B — 查詢檔案系統 metadata**：`-d`、`-t dos`、`-s`（8.3 短名，需查檔案系統，
路徑不存在時 exit 2）、`-l`（長名還原，實測 `cygpath -w -l '/c/PROGRA~1'` → `C:\Program Files`，
需查檔案系統才能還原；路徑不存在時原樣輸出）、`-M`（回報 binary/text）

- 操作元**必須**做 `resolvePath` 範圍檢查：這些形態會回報專案外路徑的存在性與屬性，
  與 `test -e` 同等級的資訊洩漏。
- **不宣告** `cwdIndependent`：相對路徑操作元依賴 cwd 解析。

**形態 C — 輸出系統目錄**（不吃路徑操作元）：`-D`、`-H`、`-O`、`-P`、`-S`、`-W`、`-F <id>`、`-A`

- 輸出與輸入無關，不接受路徑操作元；allow，並宣告 `cwdIndependent`。

**一律 ask**：`-f`（從檔案／stdin 讀取操作元）、`-o`（從檔案讀取選項）、`-c`（關閉 HANDLE，
屬行程管理而非路徑轉換）、任何未知旗標。

`cwdIndependent` 以述詞形式實作（依本次呼叫的旗標動態判定），形態 B 出現時回 false。

## 元件五：路徑操作元的 tilde 展開（`src/engine/scope.ts`）

### 這修的是一個既有漏洞

`resolvePath` 目前對未加引號的 `~/…` 走 `staticValue` 取回字面字串 `~/…`，再當成**相對路徑**
接到 cwd 上，於是判定為專案內而放行；bash 實際讀的卻是 `$HOME/…`。實測當前 binary：

| 指令 | 目前決策 |
|---|---|
| `cat ~/secret` | **allow** |
| `cat ~/.ssh/id_rsa` | **allow** |
| `grep x ~/secret` | **allow** |
| `head -5 ~/secret` | **allow** |
| `cat "~/secret"` | allow（**正確**：引號抑制展開，實際讀 `./~/secret`，確實在專案內） |

影響所有 allowlist 內接受路徑操作元的規則，不限本次新增者。本次納入修復，因為：設計已為了 cd
與求值器建立 tilde 語義與述詞，複用成本極低；且若不修，新增的 `test` 與 `base64` 規則會把同一個
漏洞擴大到更多指令（`test -f ~/.ssh/id_rsa`、`base64 ~/.ssh/id_rsa`）。

### 行為

`resolvePath(word, …)` 在解析前先套用 tilde 語義：

- word 命中 `hasUnquotedLeadingTilde`：
  - 形態屬「支援展開的 tilde 形態」且 **shell home**（`HOME`，見上節）已知 → **展開為絕對路徑**
    後再做既有的範圍判定。
    展開後通常落在專案外 → `out-of-project` → ask；若使用者以 `Read(~/cache/**)` 之類規則
    明示放寬，展開後會正確命中該範圍而放行——這是修復帶來的附帶正確性。
  - 其餘形態（`~user`/`~+`/`~-`）或 shell home 未知 → `out-of-project`。
    **絕不退回「當成相對路徑」**，那正是漏洞本身。
- 未命中述詞（引號包裝的字面 `~`）→ 既有相對路徑行為不變，該行為本就正確。

`resolvePathValue(value: string, …)` 只拿得到字串、沒有 word 結構，無從判斷引號。因此採
fail-closed：**字串以 `~` 開頭一律視為超出讀取範圍**。代價是引號形態的 `--flag="~/x"`
（真正指向 `./~/x`）會被誤 ask；此形態罕見，且方向安全。

此修復與既有的 `dangerousRoot`（已把字面 `~`/`~/` 視為危險根、用於遞迴指令 deny）語義一致，
兩者不衝突：`dangerousRoot` 管遞迴掃描的 deny，本元件管一般路徑操作元的範圍判定。

## 錯誤處理

沿用既有 fail-safe 契約，不新增例外路徑：

- `evalSubstitutionWord` 為純函式、不碰檔案系統；任何無法確定的情形回 `null`，退化為既有的
  `UNKNOWN` cwd 行為（再由規則一 ask）。
- 求值器不得丟例外；`evaluate` 外層既有的 try/catch 仍是最後防線（回 ask）。
- 三條新規則的未涵蓋形態一律 `ask`，維持 default-deny。

## 測試策略

- **求值框架層**（`subst_eval_test.ts`）：以下各自回 `null`——混合 word
  （`"$(echo foo)/sub"`、`"pre$(echo foo)"`）、**未加引號的 substitution**（`$(echo foo)`）、
  pipeline／多 statement、重導向、賦值前綴、動態 argv、未註冊指令名、含換行的求值結果、
  **空字串求值結果**（`"$(echo -n)"`）、**argv 命中 `hasUnquotedLeadingTilde`**——
  含 `parts` 為空形態（`"$(echo ~)"`、`"$(echo ~/x)"`）與**混合引號形態**
  （`"$(echo ~/"src")"`）。正面案例：`"$(cygpath -u 'D:/proj')"` 求出路徑；
  `"$(echo '~')"`（內層整體加引號）可求值為字面 `~`。
- **`hasUnquotedLeadingTilde` 單元測試**：依元件一的三列對照表逐項斷言，確保 `cd` 目標、求值器
  argv、路徑操作元三處共用同一述詞、不各自漂移。
- **元件五 tilde 漏洞迴歸**（`scope_test.ts` + e2e）：`cat ~/secret`、`cat ~/.ssh/id_rsa`、
  `grep x ~/secret`、`head -5 ~/secret`、`test -f ~/secret`、`base64 ~/secret` 全部必須 ask
  （這些目前是 allow）；`cat "~/secret"` 必須維持 allow（引號形態指向 `./~/secret`）；
  `~user`/`~+`/`~-` 形態必須 ask；`HOME` 未設定時 `~/x` 必須 ask。
  另驗證附帶正確性：設定 `Read(~/cache/**)` 後 `cat ~/cache/x` 應 allow。
- **shell home 與 settings home 分離的迴歸測試**：令 `HOME` 與 `USERPROFILE` 指向**不同**目錄、
  且只有 `USERPROFILE` 那條路徑被 `Read(...)` 允許，則 `cat ~/cache/x` 必須 ask
  （展開須用 `HOME`）；同一情境下 `Read(~/cache/**)` 規則本身仍須以 `resolveHome`
  （`USERPROFILE`）解析，語義不變。
- **各求值器語義**：依「查證依據」節的實測對照表逐項斷言，含 `cygpath -d`/`-s`/`-t dos` 回 `null`、
  `echo` 操作元含反斜線回 `null`、`printf` 純字面含反斜線回 `null`。
  cygpath 求值器的平台相關斷言用 `Deno.test({ ignore: Deno.build.os !== "windows", … })` 區分。
- **cwd 層**（`cwd_test.ts`）：`cd "$(cygpath -u '<專案內>')"` 推導出正確 cwd；
  `cd -` → unknown；`cd ~`、`cd ~/x` 展開 home（home 未知時 unknown）；
  `cd "~"` **不**展開、維持 `<cwd>/~`；`cd ~/"src"`（混合引號）→ unknown。
- **classify 層**：unknown cwd → 不可升級 ask（含「`permissions.allow` 命中也不升級」的斷言）。
- **另三條新規則**（`cygpath_test.ts`、`test_test.ts`、`npm_test.ts`；base64 另列於下）：
  allow 與 ask 兩面 + 邊界，複製既有 `ctxOf` helper。cygpath 須分別覆蓋形態 A／B／C：
  形態 B（`-d`/`-s`/`-l`/`-M`/`-t dos`）帶專案外操作元時必須 ask、且不得取得 cwd 豁免。
  npm 須覆蓋操作元文法：`npm view markdown-it`、`npm view @scope/pkg@1.2.3` → allow；
  `npm view /outside/dir`、`npm view ./x`、`npm view ../x`、`npm view file:./x`、
  `npm view https://example.com/x.tgz`、`npm view C:/x`、`npm view ~/x` → ask。
  另須覆蓋「不探索本機專案」判準：**無操作元的 `npm view`** → ask；
  `npm ls`、`npm outdated`、`npm explain x`、`npm root`、`npm prefix`、`npm pkg get name`、
  `npm config get registry` → 全部 ask；`npm ping`、`npm whoami`、`npm --version` → allow。
- **base64**（`base64_test.ts`）：`base64 -w 0 f.txt` 的 `0` 不被當成路徑；`base64 --wrap=0 f.txt`
  同理；`base64 <專案外檔>` → ask；未知旗標 → ask。
- **`-w` 不得外溢的迴歸測試**：`md5sum -c -w /outside/checksums` 必須 ask
  （`-w` 在 md5sum 是不吃值的 `--warn`，其後的路徑仍是操作元）。此測試釘住「base64 的旗標
  arity 不影響 `fileReaderRule` 其他成員」這條不變量。
- **e2e**（`main_test.ts`）：本次四條真實指令。
- **operational verification**：`deno task build` 後餵 JSON 給 binary，確認安全形式 allow、
  危險形式 ask。

## 查證依據

以下結論取自 2026-09-22 對實機環境（Windows 11 + Git Bash / MSYS2）的實測與官方文件查證，
供後續維護者不必重跑調查即可驗證本設計。

### cygpath（`cygpath (cygwin) 3.6.7`）

輸出完全由輸入字串決定：`-u`（→POSIX）、`-w`（→Windows 反斜線）、`-m`（→Windows 正斜線）、
`-U`（→`/proc/cygdrive/…`）、`-r`（→`\\?\…`）、`-p`（PATH 列表逐項轉換）、`-C CP`、
`-a`（以行程 cwd 展開相對路徑）、`-t unix|windows|mixed`。

需查檔案系統或輸出與輸入無關：

- `-d`、`-t dos`、`-s`：皆為 DOS 8.3 短名。實測 `cygpath -d '/c/Program Files'` → `C:\PROGRA~1`
  （exit 0）；`cygpath -d '/d/nonexistent-xyz-12345'` → `cygpath: cannot create short name of
  D:\nonexistent-xyz-12345`、**exit 2**。`-t dos` 行為相同。
  （`-d` 的 help 文字為 `print DOS (short) form of NAMEs`，易被誤讀成單純格式轉換。）
- `-l`：長名還原，需查檔案系統。實測 `cygpath -w -l '/c/PROGRA~1'` → `C:\Program Files`
  （exit 0）；對不存在的短名樣式 `cygpath -w -l '/c/NOEXIST~1'` → `C:\NOEXIST~1`（原樣、exit 0）。
- `-M`：報告檔案 mode（binary/text），路徑不存在時不報錯、預設印 `binary`。
- `-D`/`-H`/`-O`/`-P`/`-S`/`-W`/`-F ID`/`-A`：輸出 Windows 系統目錄，與輸入無關。
- `-f FILE`/`-o`：從檔案或 stdin 讀取操作元／選項。

實測對照：`cygpath -u 'D:/foo'`→`/d/foo`；`cygpath -u 'D:/foo/'`→`/d/foo/`（尾斜線保留）；
`cygpath -u 'D:\foo\bar'`→`/d/foo/bar`；`cygpath -u 'relative/path'`→`relative/path`（不展開）；
`cygpath -w /d/foo`→`D:\foo`；`cygpath -m /d/foo`→`D:/foo`；`cygpath -w -r /d/foo`→`\\?\D:\foo`；
`cygpath -u -U 'D:/proj'`→`/proc/cygdrive/d/proj`；`cygpath -u -p 'D:/proj'`→`/d/proj`；
`cygpath -u -a 'relative/path'`→`<cwd>/relative/path`。

exit code：成功 0、短名建立失敗 2、用法錯誤 1。輸出格式旗標 `-u`/`-w`/`-m`/`-d`/`-t` 互斥；
`-l`/`-r`/`-s` 互斥且僅與 `-w`/`-m` 併用。

官方文件：<https://cygwin.com/cygwin-ug-net/cygpath.html>

### GNU base64（coreutils 8.32）

`base64 [OPTION]... [FILE]`。`-d`/`--decode`、`-i`/`--ignore-garbage` 不吃值；
`-w COLS`/`--wrap=COLS` **吃值**。無任何輸出到檔案的旗標，輸出恆為 stdout。無操作元時讀 stdin。
只接受單一 FILE（第二個會報 `extra operand`）。
實測：`echo hello | base64 -w 4` → `aGVs` / `bG8K` 兩行。

### dirname / basename（coreutils 8.32）

純字串運算、不碰檔案系統。`dirname [-z] NAME...`；
`basename NAME [SUFFIX]` 或 `basename -a|-s SUFFIX NAME...`（`-s`/`--suffix=` 吃值且隱含 `-a`）。

實測：`dirname /`→`/`；`dirname /a`→`/`；`dirname /a/b/`→`/a`；`dirname a`→`.`；
`dirname ''`→`.`；`dirname /a//b`→`/a`；`dirname ./a`→`.`。
`basename /`→`/`；`basename /a/b/`→`b`；`basename a`→`a`；`basename /a/b.txt .txt`→`b`；
`basename -s .txt /a/b.txt`→`b`。多操作元時逐行輸出。

### echo / printf（bash 5.3.9 builtin 與 coreutils 8.32 外部版）

`echo` 旗標 `-n`/`-e`/`-E` 皆不吃值，兩種實作相同。多操作元以單一空格分隔，預設補尾端換行。
**預設不解釋反斜線**（實測 `echo 'a\tb'` 輸出字面 `a\tb`），須 `-e` 才展開；
**但 bash 的 `xpg_echo` shopt 若為 on，builtin 預設就會解釋反斜線**——此為執行期 shell 狀態。
`--` 不被當成選項終止符（`echo -- foo` 輸出 `-- foo`）。

`printf` 的**格式字串永遠解釋反斜線**（實測 `printf 'a\tb'` 輸出含真實 tab），與 echo 相反。
格式字串會重複套用直到吃完所有參數（`printf '%s\n' a b c` 印三行）；參數不足以空字串補。
`%b` 在參數中展開反斜線、`%q` 輸出 shell 引號形式；bash builtin 另有 `-v var` 與 `%(fmt)T`。

### bash test / `[`（bash 5.3.9）

操作元是檔案路徑：一元 `-a`(=`-e`)、`-b`、`-c`、`-d`、`-e`、`-f`、`-g`、`-h`、`-k`、`-L`、`-p`、
`-r`、`-s`、`-S`、`-u`、`-w`、`-x`、`-O`、`-G`、`-N`；二元 `-nt`、`-ot`、`-ef`。

操作元不是路徑：`-t`（fd 整數，非數字 → exit 2）、`-n`/`-z`（字串）、`=`/`==`/`!=`/`<`/`>`
（字串比較）、`-eq` 等六個（數值）、`-v`/`-R`（變數名）、`-o`（shell option 名）。

雙重語義：`-a` 一元為「檔案存在」、二元為邏輯 AND；`-o` 一元為「shell option 已啟用」、
二元為邏輯 OR；語義由參數個數決定。

參數計數語義（實測 exit code）：`test`→1；`test foo`→0（非空字串為真）；
**`test -f`→0（單參數時 `-f` 只是非空字串，不是運算子）**；`test ""`→1；`test a = b`→1。

`[` 語義與 `test` 相同，但必須以 `]` 作為最後一個參數。`[[ ]]` 是 bash keyword、不產生 command
invocation。`test` 與 `[` 皆為純述詞：只讀檔案 metadata 與變數狀態，不寫檔、不執行外部程式、
不改變 shell 狀態。

### npm CLI（11.13.0 / Node.js 24.16.0）

不寫入專案目錄、不執行 lifecycle script、不開瀏覽器（**但所有 npm 呼叫都會寫入 npm 自身的
cache 與 debug log，見本節末的實測**）：`view`(`v`/`info`/`show`)、`ls`(`list`/`la`/`ll`)、
`outdated`、`explain`(`why`)、`ping`、`search`、`root`、`prefix`、`whoami`、`config get`(`get`)、
`pkg get`、`cache ls`、`org ls`、`team ls`、`profile get`、`owner ls`、`query`、`help-search`、
`fund`（不帶 `--browser`）、`audit`（不帶 `fix`；會把依賴清單送到 registry）、`diff`（自 registry
取 tarball）、`sbom`、`doctor`（環境診斷，含檔案權限檢查）、`token list`（列出認證令牌中繼資料）、
`version`（**不帶位置參數時**只印版本 JSON）。

有副作用：開瀏覽器 `docs`/`repo`/`home`/`bugs`；改 package.json 與 git 的
`version <newversion>`（另執行 preversion/version/postversion lifecycle scripts）、
`pkg set`/`pkg delete`/`pkg fix`；改設定檔 `config set`/`delete`/`edit`/`fix`；
產生 .tgz 的 `pack`（不帶 `--dry-run` 時）；改 registry 狀態的 `publish`、`deprecate`、
`org set`/`rm`、`team create`/`destroy`/`add`/`rm`、`profile set`/`enable-2fa`/`disable-2fa`、
`star`/`unstar`、`owner add`/`rm`、`token create`/`revoke`；安裝與快取寫入的
`install`(`i`)、`ci`、`update`、`uninstall`(`remove`)、`cache clean`/`cache add`、`init`、
`adduser`/`login`/`logout`。`cache verify` 的官方描述含「驗證並可能修復」。

會改變讀寫位置或由誰執行什麼程式的全域旗標：`--prefix <path>`、`--userconfig <path>`、
`--globalconfig <path>`、`--cache <path>`、`--script-shell <shell>`、`--node-options <opts>`、
`--editor <editor>`、`-g`/`--global`、`--foreground-scripts`、`--registry <url>`。

僅影響輸出格式或查詢範圍的旗標：`--json`/`-j`、`--long`/`-l`、`--depth <n>`、`--omit <type>`、
`--include <type>`、`--offline`/`--prefer-offline`/`--prefer-online`、`--unicode`/`--no-unicode`、
`--all`、`--parseable`/`-p`、`--color`/`--no-color`、`--package-lock-only`、
`-w`/`--workspace <name>`、`--otp <code>`。

其他：`npm bin` 在 11.x 已移除；`npm why` 是 `npm explain` 的別名。
官方文件：<https://docs.npmjs.com/cli/v11/commands/>

**本機查詢子指令的向上專案探索（實測）**：npm 對本機查詢類子指令會沿目錄樹向上尋找
package.json 以決定 effective prefix。實測在一個兩層深、自身與中間層皆無 package.json 的空目錄
中執行：`npm pkg get name` 印出**父層** package.json 的 `name`；`npm prefix` 印出父層目錄路徑；
`npm ls` 印出父層專案的名稱與版本。受影響者包括 `pkg get`、`ls`、`outdated`、`explain`、`root`、
`prefix`，以及無操作元的 `view`。`config get` 讀取的 `.npmrc` 層級同樣由此探索決定。

對本專案尤其相關：本專案是 Deno 專案、無 package.json，因此這些子指令在此執行時必然讀到專案外。

**npm 自身的 cache 與 log 寫入（實測）**：即使是純查詢子指令，npm 仍會寫入其 cache 目錄
（`npm config get cache`，本機為 `D:\.npm-cache`）下的 `_cacache` 與 `_logs`。
實測一次 `npm view markdown-it version`：`_logs` 目錄新增一個 `*-debug-0.log` 檔，
且檔案總數由 49 降為 11——npm 同時執行了 log 輪替、**刪除了 38 個舊檔**。
此位置由 npm 的 effective 設定（`.npmrc` 層級疊加）決定，通常在專案之外，且不受
`--cache` 以外的旗標影響（阻擋 `--cache` 旗標並不會停用已設定的 cache）。
對應的設計取捨見「Non-goals / Accepted limitations」。

## Non-goals / Accepted limitations

### `[ … ]` 形態維持 ask

**Concern**：`test -f x` 會 allow，但等價的 `[ -f x ]` 仍 ask。

**Decision**：不實作。

**Rationale**：實測本專案解析器，`[ -f x ]` 的 `CommandInvocation.name` 為 `null`（`[` 是 glob
字元，被 `word.ts` 的詞法 glob 偵測判為動態 token），`classify` 步驟一會直接 ask，指令規則永遠
不會被呼叫。要支援就得在核心 name 解析路徑加一個「token 恰為 `[` 且無 parts 時視為靜態」的例外，
改動面與迴歸測試成本高於其價值；使用者實際採用的寫法是 `test -f x`。

### 求值框架涵蓋範圍以外的 `cd "$(…)"` 形態

**Concern**：堵漏後，求值框架救不回來的形態會從現行的 allow 變成 ask，例如
`cd "$(git rev-parse --show-toplevel)" && …`、`cd $SOMEVAR && …`、`git -C "$DIR" log`。

**Decision**：接受，不逐一擴充求值器。

**Rationale**：這些形態的目標目錄靜態不可知，「在無法確定的目錄執行指令」本就該問；
`git rev-parse --show-toplevel` 需讀取檔案系統才能求值，與求值器「純函式、不碰檔案系統」的
契約衝突。需要時使用者可直接寫出具體路徑。

### cwd 為 unknown 時不給 cwd 豁免

**Concern**：`cd "$(…)" && gh api …` 即使 `gh` 已宣告 `cwdIndependent` 也會 ask。

**Decision**：接受。

**Rationale**：五道護欄的第 (2) 條要求「hook 傳入的 session cwd 在範圍內**且**當前 cwd 由鏈內
`cd` 產生（`origin === "chain-cd"`）」，這是豁免的信任起點；unknown 無法確立該起點。放寬等於讓
「把 cd 目標寫成動態」重新成為繞過管道，與本次堵漏的目的直接抵觸。

### `cd` 一律視為成功

**Concern**：`walk.ts` 把 `cd X` 當成必定成功並據此推導後續 cwd。若 X 不存在，bash 會留在原地，
後續相對路徑解析到完全不同的位置。實測 `cd missing/sub; cat ../../secret` 目前就把 `cat` 的 cwd
推成 `D:/proj/missing/sub`，於是 `../../secret` 算成專案內的 `D:/proj/secret` 而可能放行；
實際 cd 失敗時 bash 讀的是 `D:/secret`（專案外）。本次的求值框架會讓更多形態進入這條路徑
（原本 `cd "$(…)"` 一律 unknown）。

**Decision**：接受，維持「cd 視為成功」，不追蹤成功／失敗／短路三態。

**Rationale**：**精確**判斷 cd 成敗需要知道目標目錄是否存在（檔案系統狀態，本工具不碰），
但**保守**處理並不需要——這點必須說清楚，以免日後誤以為此限制無解。已知的兩個純詞法方案是：

1. 只信任 `&&` 之後的 cd（`&&` 保證前一指令成功才執行後續），`;` / `||` / 換行分隔後標 unknown；
2. 非 `&&` 分隔時要求 cd 前與 cd 後兩個 cwd **都**通過範圍檢查。

不採用的理由是取捨而非不可行：方案 1 會讓 `cd src; ls`、`cd src` 後換行接指令這類日常寫法變成
ask；方案 2 誤殺較少，但 `CwdState` 需能攜帶多個候選，`walk` 與 `classify` 的 cwd 模型都要改，
改動面大於本次主題。此為既有行為（靜態 `cd` 早已如此），求值框架只是讓更多形態進入同一條既有
路徑，並未改變其語義。

本限制的前提是「上述誤殺代價不可接受」與「cwd 推導僅供範圍判定」。若日後該代價評估改變
（例如願意接受 `cd X; …` 一律 ask），或 cwd 推導被用於更強的放行決策，此豁免不自動延用，
應重走方案 1／2 的評估。

### npm 對自身 cache 與 debug log 的寫入不納入判定

**Concern**：本工具的契約是「純唯讀且全部落在專案內」，但實測顯示即使 `npm view` 這類純查詢，
npm 仍會在其 cache 目錄（本機為 `D:\.npm-cache`，位於專案外）寫入 `_cacache` 與新的
`*-debug-0.log`，並輪替刪除舊 log（實測一次呼叫刪除 38 個舊檔）。允許 npm 查詢即等於允許這些
專案外的寫入與刪除。

**Decision**：接受，不實作任何對寫入目的地的驗證。

**Rationale**：npm 管理自己的 cache 與 log 屬於工具的內部管家行為——不觸碰專案檔案、不外洩專案
內容、不執行任意程式，不是本工具要防的威脅。相對地，若要在放行前確認寫入位置，必須讀取並疊加
`.npmrc` 的專案／使用者／全域／內建四層設定以求出 effective `cache` 與 `logs-dir`，這與本工具
「純詞法判定、不碰檔案系統」的核心設計直接衝突，成本與風險都遠高於所防的問題。本限制的前提是
「npm 的 cache/log 位置由使用者自己的 npm 設定決定」；若日後該前提改變（例如設計上開始容許
由指令參數指定寫入位置），此豁免不自動延用。

### npm 子指令範圍限於「不探索本機專案」者

**Concern**：許多經查證為唯讀的 npm 子指令不納入 allowlist，包括依賴本機專案探索的
`ls`/`outdated`/`explain`/`root`/`prefix`/`pkg get`/`config get`，以及 `search`、`audit`、
`diff`、`sbom`、`doctor`、`token list`、`version`、`fund`、`cache ls`、`org ls`、`team ls`、
`profile get`、`owner ls`、`query`、`help-search`。

**Decision**：不納入，維持 ask。

**Rationale**：本機查詢類會沿目錄樹向上找 package.json，讀取的位置可能落在允許範圍外，且沒有
操作元可供檢查——本工具的路徑判定完全無從介入（實測見「查證依據」）。要納入就得讀取並疊加
`.npmrc` 層級以求出 effective prefix，與「純詞法判定、不碰檔案系統」的核心設計衝突。
其餘：`search`/`audit`/`diff` 會把查詢字串或本機依賴清單送到外部 registry；`token list` 列出
認證令牌中繼資料；`doctor` 會檢查檔案權限、官方描述含診斷性修復；`version` 的安全與否取決於有無
位置參數，形態辨識成本高於其價值；其餘為低頻子指令。未涵蓋者只是多問一次，符合「誤 ask 可接受，
誤 allow 不可接受」的根本取捨。
