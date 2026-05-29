# Bash 權限檢查器設計規格

## 目的

為 Claude Code 的 `PreToolUse` hook 提供一個自訂的 Bash 指令權限判斷器。
以 Deno 撰寫、`deno compile` 成單一執行檔，由 hook 在每次 Bash 工具呼叫前執行。

判斷器讀取 hook 傳入的 stdin JSON，解析 Bash 指令語法，判斷該指令是否為
「全部落在當前專案範圍內的純唯讀行為」。是則自動允許（`allow`），否則交付
使用者人工確認（`ask`）。**永不輸出 `deny`。**

## 範圍

- **僅處理 `Bash` 工具。** Read / Edit / Write 等檔案工具沿用 Claude Code
  內建權限機制，不在本模組範圍內。
- 不負責阻擋（`deny`）。本工具是「自動允許的收緊器」，最壞情況退化為 `ask`，
  把決定權交還使用者，而非取代既有的 deny 規則。

## 核心權限原則

判斷邏輯精神接近 Claude Code 的「Edit automatically」（自動允許安全操作、
其餘詢問），但採更嚴格的定義。對每一個指令呼叫，依下列三條規則判定：

1. **任何超出專案範圍的呼叫一律 `ask`。**（最高優先，凌駕其他規則）
2. **純唯讀且全部落在專案內的行為自動 `allow`。**
3. **其他一律 `ask`。**（保守預設——含專案內的寫入行為）

「自動允許範圍」明確界定：**僅當「指令呼叫形式命中 allowlist 規則」且「所碰到的
所有路徑與有效工作目錄都在專案內」時才 `allow`；其餘皆 `ask`。**

allowlist 不只是「唯讀指令清單」，而是「**自動允許規則集**」：預設內建的是經過
策劃的唯讀指令規則；使用者若信任某個會寫入的指令，可自行在 allowlist 新增一條
規則使其在專案範圍內自動允許。

## 關鍵設計決策

| 決策項目 | 選擇 | 理由 |
| --- | --- | --- |
| 工具範圍 | 僅 Bash | 聚焦；檔案工具沿用內建機制 |
| 唯讀判斷策略 | Allowlist + 每指令 flag 規則 | 最保守可控；同指令會因 flag 由讀變寫，不能只看指令名 |
| 專案邊界 | `$CLAUDE_PROJECT_DIR` 為根 | Claude Code 提供的最權威來源 |
| 規則維護 | 內嵌於原始碼（隨 binary compile） | 結構簡單、型別安全、無運行期讀檔成本 |
| 路徑追蹤深度 | 靜態可解析才判定，其餘 `ask` | 符合保守原則；動態值不臆測 |
| 專案內寫入 | `ask`（嚴格） | 信任的寫入指令由使用者自行加入 allowlist |
| 評估引擎架構 | 無狀態 per-command 分類器 + 最弱環節合併（方案 A） | 與「靜態算不出就 ask」契合，無需昂貴的直譯器 |

## 第三方相依：unbash

- 套件：`npm:unbash@3.0.0`（純 ESM、零相依、Deno 可直接匯入）。
- API：`import { parse } from "npm:unbash@3.0.0"`；`parse(source: string): Script & { errors?: ParseError[] }`。
- **容錯解析永不拋例外**；解析問題透過回傳的 `errors?: ParseError[]` 陣列回報
  （`{ message: string, pos: number }`）。
- AST 能力（皆已驗證支援）：pipeline（`|`）、邏輯運算（`&&` / `||`）、
  command substitution（`$(...)`、backtick，**遞迴解析內層指令**）、subshell
  `( … )`、brace group、redirection（`>` `>>` `<` `<<` `<<<` `<>` `<&` `>&`
  `&>` `&>>` `>|`）、parameter/arithmetic expansion、變數賦值前綴、for/while/
  until/if/case/function/select、quoting/escaping、glob 與 extended glob。
- `Command` 節點結構：`name`（指令名）、`prefix`（`Assignment[]`，即 `var=val`）、
  `suffix`（argv，即參數）、`redirects`（**在 Command 節點上，不在 Statement 上**）。
- `Word` 結構：純字面值的 `parts` 可能為 `undefined`；含展開/引號者帶
  `parts: WordPart[]`。查詢前須檢查 `word.parts` 是否存在；靜態字面值可由
  `word.value` 取得。

## 架構

### 模組拆解（`src/`）

每個檔案單一職責、可獨立測試：

```
src/
  main.ts              # 進入點：stdin JSON → 判定 → stdout，永遠 exit 0
  hook/
    types.ts           # HookInput / HookOutput / PermissionDecision 型別
    io.ts              # 解析 stdin、輸出 decision JSON
  project.ts           # 從 $CLAUDE_PROJECT_DIR 解析專案根（未設定 → 全部 ask）
  engine/
    evaluate.ts        # 主流程：parse → walk → 逐指令判定 → 合併
    parse.ts           # 包 unbash.parse，檢查 errors[]
    walk.ts            # AST 走訪 → CommandInvocation[]（含 cwd 脈絡）
    cwd.ts             # 工作目錄循序追蹤（cd / git -C，靜態才更新，否則標 unknown）
    scope.ts           # 路徑解析 + 是否落在專案內
    classify.ts        # 對單一指令套用 allowlist 規則
    combine.ts         # 最弱環節合併（任一 ask → ask）
  rules/
    types.ts           # CommandRule / RuleVerdict 型別
    allowlist.ts       # 彙整所有規則的索引
    commands/          # 每指令一檔：git.ts、sed.ts、grep.ts、coreutils.ts …
```

### 核心型別

```typescript
type Verdict = "allow" | "ask";

type CwdState =
  | { kind: "known"; path: string }   // 已解析的絕對路徑
  | { kind: "unknown" };              // 無法靜態確定（之後依賴 cwd 的判斷一律 ask）

interface CommandInvocation {
  name: string | null;       // 靜態解析出的指令名；動態（如 $CMD）→ null
  argv: Word[];              // unbash 的 suffix（含 .value，靜態時可取字面值）
  assignments: Assignment[]; // var=val 前綴
  redirects: Redirect[];     // 重導向（在 Command 節點上）
  cwd: CwdState;             // 此指令執行時的有效工作目錄
}
```

## 評估流程（engine/evaluate.ts）

1. `unbash.parse(command)` → 若 `errors.length > 0` → `ask`（「指令語法無法可靠解析」）。
2. `walk(script)` 列舉所有葉節點指令，並把 `CwdState` 穿過頂層循序語句。
   工作目錄的變動來源由 `cwd.ts` 在此階段統一識別：
   - 頂層 `cd <靜態路徑>` → 更新 cwd；`cd <動態>` 或無參數 `cd`（= `$HOME`）→
     自此 cwd 變 `unknown`。
   - `git -C <path>`：此參數**只覆寫本次 git 指令的有效 cwd**、不外洩到後續語句。
     `-C` 的識別與解析同樣在 `cwd.ts` 循序追蹤階段完成（與頂層 `cd` 同層級），
     **不在 git rule 內處理**；若 `<path>` 為動態或解析後落在專案外，該指令的
     `cwd` 即為 `unknown` / out-of-project。git rule 看到的 `ctx.cwd` 已是套用
     `-C` 後的結果。
   - subshell `( … )` / pipeline 段：內部 `cd` 不外洩（用 cwd 副本），但內部
     指令**仍逐一分類與範圍檢查**。
   - command substitution `$(…)` / backtick：內層指令在**當前 cwd 的副本**下執行
     （內部 `cd` 不外洩），內層指令**逐一納入分類與範圍檢查並參與最終 `combine`**
     （內層若 `ask`，整體即 `ask`）。此外其輸出為動態值，若被外層指令當作路徑
     參數使用，該路徑參數的 `resolvePath` 會回傳 `dynamic` → `ask`。
   - 控制流（if/for/while/case）：走訪所有分支本體收集指令；因無法靜態確定
     是否執行，迴圈/條件內的 `cd` 對其後語句的 cwd 影響 → 保守標 `unknown`。
3. 對每個 `CommandInvocation`（單一階段，範圍檢查內嵌於規則求值）：
   - `name` 為 null（動態指令名）→ `ask`。
   - 不在 allowlist → `ask`（規則 3）。
   - cwd 與寫入型重導向目標的範圍檢查由**中央前置邏輯**先做（見「指令規則模型」
     的中央前置規則）——這兩者不需要 argv 的路徑識別知識：cwd 落在專案外 / 為
     `unknown` 而後續有相對路徑時 → `ask`；寫入重導向 → 依中央規則處理。
   - 在 allowlist 且通過前置檢查 → 跑該指令規則。規則在 `evaluate` 內**自行宣告
     哪些 argv 是路徑**，對每個路徑參數呼叫 `ctx.resolvePath(arg)`；任一回傳
     `out-of-project` 或 `dynamic` → `ask`（規則 1）；否則 → `allow`。
     （路徑識別屬各指令的語意知識，故必然發生在 rule 內、而非 rule 之前。）
4. `combine`：任一指令 `ask` → 整體 `ask`（附首要原因）；全部 `allow` → `allow`。
5. 邊界：`parse` 成功（無 `errors`）且確認 AST 中**零個 Command 節點**（純註解 /
   空白 / 空字串）→ `allow`，理由：等同 no-op、不會發生任何事。此 allow 嚴格
   以「step 1 已通過、確實零指令」為前提；任何解析失敗的情形已在 step 1 擋成 `ask`。

## 範圍與路徑解析（engine/scope.ts）

- `projectRoot` = 正規化後的 `$CLAUDE_PROJECT_DIR`；**未設定 / 空 → 一律 `ask`**
  （「無法確定專案根目錄」）。
- 路徑判定：絕對路徑直接用；相對路徑 `join(cwd.path, arg)`（需 cwd 為 `known`）；
  **詞法**正規化 `..` / `.` 後，檢查是否等於根或在根之下。
- **僅做詞法正規化，不追 symlink**（hook 不碰檔案系統 → 零 FS 權限、零 cold-start
  I/O）。代價：專案內指向外部的 symlink 無法偵測，列為已知限制（可接受——本工具是
  「自動允許的收緊」、非對抗性安全邊界，且預設就是 `ask`）。
- 含展開部位（變數 / `$()` / 可逸出 glob）的動態路徑 → 視為動態 → `ask`。
- **`resolvePath(arg)` 契約**（三態）：`in-project`（靜態解析且落在根之下）、
  `out-of-project`（靜態解析但落在根外）、`dynamic`。其中 `dynamic` 同時涵蓋兩種
  情形：(a) arg 含展開部位無法靜態求值；(b) arg 為相對路徑但 `cwd.kind ===
  "unknown"`、無法靜態定位。`out-of-project` 與 `dynamic` 皆 → `ask`（規則 1）。
- **「哪個參數是路徑」由各指令規則在 `evaluate` 內宣告**（例如 `grep PATTERN
  FILE…` 中第一個非 flag 是 pattern、其餘是路徑），rule 對其宣告的路徑參數呼叫
  `ctx.resolvePath`。路徑識別是各指令的語意知識，故必然發生在 rule 內，而非由一個
  rule 之外的通用「先範圍檢查」階段完成（後者無從得知 argv 語意）。

## 指令規則模型（rules/types.ts）

`RuleContext` 由 `CommandInvocation` 投影建構；`name` 為已確認非 null 的靜態指令名
（null 名稱在進 rule 前已被 step 3 擋為 `ask`），供需依「實際被呼叫的名字」分歧的
規則（如別名 `egrep` / `fgrep` / `rg`）使用。

```typescript
interface RuleContext {
  name: string;              // 已確認非 null 的靜態指令名（含實際別名）
  argv: Word[];
  redirects: Redirect[];
  assignments: Assignment[];
  cwd: CwdState;
  // helper：解析某參數並做範圍檢查
  resolvePath(arg: Word): "in-project" | "out-of-project" | "dynamic";
}

type RuleVerdict =
  | { kind: "allow" }                  // 此呼叫形式可自動允許
  | { kind: "ask"; reason: string };   // 交付人工

interface CommandRule {
  names: string[];                     // 此規則涵蓋的指令名（含別名）
  evaluate(ctx: RuleContext): RuleVerdict;
}
```

**中央前置規則（在跑個別 rule 前統一套用）**：任何寫入型重導向（`>` `>>` `>|`
`&>` `<>`）一律使該指令 → `ask`（除非該指令規則明確 bless，預設不 bless）。
這實現「專案內寫入也 ask」。個別指令規則**不需也不應**重複判斷寫入重導向；
重導向的允許 / 詢問完全由本中央前置規則決定，allowlist 中所有讀取型指令的規則
只需處理其 argv 與 flag 語意。

**重導向目標特例**：

- 寫入型重導向若目標為 null 裝置（POSIX `/dev/null`；Windows `NUL`，不分大小寫），
  視為「無副作用」，**不觸發 ask**，且其路徑不納入專案範圍檢查（涵蓋
  `grep foo file 2>/dev/null`、`cmd > /dev/null 2>&1` 等常見唯讀慣用法）。
- 純 fd 複製（`2>&1`、`>&` 之類，無檔案目標）不算寫入型重導向，不觸發 ask。
- 其餘所有寫入型重導向目標一律 `ask`（即使落在專案內，貫徹「專案內寫入也 ask」）。

## 預設 allowlist 內容（rules/commands/）

**讀取型 coreutils（allow，路徑做範圍檢查）**：
`cat` `head` `tail` `wc` `ls` `tree` `stat` `file` `pwd` `echo`
`which` `date` `whoami` `basename` `dirname` `realpath` `readlink` `cut` `sort`
`uniq` `tr` `column` `cmp` `diff` `comm` `md5sum` `sha256sum` `xxd` `hexdump`
`jq` `yq` `less` `nl` `fold`。

**有 flag 條件的指令**：

- `sed`：含 `-i` / `--in-place` → `ask`；否則 `allow`（涵蓋 `sed -n '30,45p' file`）。
- `find`：含 `-delete` / `-exec` / `-execdir` / `-ok` / `-fprint` 等 → `ask`；
  純搜尋列出 → `allow`。
- `grep` / `rg` / `egrep` / `fgrep`：讀取 → `allow`（寫重導向由中央規則擋）。
- `git`：依**子指令**判定——
  - `allow`：`status` `log` `diff` `show` `blame` `rev-parse` `describe`
    `branch`（僅列出，無 `-d` / `-D` / `-m`）`tag`（僅列出）`remote -v`
    `cat-file` `ls-files` `ls-tree` `for-each-ref` `config --get` / `--list`
    `stash list` `reflog` `shortlog` `grep`。
  - `ask`：`commit` `add` `push` `pull` `fetch` `checkout` `switch` `restore`
    `reset` `merge` `rebase` `clean` `rm` `mv` `stash`（push / pop）`apply`
    `init` `clone` `worktree` `config`（set / unset）。
  - `git -C <path>`：覆寫該次指令的有效 cwd，於 `cwd.ts` 階段識別與範圍檢查
    （見評估流程 step 2），git rule 收到的 `ctx.cwd` 已套用 `-C`；`-c key=val`
    視為無害。

**預設排除（→ `ask`，需手動信任才加入）**：
`rm` `mv` `cp` `mkdir` `touch` `chmod` `chown` `ln` `dd` `tee` `truncate`
`kill`；`curl` `wget` `ssh`（網路）；`docker` `make` 及各種 build / test runner
（執行任意碼）；`npm` / `pnpm` / `yarn`（`test` / `run` 執行任意碼，整包排除，
僅使用者信任時自行加 `ls` / `view`）；`awk`（script 內可 `print > file` /
`system()`，靜態難分析）；`xargs` `find -exec` `eval` `source` / `.` `bash -c` /
`sh -c`（執行我們看不到的其他指令）。

## 失敗模式與輸出契約

- **永遠 exit 0**；整個評估包在 try / catch，任何例外 → `ask`（「權限檢查器內部
  錯誤，保守交付人工確認」）——絕不因錯誤而 `allow`，也絕不讓 hook 崩潰。
- `tool_name !== "Bash"`：**不輸出任何 permissionDecision**（exit 0），交回
  Claude Code 預設流程（防禦性，matcher 本就只掛 Bash）。
- 輸出嚴格為：

  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"..."}}
  ```

  `permissionDecision` 取 `allow` 或 `ask`。
- **永不輸出 `deny`。** `reason` 在 `ask` 時帶首要原因（含是哪個指令 / 路徑）、
  `allow` 時給簡短摘要。

## 測試策略

- 引擎為純函式（`command + projectRoot + cwd → Verdict`），用 `deno test`
  表格驅動，免 FS、免真 hook。
- 案例涵蓋：唯讀 allow（`grep` / `sed -n` / `git diff` / `cat` 於專案內）、
  null 裝置重導向 allow（`grep foo file 2>/dev/null`、`cmd > /dev/null 2>&1`）、
  範圍逸出（`cat /etc/passwd`、`cd /tmp && ls`、`../` 逸出）、寫入（`sed -i`、
  `git commit`、`> redirect`、`mkdir`）、動態（`$VAR` 路徑、`$(...)`、glob）、
  cwd 未知後的相對路徑（`cd $X && cat f` → `dynamic` → ask）、`git -C` 逸出與
  在專案內、組合（pipe 中一段寫入、`&&` 串接、subshell、command substitution
  內層寫入）、空指令 / 純註解 → allow、解析錯誤、未知指令、信任擴充（加一條
  fake 規則 → allow）。
- 薄整合測試：JSON 餵 stdin 給 `main.ts`，斷言 stdout JSON。
- 強制驗證：`deno check`（型別）+ `deno lint` + `deno test` 全綠才算完成。

## Build 與 hook 接線

- `deno compile --allow-env=CLAUDE_PROJECT_DIR --output dist/permission-checker src/main.ts`
  → 單一執行檔。`npm:unbash` 於 `deno compile` 時嵌入 binary，執行期不需網路或
  npm 解析。**「不需 `--allow-read`」僅就路徑檢查邏輯本身而言**（純詞法、不碰
  FS），與 npm 嵌入機制為兩個獨立宣稱。`--allow-env` 暫限定 `CLAUDE_PROJECT_DIR`；
  若 compile 後執行期報缺其他環境變數權限（屬實作期 operational verification），
  依實際錯誤訊息補列所需 env，不在純詞法路徑檢查的權限宣稱範圍內。
- `deno.json` 提供 task：`deno task build` / `test` / `check` / `lint`。
- 接線（`~/.claude/settings.json`，Windows 直接指向 `.exe` 絕對路徑）：

  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            { "type": "command", "command": "D:\\...\\dist\\permission-checker.exe" }
          ]
        }
      ]
    }
  }
  ```

- 隨附 README：build 步驟、接線方式、如何新增信任指令（在 `commands/` 加一條
  `CommandRule` 並重新 compile）。
- 效能：hook 每次 Bash 都跑，unbash 快、Deno 編譯檔 cold-start 約數十 ms，可接受。

## 已知限制

- 不追 symlink，專案內指向外部的 symlink 無法偵測（詞法檢查）。
- 不對動態值（變數、`$()`、可逸出 glob）求值，一律退化為 `ask`。
- allowlist 為策劃清單，未涵蓋的指令一律 `ask`；新增需改碼重新 compile。
