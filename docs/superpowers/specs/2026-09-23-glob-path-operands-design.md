# Glob 路徑操作元支援（固定指令清單）設計

## 背景與目標

目前任何未加引號的 glob token（`*.md`、`runtime-behavior/*.md`、`--include=*.md`）都會讓
`word.ts` 的 `staticValue` 回 `null`。因此：

- CommandSpec 路徑（grep/head/wc）回「含動態 token，無法靜態判定」→ `ask`；
- legacy 路徑（cat/ls）回「路徑超出專案範圍或無法靜態解析」→ `ask`。

agent 常見的唯讀指令因此一律被詢問，例如：

```bash
ls -la && wc -l *.md
grep -rn "Nginx 5xx" --include=*.md . | head -40
grep -n "careTreatment\|WebApi\|webapi" *.md runtime-behavior/*.md | head -40
```

**目標**：對一份**固定、不擴增**的指令清單（`grep`/`egrep`/`fgrep`、`head`、`wc`、`cat`、`ls`），
在能以純詞法確認「展開結果必定落在讀取範圍內」時，接受 glob 路徑操作元並回 `allow`。
上述三條範例指令在實作後須判為 `allow`。

**非目標**：放寬 `resolvePath`、放寬 `<` 重導向目標、讓清單外的指令接受 glob、實際讀取檔案系統展開 glob。

## 已查證的第三方行為

### GNU bash 5.3.9(1)-release（Git Bash / cygwin）pathname expansion

以下由本機實驗取得（`printf '[%s]' <pattern>` 觀察展開結果）：

- 預設 shopt：`extglob`/`globstar`/`dotglob`/`nullglob`/`failglob` 皆 off；`globskipdots` on。
- **`.` / `..` 的產生**：
  - `globskipdots` on（預設）時，`.*`、`sub/.*` 都不會產生 `.`/`..`。
  - `shopt -u globskipdots` 後，`.*` → `. .. .h`、`sub/.*` → `sub/. sub/..`、`.[.]` → `..`。
    也就是說，以字面 `.` 開頭的 glob 段在此設定下可展開成 `..`。
  - 不以 `.` 開頭的段（`??`、`[.]*`、`*`）在 dotglob、globskipdots off 任一組合下，都沒有產生 `.`/`..`。
- **字面 `..` 段**：位於 glob 段之後時會原樣保留，`sub*/../x` → `subdir/../x`，可逃出字面前綴。
- **`/`**：`*`、`?`、`[...]` 都不匹配 `/`，`a[/]b` 保持字面。
- **globstar**：未開啟時 `**` 等同 `*`；開啟時遞迴，但只在字面前綴之下。
- **無匹配時**：
  - 預設保留字面；
  - `nullglob` 移除該 word；
  - `failglob` 報錯並中止整段 script；
  - `nocaseglob` 改為不分大小寫；
  - `set -f` 則完全不展開。
- **旗標形 word 也會展開**：cwd 有名為 `--include=x.md` 的檔案時，`--include=*.md` 會展開成該檔名，
  結果仍以 `--include=` 開頭。`-*` 會匹配所有以 `-` 開頭的檔名。
- **旗標注入**：cwd 有名為 `--include=x.md` 的檔案時，`cat *` 會報 `cat: unknown option`，
  代表檔名被當成了旗標。`cat -- *` 可以避免。
- **引號**：`"src"/*.md` 中的 `*.md` 仍然活躍；`src/"*".md` 與 `src/\*.md` 則是字面。

### GNU coreutils 8.32 `cat` / `ls`

對照 coreutils/coreutils tag `v8.32` 的 `src/cat.c`、`src/ls.c` 中的 `long_options[]` 與選項處理：

- **cat**：
  - 旗標：`-A/--show-all -b/--number-nonblank -e -E/--show-ends -n/--number -s/--squeeze-blank -t
    -T/--show-tabs -u -v/--show-nonprinting --help --version`，全部不吃值。
  - `-u` 是 no-op。
  - 沒有任何旗標會寫檔、執行程式或讀取操作元以外的檔案。
- **ls**：
  - 吃值旗標只有 `-w`、`-T`、`--block-size`、`--sort`、`--time`、`--time-style`（`+FMT` 只交給
    strftime）、`--format`、`--indicator-style`、`--quoting-style`、`-I/--ignore`、`--hide`
    （fnmatch 顯示過濾）。這些值都不是路徑。
  - `--color[=WHEN]`、`--hyperlink[=WHEN]` 為選填值。
  - `-R` 只讀目錄。
  - 沒有任何旗標會寫檔、執行程式或讀取操作元以外的檔案。
  - 本機 `ls --help` 列出 `--append-exe`，但 v8.32 原始碼找不到這個旗標（推測是 MSYS2 補丁），**行為未驗證**。

### 其餘清單成員的旗標注入分析（依本 repo 現有 spec 與 GNU `--help`）

被注入的 token 來自 cwd 內的檔名，因此**不可能含 `/`**。

- **head**：旗標只控制輸出數量與格式，被注入也無害。
- **grep/egrep/fgrep**：沒有寫檔或 exec 類旗標。
  - 注入 `-r`/`-R` 只會遞迴 cwd 內、已通過範圍檢查的操作元。
  - 注入 `-f<name>`/`--file=<name>` 讀取的是 cwd 內的檔案。
  - 注入吃值旗標會吞掉下一個檔名作為值，也無害。
- **wc**：`--files0-from=<name>` 會讀 cwd 內 `<name>` 所列的任意路徑，並輸出其**計數與檔名**。
  這是殘留風險，見 Non-goals / Accepted limitations。

## 設計

### §1 `src/engine/glob.ts`：glob word 詞法判定（純函式、不碰檔案系統）

```ts
export interface GlobPath { prefix: string }            // 字面前綴目錄；"" 代表 cwd
export function parseGlobPath(word: Word): GlobPath | null;
export function isGlobAttachedValue(word: Word, flagName: string): boolean;
```

`parseGlobPath` 只有在以下條件**全部**成立時才回非 null。

**字形前提**
1. `word.parts` 為 `undefined`（整個 word 完全未加引號）。
2. `word.value` 至少含一個未跳脫的 `*`、`?` 或 `[`，而且**不含反斜線**。
3. 不以 `-` 開頭，也不以 `~` 開頭；並且不是磁碟相對形態，即 `scope.ts` 的 `isDriveRelative` 為 false。

**切段**：以 `/` 切段。第一個含 glob 字元的段稱為 *G*。*G* 之前的所有段依原樣以 `/` 連接，就是 `prefix`：

- value 以 `/` 開頭時，`prefix` 保留開頭的 `/`，例如 `/*.md` → `prefix = "/"`；
- 沒有任何前段時，`prefix` 為 `""`。

**尾段限制**：*G* 以及其後的所有段，
- 不得為字面 `..`；
- 含 glob 字元的段，第一個字元不得是 `.` 或 `[`。
- 空段（`//`）、`**`、結尾 `/` 都可接受。

**不處理的事**：`prefix` 本身可以含 `..`，由範圍判定詞法正規化。`parseGlobPath` 不管開頭是不是 glob
字元，也就是不處理旗標注入；那是由 §2 的固定清單授權。

`isGlobAttachedValue(word, flagName)` 在以下條件全部成立時回 true：
- `word.parts === undefined`；
- `word.value` 以 `flagName + "="` 開頭；
- `=` 之後的部分含未跳脫 glob 字元，且整個 value 不含反斜線。

### §2 範圍判定與規則接線

**`scope.ts` 新增 `resolveGlobPath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope`**
1. `parseGlobPath(arg)` 為 null → `"dynamic"`。
2. 把 `prefix` 解析成絕對路徑 *P*：
   - `prefix === ""` 時，cwd 為 known 取 `cwd.path`，否則回 `"dynamic"`；
   - 其餘情形沿用 `resolveResolvedValue` 相同的絕對/相對語義，相對路徑以 cwd 為基準，cwd unknown → `"dynamic"`。
3. `isReadScoped(P, scope)` 為 false → `"out-of-project"`。
4. **巢狀否決**：*P* 不在 `scope.root` 之內，但 `scope.deny` 或 `scope.ask` 有任何 root 或 file 嚴格位於 *P* 之下
   → `"out-of-project"`。*P* 在 root 內時不做此檢查，維持 root-first 語義。
5. 其餘 → `"in-project"`。

`RuleContext` 新增 `resolveGlobPath(arg: Word): PathScope`，由 `classify.ts` 綁定 cwd 與 scope。
**`resolvePath`、`resolvePathValue` 不變。**

**CommandSpec 路徑（grep/egrep/fgrep、head、wc）**
- 型別新增：
  - `CommandSpec.globOperands?: boolean`，`HEAD_SPEC`、`WC_SPEC` 與 grep 的 spec 設為 `true`；
  - `FlagSpec.valueAcceptsGlob?: boolean`，只有 grep 的 `--include`、`--exclude` 設為 `true`。
- `ArgvParse` 新增 `globOperands: Word[]`，存放要走 `resolveGlobPath` 的位置參數。
- `parseArgv` 的處理：遇到 `staticValue(argv[i]) === null` 的 token 時，依序判斷：
  1. 若 `optionsDone === false`，且存在某個 `f.value === "required" && f.valueAcceptsGlob` 的長旗標
     使 `isGlobAttachedValue(argv[i], f.name)` 成立 → 記入 `seenFlags`，值記 null，不標 dynamic。
  2. 否則若 `spec.globOperands` 為真，且 `parseGlobPath(argv[i])` 成立 → 以 glob 標記收進位置參數。
  3. 否則 → `dynamic = true`（現狀）。
- 位置參數分類時，glob 標記的 token 若落在 `nonPathOperands`（grep 的 PATTERN 位置），就把
  `dynamic` 設為 true；否則放進 `globOperands`，而不是 `pathOperands`。
- 吃值旗標的獨立 token 值若是 glob（例如 `-e *.md`），沿用現狀 → dynamic。
- `evaluateWithSpec` 在既有 `pathOperands` 檢查之後，對 `globOperands` 逐一呼叫 `ctx.resolveGlobPath`，
  任何一個不是 `in-project` 都 ask，理由為 `${name}：glob 路徑超出專案範圍或無法靜態解析（${value}）`。
- `cwdIndependentWhenNoPaths` 述詞額外要求 `p.globOperands.length === 0`。

**legacy 路徑（cat、ls）**
- `FlagGatedReaderOptions` 新增 `globOperandNames?: string[]`，`fileReaderRule` 設為 `["cat", "ls"]`。
- legacy 的位置參數迴圈中，若 `ctx.name` 在 `globOperandNames` 內、且 `parseGlobPath(arg)` 成立，
  就改呼叫 `ctx.resolveGlobPath(arg)`；其餘沿用 `ctx.resolvePath(arg)`。
- 其他 legacy 行為（未知旗標放行、`recursive`、`pathValueFlags`）不變。

**刻意不變**
- `classify.ts` 的 cwd 豁免護欄 (4) 使用 `staticValue`，glob token 不算靜態，所以不豁免。
- `permissions/matcher.ts` 的 `reconstructCommand` 對 glob token 回 null，所以不升級。
- 規則四的 `<` 目標仍走 `resolvePath`：`cat < *.md` → ask。
- 遞迴危險根 deny 判定不變；`grep -r x /*` 的前綴 `/` 在範圍外 → ask，與現狀相同。

### §3 錯誤處理

沒有新增的例外路徑：`parseGlobPath`、`isGlobAttachedValue`、`resolveGlobPath` 都是純函式，
不合格的形態回 null 或 `"dynamic"`，再由既有流程落到 `ask`。`main.ts` 既有的 try/catch 仍把
任何意外轉成 `ask`，並一律 `exit 0`。

## 測試計畫

- **`src/engine/glob_test.ts`**
  - `parseGlobPath` 接受並回傳對應 prefix：`*.md` → `""`、`runtime-behavior/*.md` → `runtime-behavior`、
    `src/**/*.ts` → `src`、`./*.md` → `.`、`/d/proj/*.md` → `/d/proj`、`../x/*.md` → `../x`、`/*.md` → `/`。
  - `parseGlobPath` 拒絕：`-*`、`~/*.md`、`"src"/*.md`、`src/\*.md`、`C:*.md`、`sub*/../x`、`.*`、`sub/.*`、
    `[.]*`、`x/[ab]*`、`a.md`（無 glob）。
  - `isGlobAttachedValue`：`(--include=*.md, --include)` 為 true；`(--include=a.md, --include)` 為 false；
    `(--exclude=*.log, --include)` 為 false。
- **`src/engine/scope_test.ts`**
  - `resolveGlobPath` 三態：專案內前綴 → in-project；專案外前綴 → out-of-project；cwd unknown 且前綴相對 → dynamic。
  - 外部 allow root 內有巢狀 deny/ask 時 → out-of-project；外部 allow root 內沒有巢狀 deny → in-project。
  - Windows 的 `/d/` 形態以 `Deno.build.os` 分支。
- **規則測試**（`command_spec_test.ts`、`grep_test.ts`、`coreutils_test.ts`）
  - allow：`wc -l *.md`、`head *.md`、`grep -n x *.md sub/*.md`、`grep -rn x --include=*.md .`、
    `cat src/*.ts`、`ls *.md`。
  - ask：`grep *.md f`、`grep -e *.md f`、`grep -f *.x f`、`wc --files0-from=*.x`、`stat *.md`、
    `cat ../*.md`（前綴在範圍外）、`ls .*`。
  - 清單外規則維持 ask：`tail *.md`、`diff *.md x`、`sort *.md`。
- **`src/engine/classify_test.ts`**
  - `cat < *.md` → ask。
  - `cd /outside && wc -l *.md`（chain-cd）→ ask，因為不豁免。
  - `permissions.allow` 含 `Bash(stat *)` 時，`stat *.md` 仍為 ask。
- **Operational verification**：在 `scripts/verify-hook-binary.ts` 的 `CASES` 加入三條範例指令（期望 allow），
  以及 `cat < *.md`、`stat *.md`、`grep *.md f`、`ls .*`（期望 ask）。
- 最後執行 `deno task check && deno task lint && deno task test`，並跑上述 verify 腳本。

## 文件

更新 `CLAUDE.md`：
- 在架構一節補上 `glob.ts` 與 `resolveGlobPath`；
- 說明固定清單及各指令的旗標注入分析；
- 在「不要再犯的問題」加上：`.` 開頭 glob 段在 `globskipdots` off 時會產生 `..`、字面 `..` 尾段會逃出前綴，
  以及 `--opt=*` 也會被 bash 展開。

## Non-goals / Accepted limitations

- **Concern**：wc 經 glob 注入 `--files0-from=<name>` 後，會讀 cwd 內 `<name>` 所列的任意路徑，並輸出其行數與檔名。
  **Decision**：不實作防護，wc 仍接受裸 glob。
  **Rationale**：攻擊者必須先在專案內植入兩個特製檔名的檔案，而且只洩漏計數與檔名、不洩漏內容；
  使用者評估後接受此風險。
- **Concern**：本機 `ls` 的 `--append-exe`（MSYS2 補丁）行為未經查證，可能經注入觸發。
  **Decision**：不另行防護。
  **Rationale**：由名稱判斷屬於顯示類旗標；使用者接受 ls 納入清單。
- **Concern**：globstar 展開時是否跟隨指向專案外的 symlink 目錄，未經查證。
  **Decision**：不處理。
  **Rationale**：與本工具既有的「純詞法、不做 symlink 檢查」限制同性質，字面路徑本就有相同狀況。
- **Concern**：清單外的指令（tail、stat、diff、sort、find、git 等）含 glob 仍為 ask。
  **Decision**：清單固定，不提供擴增機制。
  **Rationale**：旗標注入無法由本工具的旗標解析器觀察到；逐指令擴增等同對 GNU 全旗標集做 denylist，
  違反 allowlist 優先原則。
- **Concern**：含引號片段的 glob（`"src"/*.md`）、含反斜線的 glob、`~` 開頭的 glob 仍為 ask。
  **Decision**：不支援。
  **Rationale**：保持判定簡單、fail-closed；agent 常見寫法不需要這些形態。
