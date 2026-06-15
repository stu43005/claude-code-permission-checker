# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 這是什麼

一個 Claude Code `PreToolUse`（matcher: `Bash`）hook：用 Deno 寫、`deno compile` 成單一執行檔。
解析 Bash 指令，只在「純唯讀且全部落在當前專案內」時回 `allow`，其餘回 `ask`。**僅對「遞迴遍歷磁碟根/家目錄根的唯讀指令」回 `deny`（硬性、不可由 `permissions.allow` 解除）；其餘（一切非遞迴根掃描）一律維持 `allow` / `ask`、不回 `deny`。**
從 stdin 收 hook JSON、往 stdout 寫 decision JSON、**永遠 `exit 0`**。

此外，會在 runtime 讀取使用者的 `permissions.allow`：原本會 `ask`、但已被使用者在 settings.json 明確放行
（且未被 `deny`/`ask` 命中）的指令，升級為 `allow`（見「hook 決策 vs settings.json 權限的優先序」）。

## 指令

```bash
deno task test     # 單元 + 整合測試（已含 --allow-run --allow-env --allow-read，e2e 子行程測試需要）
deno task check    # 型別檢查
deno task lint
deno task build    # 產出 dist/permission-checker(.exe)；dist/ 已 gitignore，不入版控
```

- 跑單一測試檔：`deno test --allow-env src/engine/scope_test.ts`
- 跑單一測試：`deno test --allow-env --filter "isWithin" src/engine/scope_test.ts`
- **`main_test.ts` 是子行程 e2e 測試**，單獨跑時要帶完整權限：
  `deno test --allow-run --allow-env --allow-read src/main_test.ts`

**Operational verification（改規則後務必做）**：`deno task build` 後直接餵 JSON 給 binary 驗證真實行為，
不要只信單元測試：

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cat README.md"},"cwd":"D:/proj"}' \
  | CLAUDE_PROJECT_DIR="D:/proj" ./dist/permission-checker.exe   # 期望 allow、exit 0
```

**⚠️ binary 回 `allow` 但 builtin 應為 `ask` 時，先檢查 settings.json——這不是失敗，是功能正常**：
operational verification 會讀取真實的 settings.json（含使用者 `~/.claude/settings.json`，三來源 union）。
若某指令 builtin 判 `ask`、單元測試也判 `ask`，但 binary 卻回 `allow`，且 reason 為「命中 permissions.allow」，
代表該指令被 `permissions.allow`（如 `Bash(deno test *)`）升級了——這正是 `(hook=ask, settings=allow) → allow`
的設計行為（見下「hook 決策 vs settings.json 權限的優先序」），**屬合法、不是 bug**。要單獨驗證 builtin 分類
本身，請以單元測試（rule 的 `evaluate`）為準，或在不含對應 `permissions.allow` 的環境下餵 JSON。

## 架構（評估管線）

`main.ts` 讀 stdin → 若 `tool_name !== "Bash"` 直接 return（不輸出）→ `resolveProjectRoot`（讀
`$CLAUDE_PROJECT_DIR`；未設定 → ask）→ `loadPermissionRules`（讀三個 settings 檔，見 `permissions/`）→
`evaluate(…, rules)`：

```
parse.ts (unbash)  →  walk.ts  →  classify.ts (每指令)  →  combine.ts (最弱環節)
   解析成 AST        攤平成          中央前置檢查 +            任一 deny → 整體 deny；否則任一 ask → 整體 ask
   errors → ask     CommandInvocation[]   allowlist rule
```

- **`walk.ts`** 把 AST 攤平成 `CommandInvocation[]`，每個葉指令一筆。負責：穿透 cwd（`cd` 在
  `&&`/`BraceGroup` 持久、subshell/pipeline 不持久、控制流含 cd → 之後標 unknown）、列舉
  command substitution `$(…)` 內層指令、把 Statement / 複合結構的重導向繼承給內部指令、對 `git`
  套用 `gitEffectiveCwd`（`-C`/`--git-dir`/`--work-tree`/`-c core.worktree`）。
- **`classify.ts`** 分兩層：`classifyBuiltin` 對單一指令依序判定（`name` 為 null（動態）→ ask；不在
  allowlist → ask；**三條中央前置規則**（見下）→ ask；最後跑該指令的 `CommandRule.evaluate`）；外層
  `classify(inv, root, rules)` 在 builtin 判 `ask` 時，呼叫 `settingsAllows` 嘗試以 `permissions.allow`
  升級為 `allow`（命中 allow 且未被 deny/ask 命中才升級；builtin 已判 `allow` 者原樣返回，不受 rules 影響）。
  此外，builtin 回 `deny`（遞迴遍歷磁碟根/家目錄根，由 `scope.ts` 的 `dangerousRoot` 偵測、經 `RuleContext.isDangerousRoot` 提供給規則，接於 find/tree/ls -R/grep -r/rg 的遞迴閘門）時**先於升級層短路返回**，不經 `settingsAllows`，故 `permissions.allow` 無法解除此 deny。
- **`scope.ts`** 純詞法路徑解析（不碰檔案系統）。`resolvePath`/`resolvePathValue` 回三態
  `in-project` / `out-of-project` / `dynamic`，後兩者 → ask。
  另提供 `isDangerousRootAbs`/`dangerousRoot` 危險根偵測（字面 `~`/`~/`、lone `$HOME`/`${HOME}`/`$HOME/`、Windows `$USERPROFILE`、靜態絕對等於磁碟根 `/`、`X:/` 或家目錄），供遞迴指令回 `deny`。
- **`rules/`**：`types.ts`（`CommandRule`/`RuleContext`/`RuleVerdict` + `allow()`/`ask()`）、
  `flags.ts`（flag matcher、positionals）、`factory.ts`（`flagGatedReader`）、
  `allowlist.ts`（name → rule 索引，載入時偵測重複 name）、`commands/*.ts`（每類指令一檔）。
- **`permissions/`**：`settings.ts`（`loadPermissionRules`：讀專案 `.claude/settings.json`、
  `.claude/settings.local.json`、使用者 `~/.claude/settings.json`，抽出 `permissions.{allow,deny,ask}` 中
  的 `Bash(...)` 規則並 union；家目錄依平台解析 `USERPROFILE`/`HOME`；fail-safe：讀檔/解析失敗退化為空
  規則、永不丟例外/回 null）、`matcher.ts`（`parseBashRule` 解析 `Bash(...)`、`matchesPattern`/`matchesAny`
  字串匹配、`reconstructCommand` 把 invocation 還原成可比對字串、`settingsAllows` 綜合判定）。`matcher.ts`
  對 `settings.ts` 僅 `import type`（型別循環編譯期抹除，無 runtime 循環）。

### 三條中央前置規則（在跑個別 rule 之前，於 classify.ts；個別 rule 不需重複處理）

（註：對「遞迴遍歷磁碟根/家目錄根」的 `deny` 不是中央前置規則，而是各遞迴指令規則內以 `isDangerousRoot` 判定、再由 `classify` 對 `deny` 短路；故不在本三條之列。）

1. **cwd 範圍**：`cwd.kind === "known"` 但落在專案根外 → ask。
2. **寫入型重導向**：`> >> >| &> &>> <>`（及 `>&` 接檔名）→ ask；null 裝置（`/dev/null`、`NUL`）
   與純 fd 複製（`2>&1`、`>&` 接 fd 數字）不算寫入。
3. **環境變數賦值前綴**：任何 `var=val` 前綴（`LD_PRELOAD=…` 等）→ ask。

## 核心不變量（改動時不可違反）

- **default-deny**：未明確判定為安全唯讀的一律 ask。新增指令規則時，未涵蓋的形式必須 fallback 到 ask。
- **deny 僅限「遞迴遍歷恰好等於磁碟根/家目錄根的唯讀指令」**（find/tree/ls -R/grep -r/rg）；其餘維持「永不 `deny`」。verdict 三態優先序 `deny > ask > allow`。**永遠 `exit 0`**；任何例外都 try/catch 成 ask（fail-safe）。
- **deny 為硬性**：`classify` 對 builtin `deny` 短路，**不經** `permissions.allow` 升級層（升級層只把 `ask` 變 `allow`，永遠碰不到 `deny`）。deny 漏判（遞迴/根偵測未覆蓋、home env 缺失）只退回 `ask`，絕不誤放行。
- **新增/修改規則 = 改 `rules/commands/*.ts` → 在 `allowlist.ts` 註冊 → `deno task build`**。
  hook 每次 Bash 呼叫都重新執行那顆 `.exe`，故 rebuild 後**下一個指令即生效，不需重啟**（重啟只在改
  `~/.claude/settings.json` 時才需要）。

## 新增 / 修改指令規則

**步驟**

1. 在 `src/rules/commands/<cmd>.ts` 實作一個 `CommandRule`（`names: string[]` + `evaluate(ctx): RuleVerdict`），
   回 `allow()` 或 `ask(reason)`（皆來自 `../types.ts`）。
2. 在 `src/rules/allowlist.ts` 匯入並加進 `RULES` 陣列（name 不可與既有規則重複，載入時會丟錯）。
3. 寫 `<cmd>_test.ts`（複製既有 `ctxOf` helper；**allow 與 ask 兩面 + 邊界**都要測）。
4. `deno task check && deno task lint && deno task test` 全綠。
5. `deno task build` 後做 operational verification：餵 JSON 給 binary，確認**危險形式真的 ask、安全形式才 allow**。

**`RuleContext` 可用**：`name`、`argv`(`Word[]`)、`redirects`、`assignments`、`cwd`、
`resolvePath(word)` / `resolvePathValue(string)`（三態範圍檢查）。靜態取值用 `staticValue(word)`
（動態回 `null` → 當作不可判定 → ask）。**不要重複處理**中央前置規則已涵蓋的事（cwd 範圍、寫入重導向、
賦值前綴）——進 rule 前已判完。

### 一律 allowlist 優先於 denylist（寧可 ask，也不要誤放危險指令）

- **規則一律「列舉安全的唯讀形式 → allow，其餘全部 ask」；禁止「列舉危險形式 → ask，其餘 allow」。**
  理由：指令會新增子指令 / 旗標，denylist 會把**未來新增的危險形式自動放行（誤放）**；allowlist 最多
  只是對未知新形式多問一次（安全方向）。這是本工具的根本取捨——**誤 ask 可接受，誤 allow 不可接受**。
- **子指令型**（git / gh）：維護「唯讀子指令集合」，集合內才 allow、其餘 ask（見 `git.ts` / `gh.ts`）。
  全域選項同理：未知全域選項一律 ask（見 `git.ts` 的全域選項 allowlist）。
- **旗標型**：用 `factory.ts` 的 `flagGatedReader`——`askFlags` 命中即 ask、`valueFlags` 正確跳過吃值
  旗標、`pathValueFlags` 對旗標的路徑值做範圍檢查；位置參數一律 `resolvePath`。
- **程式內嵌型**（sed / awk）：掃描程式碼，**只在能靜態確認純唯讀時 allow**，任何無法確認的構造 → ask。
- 動態 token（變數 / `$()` / 可逸出 glob）一律當不可判定 → ask，不要臆測其展開結果。

## ⚠️ 不要再犯的問題

### 跨平台 / Windows 特例

- **MSYS `/d/` vs Windows `D:/`**：Git-Bash 用 `/d/proj`，而 `$CLAUDE_PROJECT_DIR` 是 `D:\proj`/`D:/proj`。
  `scope.ts` 的 `normalizeAbsolute` 會把單字母頂層段（`/d`、`/c`）正規化成磁碟形式——**但這個轉換用
  `Deno.build.os === "windows"` 鎖定只在 Windows 套用**。Linux 上 `/a/c/d` 是真實 POSIX 路徑、且
  **區分大小寫**（`/a` ≠ `/A`），絕不可改寫。新增任何路徑正規化時，務必同時考慮這三種寫法
  （`/d/`、`D:/`、`D:\`）在 Windows 等價、在 Linux 不可混淆。
- **settings.json hook command 路徑用正斜線**：無 `args` 的 `type: "command"` hook 在 Windows 經
  Git-Bash 執行，bash 會吃掉反斜線 → `D:\...\x.exe` 變 command-not-found（exit 127）、hook 靜默失效。
  一律寫 `D:/path/.../permission-checker.exe`。
- 寫測試時，平台相關的斷言用 `Deno.test({ ignore: Deno.build.os !== "windows", ... })`（或反向）區分，
  不要寫死只在單一平台成立的字串。

### 第三方套件：unbash（禁止憑印象，已驗證的事實）

- 節點用 `type: "字串"` 標記。`Script.commands: Statement[]`、`Statement.command: Node`、
  `Command.{name,prefix,suffix,redirects}`、`CommandExpansion.script: Script`、
  `Redirect.{operator,target}`。型別一律從 `src/deps.ts` 單一入口匯入。
- **unbash 不結構化表示 glob**：`*.txt`（未加引號）的 Word 無 `parts`、`value` 就是 `"*.txt"`，
  與字面值 `a.txt` 結構相同。故 glob 必須在 `word.ts` 用 `GLOB_CHARS` **詞法偵測**，不能靠 WordPart。
- **`>&` 同時是 fd 複製與寫檔**：`2>&1`/`>&2`（target 為數字）是複製、`>&out.txt`（target 為檔名）
  是寫檔——靠 target 是否為純數字 / `-` 區分（見 `redirect.ts`），不是靠有無 target。

### 安全誤放（auto-allow 不該 allow）——這些是 review 實際抓到的

- **git / gh 全域選項是攻擊面**：別用 denylist 逐一擋。`git.ts` 已改為**安全 allowlist**——子指令前
  未知的全域選項一律 ask；危險者（`-c <非安全config 如 diff.external/core.pager/*.textconv>`、
  `--exec-path`、`--config-env`、讀取子指令的 `--output=`、`git grep -O`、`--ext-diff`）明確 ask。
  新增 git/gh 形式時沿用 allowlist 思維。
- **吃路徑值的 flag 要 scope-check 其值**：`grep -f <patternfile>`、`diff --from-file=<file>` 的
  值是會被讀取的路徑，必須 `resolvePath`（見 `factory.ts` 的 `pathValueFlags`），不能只當 flag 跳過。
- **gh api 寫入偵測要含黏寫形式**：`-X POST`、`--method=DELETE`、`-f`/`-F`/`--field`/`--input`，以及
  黏寫 `-fname=x`/`-FKEY=@file`/`-XPATCH` 都代表寫入請求 → ask。
- **sed/awk 程式碼會寫檔/執行**：即使無 `-i`，腳本內 `w`/`e`/`s///w`（sed）、`print >`/`system()`/
  `getline`/pipe（awk）都是副作用。用程式掃描白名單，無法靜態確認即 ask。awk 的 `>` 偵測要錨定在
  `print`/`printf` 之後（否則誤殺 `$3>100` 比較）；pipe 偵測要排除 `||`。

### hook 決策 vs settings.json 權限的優先序（重要）

`PreToolUse` hook 回 `ask` 會**蓋過** `permissions.allow`（most-restrictive-wins：deny > ask > allow）。
為解決此痛點，本檢查器在 runtime 讀取使用者的 `permissions.allow`：當 builtin 判 `ask`、但該指令命中
`permissions.allow`（且未被 `permissions.deny`/`ask` 命中）時，檢查器**自己回 `allow`**——等效把矩陣中
`(hook=ask, settings=allow)` 那格從詢問改為放行（見 `permissions/` 與 `classify.ts` 的升級層）。

因此要讓某指令自動放行有兩條路：
- **(a) 加 allowlist 規則 + rebuild**：適合通用唯讀指令（改 `rules/commands/*.ts` → `allowlist.ts` → build）。
- **(b) 在 settings.json 的 `permissions.allow` 加該指令**：適合專案/個人特定指令，免改碼。**現在會生效**
  （這推翻了本工具早期「光加 `permissions.allow` 不會生效」的行為）。

仍須注意：
- hook 的 `allow` **不會**突破 Claude Code 既有的 `permissions.deny`/`ask`（官方語意：hook allow 只略過
  互動提示、不覆寫 deny/ask 規則）。本檢查器讀 deny/ask 並在升級前自我否決，是為了輸出一致；安全則由
  Claude Code 端再次保證。
- 升級僅在**能靜態還原指令字串**（name 非動態、無賦值前綴、argv 全靜態）時發生；動態 token、`Bash(*)`
  等會匹配一切的空 prefix、以及無法可靠解析的 pattern 一律不升級（維持 default-deny）。
- 讀取來源：專案 `.claude/settings.json`、`.claude/settings.local.json`、使用者 `~/.claude/settings.json`
  （**不含** enterprise managed-settings）。讀檔失敗一律 fail-safe 退化為「無此來源規則」。

此外，本檢查器也沿用 `permissions.{allow,deny,ask}` 中的 `Read()/Edit()/Write()` 規則放寬「讀取位置」：
凡純唯讀指令（allowlist 內）其路徑落在使用者以這些規則 allow 宣告、且未被 deny/ask 否決的外部目錄／
單檔時，視為 in-project 而放行。只認 `//`（絕對）與 `~/`（家目錄）前綴、`/**` 目錄與無 glob 單檔；
其餘形式（中段 glob、裸檔名、專案/ cwd 相對前綴）一律忽略、維持 ask。判定為 root-first：專案內路徑
永遠 in-project，外部路徑才依 deny → ask → allow 決定（deny/ask 皆否決放寬）。**只放寬讀取位置，
不放寬任何寫入型重導向／賦值前綴／非唯讀指令偵測**。

本檢查器同樣沿用 `permissions.{allow,deny,ask}` 中的 `WebFetch(domain:...)` 規則 + 內建
preapproved 文件網域清單（快照自 Claude Code 2.1.173，見 `permissions/domain_scope.ts`），
放行唯讀形式的 `curl`：旗標全落在安全 allowlist、每個 URL 靜態且帶明確 http(s) scheme、
host 命中 allow 網域或 preapproved（顯式 deny/ask 規則否決之）才 allow。比對語意對齊官方：
無萬用字元 = 精確 host（不含子網域）、`*.x` 僅子網域（不含裸域）、`domain:*` 一切；只比
hostname（忽略 port/path，preapproved 的 5 條 path 前綴條目除外）。寫檔旗標（`-o` 等）、
非 GET、憑證旗標、無 scheme、userinfo、curl 展開字元 `{}[]`、動態 token 一律 ask；
`-H @file` 走既有讀取範圍判定。

⚠️ sandbox 限制：若啟用 `sandbox.filesystem`，專案外路徑會在 OS 層被擋，與本 hook 的 allow 無關；
此時還需把該目錄加入 sandbox 的 `allowRead` 才能真正讀取。

此外，本檢查器現會對「遞迴遍歷磁碟根/家目錄根的唯讀指令」主動回 `deny`（硬性、不可由 `permissions.allow` 解除）。此 deny 之 `permissionDecisionReason` 會回饋給 agent，故理由文字會解釋禁止原因與可行替代。

此外，本檢查器把「**當前 session** 的 Claude Code 工具/任務輸出子目錄」視為唯讀延伸範圍（見 `claude_dir.ts` 的
`sessionTrustedReadRoots`）：`~/.claude/projects/<E>/<session_id>/`（內含 `tool-results/`）與
`/tmp/claude-<uid>/<E>/<session_id>/`（背景任務輸出；macOS 另含 `/private/tmp` symlink 形式）。其中 `E` 取自
hook 傳入 `transcript_path` 之 dirname 的 basename（**權威編碼段、不重算/不猜 Claude 的編碼規則**），`<uid>` 由
`Deno.uid()` 取得（需 `--allow-sys=uid`；取不到 → fail-safe 不產生 `/tmp` 根）。

- **以全域唯一 `session_id` 為信任鍵 → 碰撞免疫**：所有 trusted 根皆以 `.../<session_id>/` 結尾，即使兩專案路徑
  編碼後共用同一 `<E>` 目錄，session 子樹仍唯一屬當前 session。設計**不含任何有損 `encode(root)`**。
- **兩道 fail-closed 安全閘**：(a) `basename(transcript_path)` 必須等於 `<session_id>.jsonl`（綁定當前 session）；
  (b) dirname 必須嚴格位於 `<home>/.claude/projects/` 之下且至少一非空段。另在串接前要求 `session_id` 符合
  `^[A-Za-z0-9_-]+$`（封 `.`/`..`/分隔符的 path-escape）。任一不過 / 缺欄位 → 不放寬（退回 `ask`）。
- **刻意不自動放行**：`memory/`、歷史 session 子目錄、transcript `.jsonl` 檔本身（無法以唯一 session_id 涵蓋；
  納入會重新引入跨專案風險）→ 維持 `ask`、非封鎖。
- 放行來源（`evaluate`/`classify` 的獨立參數 `trustedReadRoots` → `ScopeConfig.trusted`）與**使用者 permission
  規則型別分離**，`rules` 全程不被 mutate；trusted 與 user-allow 同屬 allow 層，**`deny`/`ask` 仍覆蓋**
  （`deny > ask > allow`）。**只放寬讀取位置**，不放寬任何寫入型重導向／賦值前綴／非唯讀指令偵測。
- 殘留信任假設：信任 Claude 送來的 `transcript_path`/`session_id`/`Deno.uid()` 屬於當前 session/使用者
  （與既有信任 `cwd`/`tool_input` 同一層級）。
