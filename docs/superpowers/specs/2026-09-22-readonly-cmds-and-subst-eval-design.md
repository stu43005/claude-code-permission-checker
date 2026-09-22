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
| `src/rules/commands/cygpath.ts` | cygpath 指令規則 |
| `src/rules/commands/test.ts` | `test` 規則 |
| `src/rules/commands/npm.ts` | npm 子指令 allowlist |

### 修改檔案

| 檔案 | 改動 |
|---|---|
| `src/engine/cwd.ts` | `applyCd` 取值改為「先 `staticValue`，失敗再試 `evalSubstitutionWord`」；`cd -` / `cd ~` 語義修正 |
| `src/engine/classify.ts` | `centralPreflightAsk` 規則一擴充 `unknown` 分支 |
| `src/rules/commands/coreutils.ts` | `base64` 併入 `fileReaderRule.names`；`-w`/`--wrap` 加入 `valueFlags` |
| `src/rules/allowlist.ts` | 註冊三條新規則 |
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

1. word 的 parts 恰為一個 `CommandExpansion`，不與任何字面文字混合（排除
   `"$(cygpath -u 'D:/x')/sub"` 這類混合形態）。
2. 內層 `Script` 恰含一個 `Statement`、其 `command` 為單一 `Command`；有 pipeline、`&&`/`;`、
   控制流、重導向或賦值前綴一律不求值。
3. 指令名靜態且命中註冊表。
4. 所有 argv 皆靜態（`staticValue` 非 null）。
5. 註冊的求值器回非 null。
6. 求值結果不含換行字元（多行輸出用作 cd 目標無意義，保守放棄）。

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

不可求值旗標（回 `null`）：`-d`、`-t dos`、`-s`（皆為 DOS 8.3 短名，需查檔案系統）、`-M`、
`-D`/`-H`/`-O`/`-P`/`-S`/`-W`/`-F`/`-A`（輸出系統目錄）、`-f`/`-o`（讀檔取操作元）、
`-p`（PATH 列表語義）、`-l`（長名，對既有短名路徑需查檔案系統）、`-r`（`\\?\` 前綴，
`normalizeAbsolute` 不保證等價）。未知旗標亦回 `null`。

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

### base64（併入 `fileReaderRule`）

`base64` 加入 `fileReaderRule.names`（與 `md5sum`/`sha256sum`/`hexdump` 同群組：位置參數視為
要讀取的路徑、做範圍檢查）。同時把 `-w`/`--wrap` 加入該規則的 `valueFlags`。

`-w` 吃一個整數值。未登記為 value-flag 時，`base64 -w 0 f.txt` 的 `0` 會被 `positionals()` 當成
路徑操作元而 `resolvePath("0")`，造成誤 ask。`--wrap=0` 黏寫形式因以 `-` 開頭本就會被跳過。

`base64` 無任何輸出到檔案的旗標，輸出恆為 stdout，故不需新增 `askFlags`。

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

**第一層唯讀子指令**：`view`、`info`、`show`、`v`、`ls`、`list`、`la`、`ll`、`outdated`、
`explain`、`why`、`ping`、`root`、`prefix`、`whoami`。

**兩層結構子指令**（第二層必須是讀取動作，否則 ask）：`config get`、`get`、`pkg get`。
這類子指令的第一層同名但第二層副作用相反（`config get` vs `config set`、`pkg get` vs `pkg set`），
必須檢查到第二層。

**無子指令形態**：僅 `npm --version` / `npm -v` allow。

**旗標 allowlist**（未知旗標一律 ask，如此亦免疫 npm 版本漂移）：
`--json`/`-j`、`--long`/`-l`、`--depth <n>`、`--omit <type>`、`--include <type>`、
`--offline`、`--prefer-offline`、`--prefer-online`、`--unicode`/`--no-unicode`、`--all`、
`--parseable`/`-p`、`--color`/`--no-color`、`--package-lock-only`、`-w <name>`/`--workspace <name>`。

明確 ask 的旗標（會改變讀寫位置或由誰執行什麼程式）：`--prefix`、`--userconfig`、
`--globalconfig`、`--cache`、`--script-shell`、`--node-options`、`--editor`、`-g`/`--global`、
`--foreground-scripts`、`--registry`。

**位置參數不做路徑範圍檢查**：`npm view <pkg>` 的操作元是套件名（可含 `@scope/name@version`），
不是檔案路徑；對它做 `resolvePath` 會誤殺。此處與 `grep` 的 PATTERN 操作元同理。

動態 token 一律 ask（不臆測其展開結果）。

### cygpath（`src/rules/commands/cygpath.ts`）

旗標 allowlist：可安全執行的旗標為求值框架的可求值集合再加上**輸出系統目錄類**——後者雖不可
靜態求值，但執行本身不寫檔、不執行外部程式，屬唯讀。

- allow：`-u`、`-w`、`-m`、`-t <type>`、`-a`、`-C <cp>`、`-i`、`-U`、`-l`、`-r`、`-p`、
  `-D`、`-H`、`-O`、`-P`、`-S`、`-W`、`-F <id>`、`-A`、`-d`、`-s`、`-M`、`-h`、`-V`
- ask：`-f`（從檔案／stdin 讀取操作元）、`-o`（從檔案讀取選項）、`-c`（關閉 HANDLE，
  屬行程管理而非路徑轉換）、任何未知旗標

位置參數不做路徑範圍檢查：cygpath 只做路徑字串轉換，不讀取檔案內容，轉換本身不洩漏路徑以外的
資訊。（`-s`/`-d`/`-M` 會查詢檔案系統 metadata，但僅回報「能否產生短名」「binary/text」，
與 `test -e` 同等級，且本規則的操作元仍受中央前置規則一的 cwd 範圍約束。）

宣告 `cwdIndependent`：本規則不對操作元做路徑範圍檢查，判定與 cwd 無關。

## 錯誤處理

沿用既有 fail-safe 契約，不新增例外路徑：

- `evalSubstitutionWord` 為純函式、不碰檔案系統；任何無法確定的情形回 `null`，退化為既有的
  `UNKNOWN` cwd 行為（再由規則一 ask）。
- 求值器不得丟例外；`evaluate` 外層既有的 try/catch 仍是最後防線（回 ask）。
- 三條新規則的未涵蓋形態一律 `ask`，維持 default-deny。

## 測試策略

- **求值框架層**（`subst_eval_test.ts`）：混合 word、pipeline／多 statement、重導向、賦值前綴、
  動態 argv、未註冊指令名、含換行的求值結果——各自回 `null`。
- **各求值器語義**：依「查證依據」節的實測對照表逐項斷言，含 `cygpath -d`/`-s`/`-t dos` 回 `null`、
  `echo` 操作元含反斜線回 `null`、`printf` 純字面含反斜線回 `null`。
  cygpath 求值器的平台相關斷言用 `Deno.test({ ignore: Deno.build.os !== "windows", … })` 區分。
- **cwd 層**（`cwd_test.ts`）：`cd "$(cygpath -u '<專案內>')"` 推導出正確 cwd；`cd -`、`cd ~`、
  `cd ~/x` 的新語義。
- **classify 層**：unknown cwd → 不可升級 ask（含「`permissions.allow` 命中也不升級」的斷言）。
- **三條新規則**（`cygpath_test.ts`、`test_test.ts`、`npm_test.ts`）：allow 與 ask 兩面 + 邊界，
  複製既有 `ctxOf` helper。
- **base64**：`base64 -w 0 f.txt` 的 `0` 不被當成路徑；`base64 <專案外檔>` → ask。
- **e2e**（`main_test.ts`）：本次四條真實指令。
- **operational verification**：`deno task build` 後餵 JSON 給 binary，確認安全形式 allow、
  危險形式 ask。

## 查證依據

以下結論取自 2026-09-22 對實機環境（Windows 11 + Git Bash / MSYS2）的實測與官方文件查證，
供後續維護者不必重跑調查即可驗證本設計。

### cygpath（`cygpath (cygwin) 3.6.7`）

輸出完全由輸入字串決定：`-u`（→POSIX）、`-w`（→Windows 反斜線）、`-m`（→Windows 正斜線）、
`-U`、`-l`、`-r`、`-C CP`、`-a`（以行程 cwd 展開相對路徑）、`-t unix|windows|mixed`。

需查檔案系統或輸出與輸入無關：

- `-d`、`-t dos`、`-s`：皆為 DOS 8.3 短名。實測 `cygpath -d '/c/Program Files'` → `C:\PROGRA~1`
  （exit 0）；`cygpath -d '/d/nonexistent-xyz-12345'` → `cygpath: cannot create short name of
  D:\nonexistent-xyz-12345`、**exit 2**。`-t dos` 行為相同。
  （`-d` 的 help 文字為 `print DOS (short) form of NAMEs`，易被誤讀成單純格式轉換。）
- `-M`：報告檔案 mode（binary/text），路徑不存在時不報錯、預設印 `binary`。
- `-D`/`-H`/`-O`/`-P`/`-S`/`-W`/`-F ID`/`-A`：輸出 Windows 系統目錄，與輸入無關。
- `-f FILE`/`-o`：從檔案或 stdin 讀取操作元／選項。

實測對照：`cygpath -u 'D:/foo'`→`/d/foo`；`cygpath -u 'D:/foo/'`→`/d/foo/`（尾斜線保留）；
`cygpath -u 'D:\foo\bar'`→`/d/foo/bar`；`cygpath -u 'relative/path'`→`relative/path`（不展開）；
`cygpath -w /d/foo`→`D:\foo`；`cygpath -m /d/foo`→`D:/foo`；`cygpath -w -r /d/foo`→`\\?\D:\foo`；
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

純讀、無本機寫入／不執行 script／不開瀏覽器：`view`(`v`/`info`/`show`)、`ls`(`list`/`la`/`ll`)、
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

### npm 子指令範圍限於「registry 元資料 + 本機查詢」

**Concern**：`search`、`audit`、`diff`、`sbom`、`doctor`、`token list`、`version`、`fund`、
`cache ls`、`org ls`、`team ls`、`profile get`、`owner ls`、`query`、`help-search` 雖經查證為唯讀，
但不納入 allowlist。

**Decision**：不納入，維持 ask。

**Rationale**：`search`/`audit`/`diff` 會把查詢字串或本機依賴清單送到外部 registry，超出本次
選定的範圍；`token list` 列出認證令牌中繼資料；`doctor` 會檢查檔案權限、官方描述含診斷性修復；
`version` 的安全與否取決於有無位置參數，形態辨識成本高於其價值；其餘為低頻子指令。
未涵蓋者只是多問一次，符合「誤 ask 可接受，誤 allow 不可接受」的根本取捨。
