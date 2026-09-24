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

§1 規則 4 規定可能展開成旗標的 glob 必須是單段，因此被注入的 token 就是 cwd 內的某個檔名，**不可能含 `/`**。

- **head**：旗標只控制輸出數量與格式，被注入也無害。
- **grep/egrep/fgrep**：沒有寫檔或 exec 類旗標。
  - 注入 `-r`/`-R` 只會遞迴 cwd 內、已通過範圍檢查的操作元。
  - 注入 `-f<name>`/`--file=<name>` 讀取的是 cwd 內的檔案。
  - **但注入會翻轉位置參數的分類**。例如 cwd 有名為 `-e^` 的檔案時，`grep /outside/secret *`
    展開後帶有明確的 `-e` pattern，GNU grep 便把原本的 PATTERN `/outside/secret` 當成檔案並印出其內容。
    同理，注入一個吃值的旗標，也可能吞掉後面合法的 `-e`，把它的值推回位置參數。
    因此只要某個 token 可能被注入翻成檔案操作元，就必須做範圍檢查，見 §2 的「注入護欄」。
- **wc**：`--files0-from=<name>` 會讀 cwd 內 `<name>` 所列的任意路徑，並輸出其**計數與檔名**。
  這是殘留風險，見 Non-goals / Accepted limitations。

## 設計

### §1 `src/engine/glob.ts`：glob word 詞法判定（純函式、不碰檔案系統）

```ts
export interface GlobPath { prefix: string }            // 字面前綴目錄；"" 代表 cwd
export function parseGlobPath(word: Word): GlobPath | null;
export function isGlobAttachedValue(word: Word, flagName: string): boolean;
export function mayExpandToOption(word: Word): boolean;  // value 的第一個字元是未跳脫的 * ? [
```

`mayExpandToOption` 為 true 表示該 glob 沒有字面前綴，展開結果的第一個字元取自 cwd 內的檔名，
所以可能以 `-` 開頭而被當成旗標。

`parseGlobPath` 只有在以下條件**全部**成立時才回非 null。

**字形前提**
1. `word.parts` 為 `undefined`（整個 word 完全未加引號）。
2. `word.value` 至少含一個未跳脫的 `*`、`?` 或 `[`，而且**不含反斜線**。
3. 不以 `-` 開頭，也不以 `~` 開頭；並且不是磁碟相對形態，即 `scope.ts` 的 `isDriveRelative` 為 false。
4. **可能展開成旗標的 glob 必須是單段**：若 value 的第一個字元是未跳脫的 `*`、`?` 或 `[`（即
   `mayExpandToOption` 為 true），value 就不得含 `/`。
   原因：多段 glob 的展開結果會帶有 `/`。例如專案內有名為 `-f` 的目錄時，`*/outside/secret` 會展開成
   `-f/outside/secret`，grep 就把 `/outside/secret` 當成 pattern 檔讀取。只有單段 glob 能保證被注入的
   token 不含 `/`，於是任何被注入的旗標值都只能指向 cwd 內的某個檔名。
   此規則不看 `--` 的位置，以保持判定簡單並涵蓋 legacy 路徑；需要多段時請寫成 `./*/x.md`。

**切段**：以 `/` 切段。第一個含 glob 字元的段稱為 *G*。*G* 之前的所有段依原樣以 `/` 連接，就是 `prefix`：

- value 以 `/` 開頭時，`prefix` 保留開頭的 `/`，例如 `/*.md` → `prefix = "/"`；
- 前綴只剩磁碟機代號時補回分隔符，例如 `C:/*.md` → `prefix = "C:/"`（否則會被當成相對路徑解析到 cwd 內）；
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
- `=` 之後的部分含未跳脫 glob 字元，且整個 value 不含反斜線；
- 整個 value **不含 `/`**。bash 會把整個 word 當成路徑 pattern 展開；單段就只會匹配 cwd 內的項目，
  不會經由 `..` 或 `**` 遍歷到 cwd 之外。多段形態（`--include=*/../../../**`）一律拒絕，維持 dynamic → ask。

### §2 範圍判定與規則接線

**`scope.ts` 新增 `resolveGlobPath(arg: Word, cwd: CwdState, scope: ScopeConfig): PathScope`**
1. `parseGlobPath(arg)` 為 null → `"dynamic"`。
2. 把 `prefix` 解析成絕對路徑 *P*：
   - `prefix === ""` 時，cwd 為 known 取 `cwd.path`，否則回 `"dynamic"`；
   - 其餘情形沿用 `resolveResolvedValue` 相同的絕對/相對語義，相對路徑以 cwd 為基準，cwd unknown → `"dynamic"`。
3. **目錄涵蓋判定**（不使用 `isReadScoped`，因為它會接受 `scope.allow.files` 的精確單檔匹配，
   而精確單檔的 allow 不得擴大成涵蓋其子路徑）：
   - `isWithin(scope.root, P)` → 視為涵蓋，跳到步驟 5；
   - 否則若 `scope.deny` 或 `scope.ask` 命中 *P*（roots 用 `isWithin`、files 用精確相等）→ `"out-of-project"`；
   - 否則若 `scope.allow.roots` 或 `scope.trusted` 有某個 root 使 `isWithin(root, P)` 成立 → 涵蓋，進入步驟 4；
   - 其餘（包括 *P* 只命中 `scope.allow.files`）→ `"out-of-project"`。
4. **巢狀否決**（只在 *P* 位於專案根之外時執行）：`scope.deny` 或 `scope.ask` 若有任何 root 或 file
   嚴格位於 *P* 之下 → `"out-of-project"`。*P* 在專案根內時不做此檢查，維持 root-first 語義。
5. 其餘 → `"in-project"`。

**`scope.ts` 新增 `globMaySelectDangerousRoot(arg: Word, cwd: CwdState, home: string | null): boolean`**
- `parseGlobPath(arg)` 為 null → false，因為這種 word 本來就不會被當成 glob 操作元接受。
- 依上述步驟 2 把 `prefix` 解析成 *P*；cwd unknown 且前綴為相對路徑時回 **true**（fail-closed）。
- 以下任一成立就回 true：
  - `isDangerousRootAbs(P, home)`：*P* 就是 `/`、`X:/` 或家目錄。展開結果是其子項，例如 `/home/me/*`。
    這在效果上等同遍歷整個根，而 `/` 在 Windows 的子項 `/c` 就是磁碟根。
  - `home !== null && isWithin(P, normalizeAbsolute(home))`：*P* 是家目錄的祖先，glob 可能選中家目錄本身，
    例如 `/home/m?`。

`RuleContext` 新增兩個**選填**方法（repo 內 18 個測試檔各自手寫 `RuleContext` 字面量，必填會強迫全部修改）：
- `resolveGlobPath?(arg: Word): PathScope`；缺席時呼叫端視同 `"dynamic"`（fail-closed → ask）；
- `globMaySelectDangerousRoot?(arg: Word): boolean`；缺席時呼叫端視同 `true`（fail-closed → deny）。
`classify.ts` 永遠提供兩者，綁定 cwd 與 `scope.home`，與 `isDangerousRoot` 同源。

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
- `evaluateWithSpec` 的判定順序：
  1. 既有的遞迴危險根 deny；
  2. **glob 危險根閘門**，傳入 `globOperands` 與 `p.isRecursive`；
  3. 既有的 dynamic、未知旗標、`pathValues`、`pathOperands` 檢查；
  4. 對 `globOperands` 逐一呼叫 `ctx.resolveGlobPath`，任何一個不是 `in-project` 都 ask，
     理由為 `${name}：glob 路徑超出專案範圍或無法靜態解析（${value}）`；
  5. 注入護欄。
  兩道閘門只在 `globOperands` 非空時才有作用。
- `cwdIndependentWhenNoPaths` 述詞額外要求 `p.globOperands.length === 0`。

**legacy 路徑（cat、ls）**
- `FlagGatedReaderOptions` 新增 `globOperandNames?: string[]`，`fileReaderRule` 設為 `["cat", "ls"]`。
- 判定順序：
  1. 既有的遞迴危險根 deny；
  2. **glob 危險根閘門**：先收集 glob 操作元，即 `ctx.name` 在 `globOperandNames` 內、且 `parseGlobPath` 成立的位置參數；
     再以既有的 `recursive` 結果呼叫閘門；
  3. 既有的 `pathValueFlags` 檢查；
  4. 位置參數迴圈，其中 glob 操作元改呼叫 `ctx.resolveGlobPath(arg)`，其餘沿用 `ctx.resolvePath(arg)`；
  5. 注入護欄。
- **ls 遞迴偵測補強**（危險根閘門的前提）：`fileReaderRule.recursive` 對 ls 目前只認完整 token `-R`、`--recursive`，
  漏掉 `-lR` 這種短旗標群集。改為：除上述兩者外，任何「以單一 `-` 開頭、不含 `=`、長度 ≥ 2、第 2 字元之後含 `R`」
  的 token 也視為遞迴，與 `grep.ts` 的 `shortClusterHasR` 同一形式。
  這會多判（例如 `-wR` 裡的 `R` 其實是 `-w` 的值），但方向安全。
  **這同時修正既有缺口**：明寫的 `ls -lR ~`、`ls -lR /` 從 allow 收緊為 deny。
- 其他 legacy 行為（未知旗標放行、`pathValueFlags`）不變。

**glob 危險根閘門（兩條路徑共用，`factory.ts` 的 `globRootGate(ctx, globWords, isRecursive): RuleVerdict | null`）**

放在任何可能回 ask 的檢查之前，確保硬 deny 不會被 ask 搶先返回。
- `globWords` 為空 → null（通過）。
- `injectable` = `globWords` 中有任何 word 使 `mayExpandToOption` 為 true。
  被注入的 `-r`/`-R` 可能讓非遞迴呼叫變成遞迴，例如 `grep x ?r ~` 遇到名為 `-r` 的檔案。
- `globstar` = `globWords` 中有任何 word 含一個恰為 `**` 的段。開啟 globstar 時，shell 展開本身就會遞迴遍歷前綴目錄，
  例如 `cat /home/me/**/*.md`；未開啟時它等同 `*`，屬於安全方向的誤判。
- 若 `isRecursive || injectable || globstar`：
  - `globWords` 中若有任何 word 使 `ctx.globMaySelectDangerousRoot` 為 true → `deny(recursiveRootDenyReason(ctx.name, word.value))`；
  - 若 `injectable`，`ctx.argv` 中其餘 Word 若有任何一個使 `ctx.isDangerousRoot` 為 true → 同樣 deny。
    明確遞迴時，其餘 Word 已由既有的遞迴 deny 檢查過。
- 其餘 → null。

此閘門不受任何讀取範圍放寬影響（`Read(~/**)` 等），以維持「遞迴遍歷磁碟根/家目錄根 = 硬 deny」這個不變量。

**注入護欄（兩條路徑共用，`factory.ts` 的 `injectionGuard(ctx, globWords)`）**

被注入的旗標可能改變**任何**其他 token 的解讀方式：
- 注入 `-e`/`-f` → 原本的 PATTERN 變成檔案；
- 注入 `--` → 其後的旗標 token（例如 `--label=/../../secret`）變成檔案操作元；
- 注入吃值旗標（例如 `-f`）→ 下一個 token（不論它是不是旗標）被當成路徑值讀取。

因此護欄不區分 token 的種類，規則如下：
1. 若 `globWords` 中沒有任何 word 使 `mayExpandToOption` 為 true → 通過。
   有字面前綴的 glob（`./*.md`、`src/*.md`）不可能展開成旗標。
2. 否則，對 `ctx.argv` 中**不在 `globWords` 之內的每一個 Word**（包括旗標 token、旗標值、PATTERN），
   都呼叫 `ctx.resolvePath`，把它當成「可能被讀取的路徑」檢查。任何一個不是 `in-project` 都 ask，
   理由為 `${name}：glob 可能展開成旗標，${value} 可能被當成檔案讀取且超出範圍`。
   非靜態的 token（例如 `--include=*.md`）在這裡會得到 `dynamic` → ask。
3. 此外，以 `-` 開頭的每個其他 Word（取 `staticValue`），都必須完全由 `[A-Za-z0-9_=.,+-]` 組成，否則 ask。
   原因：被注入的吃值旗標可以吞掉原本的旗標，使原本只是「值」的 token 變成有效旗標；例如
   `grep ?e -e --file=/outside/secret ./safe.txt` 遇到名為 `-e` 的檔案時，`--file=/outside/secret` 就會生效。
   禁止 `/`、`\`、`:`、`~` 之後，任何可能生效的黏寫值（`--file=x`、`-fx`）都只能指向 cwd 內的某個檔名。
   一般旗標如 `-rn`、`-m5`、`--color=auto`、`--max-count=5` 不受影響。

效果：
- 一般旗標（`-n`、`-la`、`-rn`）、一般 pattern（`"careTreatment\|WebApi"`）、數值（`-m 5` 的 `5`）
  都解析成 cwd 內的相對路徑 → in-project，照常 allow。
- `grep /outside/secret *.md`、`grep *.md -e /outside`、`grep -e . ?? --label=/../../secret`、
  `cat *.md --x=/../../secret` → ask。
- 為了簡化，護欄**不看字面 `--` 的位置**：`grep /outside/secret -- *.md` 也會 ask。
  同時帶有裸 glob 與非靜態旗標值者（例如 `grep -n x *.md --include=*.md`）也會 ask。這兩者都是安全方向的誤 ask。

**刻意不變**
- `classify.ts` 的 cwd 豁免護欄 (4) 使用 `staticValue`，glob token 不算靜態，所以不豁免。
- `permissions/matcher.ts` 的 `reconstructCommand` 對 glob token 回 null，所以不升級。
- 規則四的 `<` 目標仍走 `resolvePath`：`cat < *.md` → ask。
- 既有的遞迴危險根 deny 判定不變。glob 相關的危險根由上述閘門另外處理：`grep -r x /*`、`grep -r x /home/m?`
  現在回 deny（以前因為是動態 token 而 ask），方向更嚴。

### §3 錯誤處理

沒有新增的例外路徑：`parseGlobPath`、`isGlobAttachedValue`、`resolveGlobPath` 都是純函式，
不合格的形態回 null 或 `"dynamic"`，再由既有流程落到 `ask`。`main.ts` 既有的 try/catch 仍把
任何意外轉成 `ask`，並一律 `exit 0`。

## 測試計畫

- **`src/engine/glob_test.ts`**
  - `parseGlobPath` 接受並回傳對應 prefix：`*.md` → `""`、`runtime-behavior/*.md` → `runtime-behavior`、
    `src/**/*.ts` → `src`、`./*.md` → `.`、`./*/x.md` → `.`、`/d/proj/*.md` → `/d/proj`、`../x/*.md` → `../x`、`/*.md` → `/`。
  - `parseGlobPath` 拒絕：`*/outside/secret`、`*/x.md`（可能展開成旗標的多段 glob）、`-*`、`~/*.md`、`"src"/*.md`、`src/\*.md`、`C:*.md`、`sub*/../x`、`.*`、`sub/.*`、
    `[.]*`、`x/[ab]*`、`a.md`（無 glob）。
  - `isGlobAttachedValue`：`(--include=*.md, --include)` 為 true；`(--include=a.md, --include)` 為 false；
    `(--exclude=*.log, --include)` 為 false；`(--include=*/../../../**, --include)`、`(--include=src/*.md, --include)` 為 false。
- **`src/engine/scope_test.ts`**
  - `resolveGlobPath` 三態：專案內前綴 → in-project；專案外前綴 → out-of-project；cwd unknown 且前綴相對 → dynamic。
  - 外部 allow root 內有巢狀 deny/ask 時 → out-of-project；外部 allow root 內沒有巢狀 deny → in-project。
  - `Read(//outside/data)` 這類精確單檔的 allow：`/outside/data/*` → out-of-project；
    `Read(//outside/data/**)` 這類 allow root：`/outside/data/*` → in-project。
  - `globMaySelectDangerousRoot`：`/*`、`/home/me/*`、`/home/m?`、`/h*/me`（前綴 `/`）→ true；
    `/home/me/src/*` → false；cwd unknown 且前綴為相對路徑 → true。
  - Windows 的 `/d/` 形態以 `Deno.build.os` 分支。
- **`src/engine/glob_test.ts`（補充）**：`mayExpandToOption` 對 `*.md`、`?x`、`[ab]x` 為 true；
  對 `./*.md`、`src/*.md` 為 false。
- **規則測試**（`command_spec_test.ts`、`grep_test.ts`、`coreutils_test.ts`）
  - allow：`wc -l *.md`、`head *.md`、`grep -n x *.md sub/*.md`、`grep -rn x --include=*.md .`、
    `cat src/*.ts`、`ls *.md`。
  - ask：`grep *.md f`、`grep -e *.md f`、`grep -f *.x f`、`wc --files0-from=*.x`、`stat *.md`、
    `cat ../*.md`（前綴在範圍外）、`ls .*`。
  - 清單外規則維持 ask：`tail *.md`、`diff *.md x`、`sort *.md`。
  - 注入護欄：
    - ask：`grep /outside/secret *.md`、`grep *.md -e /outside`、`head *.md -n /outside/x`、
      `grep -e . ?? --label=/../../secret`、`cat *.md --x=/../../secret`、`ls -la *.md --hide=/../../x`、
      `grep /outside/secret -- *.md`（護欄不看 `--`）、`grep -n x *.md --include=*.md`、
      `grep ?e -e --file=/outside/secret ./safe.txt`、`grep ?e -e -f/outside/secret ./safe.txt`、
      `grep ?e -e --file=C:secret ./safe.txt`；
    - deny（在 `Read(~/**)` 或 `Read(//C:/**)` 放行家目錄/磁碟根的設定下也一樣，且在一般只含專案範圍的設定下
      也必須是 deny、不得被 ask 搶先）：`grep x ?r ~`、`ls ?R /`、`grep -r x /home/m?`（home=`/home/me`）、
      `grep -r x m?`（cwd=`/home`）、`grep -r x /*`、`ls -R /home/me/*`、
      `cat /home/me/**/*.md`、`head /**/*.md`、`grep x /home/me/**/*.md`（globstar 視為遞迴）、
      `ls -lR /home/me/*`、`ls -lR /*`，以及沒有 glob 的 `ls -lR ~`、`ls -lR /`（群集遞迴偵測，既有行為收緊）；
    - allow：`ls -la *.md`、`ls -lR src`（`-lR` 視為遞迴，但目標不是危險根）；
    - allow：`cat src/**/*.ts`（專案內前綴、非危險根）；
    - 非遞迴、無注入風險時不觸發閘門：`cat /home/me/*.md`、`grep x /home/m?/a.md` 依一般範圍判定（前綴在專案外 → ask，不是 deny）；
    - allow：`grep "a\|b" *.md`、`grep -m 5 x *.md`、`grep -rn x *.md`、`ls -la *.md`、
      `grep /outside/secret ./*.md`（有字面前綴、不會注入，所以不套用護欄）。
- **`src/engine/classify_test.ts`**
  - `cat < *.md` → ask。
  - `cd /outside && wc -l *.md`（chain-cd）→ ask，因為不豁免。
  - `permissions.allow` 含 `Bash(stat *)` 時，`stat *.md` 仍為 ask。
- **Operational verification**：在 `scripts/verify-hook-binary.ts` 的 `CASES` 加入三條範例指令（期望 allow），
  以及 `cat < *.md`、`stat *.md`、`grep *.md f`、`ls .*`、`grep /outside/secret *`（期望 ask）。
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
- **Concern**：開啟 nullglob 且無任何匹配時，`grep -r x safe/*.txt` 會變成 `grep -r x`，改為遞迴搜尋 cwd。
  若 cwd 位於以 `Read()` 放寬的外部 root，而其下又有 deny/ask 子目錄，就可能讀到被否決的內容。
  **Decision**：不實作防護。
  **Rationale**：這與既有的 `grep -r x .` 完全相同（今天在同樣情境下本來就 allow），glob 支援沒有讓它更差；
  而且需要 nullglob、外部 cwd、巢狀 deny 三個條件同時成立。使用者評估後接受。
- **Concern**：開啟 nullglob 且無任何匹配時，遞迴 grep/ls 的 glob 操作元全部消失，改為遞迴隱含的 cwd。
  若 cwd 本身是家目錄或磁碟根（且已用 `Read()` 放行），硬 deny 會被繞過，例如 `grep -r x /home/me/p/no-*.txt` 在 cwd=`/home/me` 時。
  **Decision**：不實作；glob 危險根閘門不檢查隱含的 cwd。
  **Rationale**：展開結果等同不帶操作元的 `grep -r x`、`ls -R`，而現有工具在同樣情境下本來就回 allow
  （2026-09-23 以編譯後的 binary 實測確認，只有明寫 `.` 時才 deny），glob 支援沒有讓它更差。
  這個既有缺口應另外處理，不在本 spec 範圍內。使用者裁決接受。
- **Concern**：清單外的指令（tail、stat、diff、sort、find、git 等）含 glob 仍為 ask。
  **Decision**：清單固定，不提供擴增機制。
  **Rationale**：旗標注入無法由本工具的旗標解析器觀察到；逐指令擴增等同對 GNU 全旗標集做 denylist，
  違反 allowlist 優先原則。
- **Concern**：含引號片段的 glob（`"src"/*.md`）、含反斜線的 glob、`~` 開頭的 glob 仍為 ask。
  **Decision**：不支援。
  **Rationale**：保持判定簡單、fail-closed；agent 常見寫法不需要這些形態。
