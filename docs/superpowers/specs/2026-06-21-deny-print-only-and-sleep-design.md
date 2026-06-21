# 設計規格：對「整鏈 print-only 偽裝驗證」與「sleep 輪詢等待」回 `deny`

- 日期：2026-06-21
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部
落在當前專案內」時回 `allow`，其餘回 `ask`。目前 `deny` 僅用於**單一類別**——「遞迴遍歷磁碟根/
家目錄根的唯讀指令」（見 2026-06-14 規格），且 deny 為**硬性**：`classify` 在 builtin 回 `deny`
時短路返回，**不經** `permissions.allow` 升級層。

### 1.1 痛點

兩種 agent 行為違反使用者全域規則（CLAUDE.md），但目前不會被 hook 主動阻擋：

1. **print-only 偽裝驗證**：agent 用 `echo "結論是 X 因為 Y"`、`printf "分析：...\n"`、
   `cat <<EOF ... EOF` 等指令，把**事先寫死的結論**用機器口吻吐到 stdout，偽裝成「電腦跑出來的
   驗證結果」。這類指令沒有任何讀檔 / 計算 / 真實驗證，內容完全由 agent 預先決定——等同把腦中的
   推論換個格式轉述。目前 `echo` 一律 `allow`、`printf` 為 `ask`、`cat <<EOF` 為 `allow`。
2. **sleep 輪詢等待**：agent 用 `sleep N`（常配合 `echo waiting` 或迴圈）主動輪詢 / 等待背景工作。
   CLAUDE.md 明文禁止 Bash 輪詢（背景工作完成時 harness 會自動以 `task-notification` 喚醒）。
   目前 `sleep` 不在 allowlist → `ask`，仍可被人為批准或被 `permissions.allow` 升級為 `allow`。

使用者要求：**這兩類行為直接 `deny`（硬性、不可由 `permissions.allow` 解除），並把禁止原因回饋
給 agent**，讓 agent 理解為何被擋、改用正確做法（直接在回覆中陳述結論 / 實際讀檔跑測試 /
用 `ScheduleWakeup` 排程喚醒）。

### 1.2 核心設計約束（經使用者逐項確認）

1. **封鎖強度＝硬 deny、不可解除**：與既有遞迴根 deny 同級，優先序 `deny > ask > allow`，
   `permissions.allow` 無法解除。
2. **print-only 觸發條件＝整鏈皆 print 形態**：只有當「**這一次 hook 呼叫的整條指令鏈，每一個葉
   指令都是 print 形態**」時才 deny。只要鏈中混有任何一個真實指令（`make`、`cat file`、`grep`…），
   就**不**阻擋。此設計刻意排除「排版 / 狀態標記 echo」的誤判（如 `make && echo DONE`）。
3. **print-only 涵蓋形式**：`echo` 靜態字串、`printf` 靜態字串、`cat`/`tac` 讀 heredoc/here-string。
   **不含** heredoc 寫檔（`cmd > file << EOF`，仍維持既有 `ask`）。
4. **行為檢查 carve-out**：CLAUDE.md 判準一明許「驗證工具/直譯器本身行為」的合法用途
   （`printf "%05d\n" 42`、`echo -e "a\tb"`）。這類**不算 print 形態**，自然落回既有 classify。
5. **sleep＝evaluate 層聚合掃描、無條件硬 deny**：sleep 不輸出任何東西，不塞進 print 形態謂詞；
   也**不**做成 per-command rule（會被中央前置 ask 規則搶先、可被 `permissions.allow` 升級——
   見 §3.1）。改為在 `evaluate` 層、classify 之前掃描 `inv.name === "sleep"`：**只要鏈中任一葉指令
   是 sleep 就硬 deny**，不論引數 / 賦值前綴 / 重導向 / 前後文（`sleep 5 && make`、`FOO=1 sleep 5`、
   `sleep 5 > out` 皆擋），且不可由 `permissions.allow` 解除。

### 1.3 已查證的事實（unbash 4.0.1 解析行為，實機 `parse()` 驗證，信心度：高）

1. **Heredoc（`<<` / `<<-`）**：解析為 `Redirect`，`operator: "<<"`、`target` 為**分隔符 Word**
   （如 `{value:"EOF"}`，**非** body）、body 原始文字置於 **`content`（string）**。**`body` 欄位**：
   - 未加引號分隔符且 body **含展開**（`$(...)` / 反引號 / `$var`）時，**`body` 為結構化 Word**，
     其 `parts` 含對應 WordPart——尤其 **`$(...)` → `CommandExpansion`，其 `.script` 是完整解析好的
     內層指令 AST**（實測 `cat <<EOF\n$(rm -rf x)\nEOF` → `body.parts[0].type === "CommandExpansion"`、
     `…script.commands[0].command.name.value === "rm"`）。
   - body **無展開**（純文字）時，`body` 為 `undefined`、文字僅在 `content`。
   - 引號分隔符（`<<'EOF'`）時 `heredocQuoted === true`、`body` 為 `undefined`（`$(...)` 是字面、
     **不執行**）。
   - **關鍵推論**：unbash **有**把未引號 heredoc body 的命令替換結構化（`body` Word）；要列舉 body 內
     的內層指令，取 `redirect.body` 走訪其 `CommandExpansion.script` 即可，**不需**詞法掃 `content`
     字串。靜態性判斷（print-only 用）：`heredocQuoted === true` 或 `content` 不含 `$`/反引號 → 靜態。
2. **Here-string（`<<<`）**：解析為 `Redirect`，`operator: "<<<"`、`target` 為**實際字串 Word**
   （`<<<"literal"` → target.value `"literal"`、含 DoubleQuoted part；`<<<"$(rm)"` → target 含
   `CommandExpansion`）、`content` 為同字串。here-string 的內層替換在 **`target`**（walk 既有就會
   列舉 `redirect.target` → 此類**早已**逐一分類）；靜態性用 `isStatic(target)`。
3. **printf**：format 字串為 `suffix[0]`；`printf '%05d\n' 42` → suffix[0] 為 SingleQuoted Word
   （`isStatic` 為真、`value` 保留字面 `"%05d\\n"`），suffix[1] 為 `42`。
4. **`<<` / `<<-` / `<<<` 皆非 write redirect**：`redirect.ts` 的 `WRITE_OPERATORS` 僅含
   `>`,`>>`,`>|`,`&>`,`&>>`,`<>`；heredoc/here-string 輸入重導向不在內。`cat > f << EOF` 的 `>`
   才會被 `hasWriteRedirect` 判為寫檔。
5. **既有 `word.ts` 已把展開/glob 歸為動態**：`BraceExpansion`/`ExtendedGlob`/`ArithmeticExpansion`/
   `SimpleExpansion`/`ParameterExpansion`/`CommandExpansion`/`ProcessSubstitution` 與未加引號 glob
   字元 → `isStatic` 為假。故 `echo {1..5}`、`echo *.txt`、`echo $((1+2))`、`echo "$VAR"`、
   `printf "%s" "$VAR"`（含變數/brace/glob/算術/process-subst）**非全靜態 → 不算 print 形態**。
   - **但「唯一動態成分是命令替換 `$( … )`」是例外**：print 形態判定**不是**直接用 `isStatic`，而是
     §4.1.4 的 `wordPrintEligible`——它在 `isStatic` 之外，額外**接受**「動態僅來自 `$()`」的字
     （如 `echo "$(echo fake)"`）為 print 合格，以便配合聚合 every() 堵替換包裝偽裝（見 §4.1.4 / §2.1）。
     即：變數/glob/算術/process-subst 仍排除；**只有命令替換**被 `wordPrintEligible` 豁免。

### 1.4 已查證的 Claude Code 語意（沿用 2026-06-14 §1.3，信心度：高）

`PreToolUse` hook 的 `permissionDecision: "deny"` 會**阻止該工具呼叫**並把
`permissionDecisionReason` **回饋給模型（agent 可見）**，優先序 `deny > ask > allow`。故 deny 理由
**必須**包含三要素：① 被禁止的事、② 為何禁止、③ 可行的替代做法。

### 1.5 威脅模型與強制邊界（明確界定 deny 的完整性，避免「漏堵即漏放行」誤解）

本功能是疊加在**預設安全（default-safe）顧問式 hook** 上的**額外 deny 層**：它把使用者列舉的常見
直接偽裝形式硬 deny，但**不追求攔截所有可能的繞道**——任何「未被新 deny 命中」的形式都退回既有
classify 的 allow/ask 判定。完整性界定如下：

1. **walk() 已攤平、其葉指令參與聚合閘的執行構造**：subshell `( … )`、brace group `{ …; }`、
   pipeline `a | b`、`&&` / `||` 序列、`;` 序列。其葉指令為頂層 invocation、直接參與 `isAllPrintOnly`，
   故 `(echo fake)`、`{ echo a; echo b; }`、`echo a && echo b` 皆會被聚合 deny。
   - **command substitution `$( … )`**：內層成獨立葉指令（參與聚合 every()），且外層字若「動態僅來自
     `$()`」由 `wordPrintEligible` 視為 print 合格 → `echo "$(echo fake)"`、`cat <<EOF $(echo fake) EOF`
     被聚合 deny。
   - **process substitution `<( … )` / `>( … )`**：內層**會**被 walk 列舉並 classify（既有行為），但帶
     `<(…)` 引數的外層指令**非** print 合格（`wordPrintEligible` 不豁免 ProcessSubstitution）→ **不**經
     print-only deny，而是落正常 classify。`<(…)` 產生 `/dev/fd` 路徑、語意上非「靜態吐字」，刻意排除。
2. **walk() 不深入、因而不在 print-only 閘範圍的構造**（其葉指令交既有 classify）：
   - **巢狀直譯器字串**：`bash -c '…'`、`sh -c '…'`、`eval '…'`、`source`/`.`、`python -c`、
     `perl -e`、`node -e` 等——其字串引數**不被 walk 解析**。葉指令名（`bash`/`eval`/`python`…）
     **皆不在 allowlist → 預設 `ask`**。屬**刻意接受、已記錄**的繞道，非本功能保證範圍。
     > ⚠️ **準確說明**：此 `ask` 走既有 classify，**可被** `settingsAllows` 升級——若使用者自設廣域
     > `Bash(bash *)` / `Bash(python *)` / `Bash(eval *)` 等，`bash -c 'sleep 5'`、`python -c '…'` 等
     > **會升級為 allow**。本功能**不新增**此路徑（它是既有 permissions.allow 行為），但也**不**硬擋；
     > 屬使用者自負的 settings 風險。未設這些廣域 allow 時維持 ask。
   - **exec wrapper（使用者確認接受，2026-06-21）**：`command sleep 5`、`env sleep 5`、`nice sleep 5`、
     `nohup sleep 5`、`timeout 5 sleep 10`、`command echo fake` 等——unbash 解析後**葉指令名是
     `command`/`env`/`nice`/`nohup`/`timeout`**（真正要跑的 `sleep`/`echo` 在 argv），故**不**觸發
     sleep 閘① / print-only 閘②。這些 wrapper 名**皆不在 allowlist → 預設 `ask`**。使用者**明確選擇**
     不為其加 wrapper 解析（避免無界複雜度與誤判，如 `timeout 5 grep sleep f` 是合法 grep）。
     > ⚠️ 同上：此 `ask` 可被 `settingsAllows` 升級——使用者若自設 `Bash(timeout *)` / `Bash(env *)` /
     > `Bash(command *)` 等，對應 wrapper 形式**會升級為 allow**（直接 `timeout`/`env` 等不在本工具
     > allowlist，需使用者主動放行）。屬使用者自負的 settings 風險；本功能不新增、亦不硬擋。
   - **heredoc body 內的命令替換（已正確封堵，非殘留風險）**：§4.6 讓 walk 列舉 `redirect.body`，使
     heredoc body 內的 `$( … )` **像其他位置的替換一樣被解析成獨立 invocation、逐一權限檢查**。故
     `cat <<EOF\n$(rm -rf x)\nEOF` 的 `rm` 走正常分類 → `ask`；且 `Bash(cat *)` 以還原字串
     `"rm -rf x"` 比對**不命中 rm**，無法升級——只有使用者明設 `Bash(rm *)`（自己放行 rm）才會 allow。
     此非繞道，而是**與一般 `$()` 一致的正確行為**。
3. **零葉指令（no-op）**：parse 後無可執行指令 → 既有 allow（no-op）。零指令即「什麼都不執行」、
   無從偽裝，維持 allow 安全。
4. **sleep 強制邊界＝凡 `walk()` 觸及的字面 `sleep` 葉指令**（使用者明確決定）：只要靜態指令名為
   `sleep` 且被 walk 列舉到（**含控制流內**：`while …; do sleep …; done`、`for`、`if`、`&&`、`;`、
   subshell、brace group、命令替換 `$(sleep …)`），閘① 一律 **deny**——`while … sleep …` 計時迴圈
   **屬此範圍、會被 deny**（walk 會走訪迴圈本體、其內字面 sleep 被列舉）。
   - **不在範圍的是「非字面 sleep 的等價等待原語」**：`bash -c 'sleep'`、`sh -c 'sleep'`、
     `python -c 'time.sleep'`、`perl -e 'sleep'`、`read -t`（葉指令名是 `bash`/`python`/`read`…而非
     `sleep`，字串內的 sleep 不被 walk 解析）→ 皆非 allowlist → **預設 `ask`**。屬**刻意接受、已記錄**
     的邊界，本功能不追求攔截所有等待原語。
   - **例外（本次一併修）`tail -f`/`-F`/`--follow`**：原為 allow（fileReaderRule 無 gate），現由
     §4.8 `tailRule` 收緊為 **ask**（無界跟隨需人工確認）。
   > ⚠️ 上述 `ask`（含 tail -f）皆走既有 classify，**可被** `settingsAllows` 升級——使用者若自設
   > `Bash(bash *)` / `Bash(python *)` / `Bash(read *)` / `Bash(tail *)` 等廣域 allow，對應形式**會
   > 升級為 allow**（字面 `sleep` 因 evaluate 層硬 deny 不受影響）。本功能不新增此升級路徑、亦不硬擋
   > 等價形式；屬使用者自負的 settings 風險。
5. **「整鏈 print」閘的洗白繞道（使用者確認維持原設計，2026-06-21）**：聚合閘要求**每個**葉指令
   皆 print 形態才 deny，故只要鏈中夾一個非 print 指令即不擋。可被以下方式繞過：
   - **瑣碎 no-op 前綴**：`pwd; echo "假報告"`、`true && echo "已驗證"`、`: ; printf "通過"`
     （pwd/true/: 非 print 形態 → 非全鏈 print → 不 deny，落該真實指令的 ask/allow）。
   - **真實讀取洗白**：`cat README.md; printf "已驗證..."`（cat 讀真檔 → 非全鏈 print → 不 deny）。
   > **使用者確認的取捨**：使用者**明確選擇維持「整鏈 print 才擋」的乾淨結構規則**，以避免誤殺
   > 合法狀態標記（如 `make && echo DONE`、`deno task test && echo PASS`）。代價是上述洗白繞道
   > **不被 deny**——屬**已知、刻意接受**的限制。理由：偵測「真實指令是否只為洗白假報告」屬意圖
   > 判定、無法由結構可靠區分；偏向零誤殺優於追求完整封堵（符合「誤 ask 可接受、誤 allow 不可
   > 接受」，且這些繞道最差落該真實指令既有判定，多為 ask）。

**一句話總結**：本功能把使用者列舉的**常見直接形式**（裸 echo/printf/cat-heredoc 鏈、裸 sleep）
硬 deny（不可由 permissions.allow 解除）；heredoc body 內的命令替換以「逐一分類」正確檢查（point 2，
非繞道）。對巢狀直譯器 / exec wrapper（`timeout`/`env`/`command`/`nice`/`nohup`）/ 等價等待原語 /
「整鏈 print」洗白繞道**不保證 deny**：預設落 ask 或該真實指令既有判定，**本功能不新增任何 allow
路徑**；但它們仍受**既有** `permissions.allow` 升級層影響——使用者若自設廣域 `Bash(bash *)` /
`Bash(timeout *)` / `Bash(python *)` 等，對應繞道可能 allow（使用者自負的 settings 風險）。以上皆為
使用者確認、刻意接受的取捨，優先保留設計簡潔與零誤殺。

## 2. 目標與非目標

### 2.1 目標

- 把 deny 從「僅遞迴根掃描」擴張為**三類**：(1) 遞迴根掃描（既有，不動）、(2) 整鏈 print-only
  偽裝（新增）、(3) sleep 輪詢（新增）。
- 新增 `src/engine/print_only.ts`：提供單指令謂詞 `isPrintOnlyForm(inv)` 與聚合判斷
  `isAllPrintOnly(invocations)`，集中所有 print 形態判定與 carve-out。echo/printf 的靜態性判定採
  **command-substitution-aware 的 `wordPrintEligible`**：靜態、或唯一動態成分為 `$( … )` 的字皆
  視為合格——配合「聚合 every() 涵蓋所有葉指令（含替換內層）」，可堵住 `echo "$(echo fake)"` 這類
  以命令替換包裝靜態文字的偽裝（見 §4.1.4）。
- 改 `src/engine/walk.ts`：`emitCommand` 列舉內層 command substitution 的來源加入 `redirect.body`，
  使 heredoc body 內的 `$( … )` 被解析成獨立 `CommandInvocation`、**逐一接受正常權限檢查**（與其他
  位置的 `$()` 一致）。藉此 `cat <<EOF\n$(rm -rf x)\nEOF` 的 `rm` → ask，且 `Bash(cat *)` 無法升級
  rm；**正確封堵 heredoc 命令替換盲點、不靠硬 deny**（見 §4.6）。
- **（一併修的兩個相鄰既有漏洞，經使用者確認納入）**：
  - 新增 **classify 第 4 條中央前置規則**：輸入重導向 `<` 目標 `resolvePath` 超出讀取範圍 → `ask`
    （堵 `cat < /etc/passwd` 等未範圍檢查的外部讀取，見 §4.7）。
  - 新增 **`tailRule`**：`tail -f`/`-F`/`--follow` → `ask`（原 allow；堵無界跟隨/輪詢，見 §4.8），並把
    `tail` 從 `fileReaderRule` 移出。
- 在 `src/engine/evaluate.ts` walk 之後、classify 之前插入**兩個 evaluate 層硬 deny 閘**：
  (①) `some(inv.name === "sleep")` → `deny`；(②) `isAllPrintOnly` 整鏈 print → `deny`。皆在 classify
  前返回 → 天生硬性、不過任何中央前置規則與 `settingsAllows`。
- **sleep 不做成 `CommandRule`**（避免被中央前置 ask 規則搶先 + 被 `permissions.allow` 升級，見
  §3.1）；故無 `src/rules/commands/sleep.ts`、無 `allowlist.ts` 變更。
- 新增兩個 deny 理由 helper（與 `recursiveRootDenyReason` 並列於 `src/rules/types.ts`）：
  `printOnlyDenyReason()`、`pollingDenyReason()`。
- 全程 fail-safe：`isPrintOnlyForm` 任何不確定一律回 `false`（→ 不貢獻全鏈 print → 不誤 deny）；
  `evaluate` 既有 try/catch 仍把例外收斂成 `ask`；永遠 `exit 0`。

### 2.2 非目標（YAGNI，刻意排除）

- **不**偵測 heredoc 寫檔（`cmd > file << EOF`）為新 deny：維持既有 `ask`（寫入型重導向中央前置
  規則）。兩步偽裝 `cat > /tmp/x << EOF ... && cat /tmp/x` 因「寫檔半段 ask + 讀回專案外 ask」
  整體已是 `ask`，本功能不升級為 deny。
- **不**為「整鏈 print 但其中夾雜一個合法行為檢查」的鏈 deny（如 `printf "%05d" 42 && echo X`：
  printf 屬 carve-out → 非全鏈 print → 不 deny）。一個合法行為檢查即保護整鏈，安全方向、可接受。
- **不**改 `CommandInvocation` 結構（不新增 pipe-context 欄位）：聚合「整鏈 print」天然涵蓋 pipe
  情境（`echo x | grep y` 中 grep 非 print 形態 → 非全鏈 print → 不 deny）。`walk.ts` 僅新增「列舉
  `redirect.body` 內層替換」一處（§4.6），不動其餘職責。
- **不**處理 print-laundering（`echo x | cat`：cat 無 heredoc → 非 print 形態 → 不 deny）。罕見、
  可接受的弱點。
- **不**偵測迴圈語意的 sleep（`while … sleep …`）為特例：sleep 一律無條件 deny，迴圈與否不影響。
- **不**動既有的寫入重導向 / 賦值前綴 / 非唯讀指令偵測；**只收緊（新增 deny，或把既有 allow 收為
  ask：tail -f、輸入重導向外部讀取），不放寬任何既有判定**。
- **不**引入快取、**不**讀 enterprise managed-settings。

## 3. 架構與資料流

新增邏輯掛在數處：`evaluate` 的**兩個聚合硬 deny 閘**（sleep 名稱掃描 + 整鏈 print-only，皆在
classify 之前返回）、`walk` 的 **heredoc `body` 內層替換列舉**（使 body 內的 `$()` 逐一受檢）、
classify 的**第 4 條中央前置規則「輸入重導向 `<` 目標範圍檢查」**（§4.7），以及新增 `tailRule`
（`-f`/`-F`/`--follow` → ask，§4.8）。parse 職責不變。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → walk → invocations[]   （walk 新增：列舉 redirect.body 內的 $() → 內層指令成獨立 invocation）
       ├─ invocations.length === 0 → allow（既有 no-op，不變）
       │  （先算 fnNames = definedFunctionNames(script)、anyShadowed）
       ├─ 閘①(deny)：some(name === "sleep") → deny(pollingDenyReason())   （字面 sleep 一律 deny；classify 前短路）
       ├─ 閘②(deny)：isAllPrintOnly(invocations) → deny(printOnlyDenyReason()) （整鏈 print-form 名一律 deny；短路）
       ├─ 閘③(ask) ：anyShadowed → ask(functionShadowReason())            （承接非 print-form 遮蔽名；§4.9；短路）
       └─ combine(invocations.map(classify))                          （既有；含 heredoc body 內層指令）
             └─ classify → classifyBuiltin
                   └─ 中央前置規則 #4：輸入重導向 `<` 目標超出讀取範圍 → ask  （新增；見 §4.7）
```

### 3.1 為何 print-only 與 sleep 皆放 `evaluate` 聚合層（classify 之前）

- **print-only 是跨指令聚合決策**（「整鏈每個指令都 print 才擋」），單一 `CommandRule` 看不到兄弟
  指令，故放 `evaluate`（方案 A，經使用者確認）。
- **sleep 必須在 classify 之前硬 deny**：使用者要求「只要出現 sleep 就無條件硬 deny、不可解除」。
  若做成 per-command rule，會排在中央前置規則（賦值 / 寫入重導向 / cwd / 動態 heredoc → ask）**之後**，
  導致 `FOO=1 sleep 5`、`sleep 5 > out` 等被中央規則搶先判 `ask` 並可被 `permissions.allow` 升級，
  破壞硬 deny 保證。故 sleep 改為 evaluate 層 `inv.name === "sleep"` 掃描，與 print-only 同樣在
  classify 之前短路返回（不經中央規則、不經 settingsAllows）。

### 3.2 兩類 deny 不衝突且順序無關

- 兩閘皆產出 `deny`，先後順序不影響最終結果（`deny > ask > allow`）。sleep 閘列於 print-only 閘之前
  僅為可讀性；`sleep 5 && make`（非全鏈 print，但含 sleep）由 sleep 閘 deny，正是 per-command 設計
  搆不到的案例。

## 4. 詳細設計

### 4.1 `src/engine/print_only.ts`（新檔）

```ts
import type { CommandInvocation } from "../types.ts";
import { hasWriteRedirect } from "./redirect.ts";
import { isStatic, staticValue } from "./word.ts";

/** 整鏈聚合：至少一個指令、且每個葉指令皆 print 形態 → 視為 print-only 偽裝。 */
export function isAllPrintOnly(invocations: CommandInvocation[]): boolean {
  return invocations.length > 0 && invocations.every(isPrintOnlyForm);
}

/** 單一葉指令是否為「靜態吐字」形態（echo / printf / cat·tac heredoc）。 */
export function isPrintOnlyForm(inv: CommandInvocation): boolean {
  // 共同前置：任一成立 → 不算 print 形態（保守不擋）
  if (inv.name === null) return false;                 // 動態指令名 → 本就 ask
  if (hasWriteRedirect(inv.redirects)) return false;   // 有寫檔副作用 → 非純輸出
  if (inv.assignments.length > 0) return false;        // var=val 前綴 → 可能改變執行

  switch (inv.name) {
    case "echo":   return isEchoPrintOnly(inv);
    case "printf": return isPrintfPrintOnly(inv);
    case "cat":
    case "tac":    return isCatPassthrough(inv);
    default:       return false;
  }
}
```

#### 4.1.1 `echo`

```ts
function isEchoPrintOnly(inv: CommandInvocation): boolean {
  let hasEscapeFlag = false;       // 出現 -e / -E（跳脫詮釋旗標）
  let hasBackslashPayload = false; // 某 payload 含反斜線跳脫序列（-e 會實際詮釋者）
  for (const w of inv.argv) {
    if (!wordPrintEligible(w)) return false;           // 含變數/glob/算術等非替換動態 → 排除
    const v = staticValue(w);                           // 替換型 word 的 staticValue 為 null
    if (v === null) continue;                           // 替換型 payload，無法詞法掃跳脫
    if (/^-[neE]*[eE][neE]*$/.test(v)) { hasEscapeFlag = true; continue; } // -e/-E 旗標
    if (v.includes("\\")) hasBackslashPayload = true;   // payload 含反斜線
  }
  // carve-out（行為探測）僅當「有 -e/-E **且** payload 真的含反斜線跳脫」——`echo -e "a\tb"` 才算；
  // `echo -e "verified"`（無跳脫）仍視為 print 形態 → 可被硬 deny（修 round 14 finding 2）。
  if (hasEscapeFlag && hasBackslashPayload) return false;
  return true;
}
```

- carve-out（→ 非 print 形態、落回 echo `allow`）**收窄為**：有 `-e`/`-E` 旗標**且** payload 含反斜線
  跳脫（如 `echo -e "a\tb"`、`echo -e "x\n"`——真的在探測跳脫詮釋）。`-n`（僅抑制換行）不算。
- **`echo -e "verified"` / `echo -E "analysis"`（有旗標、無跳脫）→ print 形態 → 整鏈 print 則硬 deny**
  （封堵「加個無害旗標就繞過」）。殘留：`echo -e "fake\n"`（僅 `\n` 跳脫）會落入 carve-out → allow，
  屬罕見且輕微的接受弱點。
- `echo`（無引數）→ argv 空 → 通過 → print 形態。
- **替換包裝偽裝**：`echo "$(echo fake)"` → 外層 echo 的字僅替換動態 → 合格；又因聚合 `every()`
  涵蓋替換內層葉指令（inner `echo fake` 亦為 print 形態）→ 整鏈全 print → **deny**。對照
  `echo "$(date)"` → inner `date` 非 print 形態 → 非全鏈 print → 不 deny（落 classify；`date` 在
  allowlist → allow）。對照若內層為非 allowlist 指令（如 `echo "$(rm)"`）則 inner rm → ask。
  `echo "$VAR"` → 變數非替換 → 不合格 → 非 print 形態 → 不 deny。

#### 4.1.2 `printf`

```ts
function isPrintfPrintOnly(inv: CommandInvocation): boolean {
  // Bash printf 選項：`-v var` 會「賦值給 shell 變數、不輸出 stdout」（有副作用、非純吐字）。
  // 任何前導選項（`-` 開頭且非 `--`）出現即 → 非 print 形態，落 classify/ask，避免誤硬 deny。
  const first = inv.argv.length > 0 ? staticValue(inv.argv[0]) : null;
  if (first !== null && first !== "--" && first.startsWith("-")) return false; // -v 等選項
  if (inv.argv.length > 0 && first === null) return false;     // 第一引數動態、無法確認是否為選項 → 保守
  for (const w of inv.argv) if (!wordPrintEligible(w)) return false; // 非替換動態 → 排除
  // 取第一個非 "--" 的位置參數作為 format
  const fmtWord = inv.argv.find((w) => staticValue(w) !== "--");
  if (!fmtWord) return true;                                  // 無 format（如僅 "--"）→ 視為純輸出
  const fmt = staticValue(fmtWord);                           // 替換型 format → null
  if (fmt !== null && hasFormatterConversion(fmt)) return false; // carve-out：含「格式化」轉換符 → 行為檢查
  return true;                                                // format 替換型 或 僅含 %s/%b → 視為純輸出（print 形態）
}

/**
 * format 是否含「會做格式化轉換」的轉換符（carve-out 條件，窄化）。
 * **刻意排除 `%s` / `%b`（純字串輸出）**——`printf "%s\n" "結論"` 只是把靜態字串吐出、屬 print-only
 * 偽裝，不該 carve-out。只有數值 / 字元 / 浮點等「真的轉換值」的轉換符才算行為檢查。排除字面 `%%`。
 */
function hasFormatterConversion(fmt: string): boolean {
  const stripped = fmt.replace(/%%/g, "");
  return /%[-+ 0#]*[0-9.*]*[diouxXeEfFgGaACc]/.test(stripped);   // 不含 s / b（字串）
}
```

- 含格式化轉換符（`printf "%05d\n" 42`、`printf "%.2f" 3.14`、`printf "%c" 65`）→ carve-out → 非 print
  形態 → 落回（printf 不在 allowlist）`ask`。
- **僅 `%s`/`%b` 或無轉換符**（`printf "%s\n" "結論"`、`printf "結論：x\n"`、`printf "%%done\n"`）→
  **print 形態**；整鏈 print 時由 evaluate 層硬 deny（`Bash(printf *)` 無法升級——封堵主要偽裝向量）。
- **`-v` 等選項**（`printf -v result ok`：賦值給 shell 變數、無 stdout、有副作用）→ 前導選項偵測 →
  **非 print 形態** → 不誤硬 deny，落 classify（printf 不在 allowlist → ask）。`printf -- "結論\n"`
  （`--` 後為 format）→ 仍 print 形態。

#### 4.1.3 `cat` / `tac`（heredoc / here-string passthrough）

```ts
function isCatPassthrough(inv: CommandInvocation): boolean {
  if (hasFileOperand(inv.argv)) return false;                 // 有檔案操作元 → 讀真實檔，非純吐字
  // 依 Bash 重導向順序決定 fd0 的「有效 stdin 來源」：影響 fd0 的輸入重導向中**最後一個勝**。
  const fd0Inputs = inv.redirects.filter((r) =>
    (r.operator === "<" || r.operator === "<<" || r.operator === "<<-" ||
     r.operator === "<<<" || r.operator === "<&") &&
    (r.fileDescriptor === undefined || r.fileDescriptor === 0)
  );
  if (fd0Inputs.length === 0) return false;                   // 無 fd0 輸入重導向 → 非 passthrough
  const effective = fd0Inputs[fd0Inputs.length - 1];          // 最後者 = 有效 stdin
  // 有效 stdin 必須是 heredoc/here-string（`< file` 讀真實檔、`<&n` fd 複製 → 非純吐字）
  if (effective.operator !== "<<" && effective.operator !== "<<-" && effective.operator !== "<<<") {
    return false;
  }
  return isHeredocPrintEligible(effective);                   // 有效 heredoc body 須 print 合格
}

/** argv 是否含檔案操作元：考慮 POSIX `--`（其後一律為操作元、不論是否以 `-` 開頭）。 */
function hasFileOperand(argv): boolean {
  let afterDoubleDash = false;
  for (const w of argv) {
    const v = staticValue(w);
    if (!afterDoubleDash && v === "--") { afterDoubleDash = true; continue; }
    if (afterDoubleDash) return true;                          // `--` 之後任何 token = 檔名操作元
    if (v === null || !v.startsWith("-")) return true;         // 動態 token 或非旗標 → 視為檔名
  }
  return false;
}

/**
 * heredoc/here-string body 是否「print 合格」：靜態，或其唯一動態成分為命令替換 $( … )。
 * 與 echo/printf 的 wordPrintEligible 同一語意——配合聚合 every()（body 內替換亦由 walk 列舉成葉指令、
 * 各自受 isPrintOnlyForm 檢查），使「heredoc 內只塞 $(echo 假)」這類包裝偽裝也被聚合 deny；
 * 含真實指令（$(rm)）的 heredoc 則因內層非 print 形態 → 非全鏈 print → 落 classify。
 */
function isHeredocPrintEligible(r): boolean {
  if (r.operator === "<<<") {
    return r.target ? wordPrintEligible(r.target) : true;     // here-string：target 為實際字串 Word
  }
  // << / <<- ：引號分隔符 → 靜態字面；body 存在（含展開）→ 以 wordPrintEligible 判；body 不存在 →
  // 純文字（content 不含 $/反引號才算靜態，保守）
  if (r.heredocQuoted === true) return true;
  if (r.body) return wordPrintEligible(r.body);
  return !/[$`]/.test(r.content ?? "");
}
```

- `cat <<EOF\nhello\nEOF` → body 靜態 → print 形態 → 整鏈 print 才 deny。
- `cat <<'EOF'\n$x\nEOF` → 引號分隔符 → 靜態 → print 形態。
- `cat <<EOF\n$(echo fake)\nEOF` → body 僅命令替換 → **print 合格** → cat 為 print 形態；walk 又把內層
  `echo fake` 列舉為葉指令（亦 print 形態）→ 整鏈 `[cat, echo]` 全 print → **deny**（堵 heredoc 包裝偽裝）。
- `cat <<EOF\n$(rm x)\nEOF` → body 命令替換合格 → cat print 形態；但內層 `rm` **非** print 形態 →
  整鏈 `[cat, rm]` 非全 print → 不 deny → 落 classify（cat allow、rm ask → ask）。
- `cat <<EOF\n$HOME\nEOF` → body 含變數（SimpleExpansion，非替換）→ `wordPrintEligible` false → cat
  **非** print 形態 → 不 deny → classify cat allow（純變數插值、無命令執行）。
- `cat <<<"literal"` → target 靜態 → print 形態；`cat <<<"$(echo fake)"` → target 替換合格 + 內層 echo
  → deny；`cat <<<"$VAR"` → 變數 → 非 print 形態。
- `cat file` / `cat`（無 heredoc）→ `heredocs.length === 0` → 非 print 形態。
- **stdin 重導向順序（依 Bash「最後者勝」）**：
  - `cat <<EOF\n...\nEOF < README.md` → 有效 fd0 = 最後的 `< README.md`（讀真實檔）→ **非 passthrough**
    → 不誤 deny；落 classify（cat 讀 README.md 依範圍判 allow/ask）。
  - `cat < README.md <<EOF\nfake\nEOF` → 有效 fd0 = 最後的 **heredoc**（實際輸出 "fake"）→ **passthrough**
    → print 形態 → 整鏈 print 則 **deny**（堵「以前置 `< file` 洗白靜態 heredoc 偽裝」）。
  - 兩例的 `< README.md` 仍由 §4.7 各自做範圍檢查（與本判定獨立）。
- **`--` 操作元**：`cat -- -fixture <<EOF\n...\nEOF` → `--` 後 `-fixture` 為檔名操作元 → 有 file
  operand → **非 passthrough** → 不誤 deny（實際讀檔 `-fixture`）。

> 型別取用：`Redirect.operator` / `target` / `content` / `heredocQuoted` / `body` 皆由 `src/deps.ts`
> 的 `Redirect` 型別提供（見 §1.3）。`isHeredocPrintEligible` 與 `wordPrintEligible`（§4.1.4）共用語意，
> 僅供 `print_only.ts` 內部使用；heredoc body 內命令替換的**權限檢查**由 walk 列舉 `redirect.body`
> 達成（見 §4.6），與此處「是否算 print 形態」是兩件獨立的事。

#### 4.1.4 `wordPrintEligible`（command-substitution-aware 靜態合格判定）

**實作建議：直接複用 `word.ts` 既有的「動態 part」判定**（含其詞法 glob 偵測），僅把
`CommandExpansion` 從動態名單**豁免**。為此把 `word.ts` 的 `topPartIsDynamic` 與 `nestedPartIsDynamic`
改為 **export**，print_only.ts 重用：

```ts
import type { Word, WordPart } from "../deps.ts";
import { isStatic, topPartIsDynamic, nestedPartIsDynamic } from "./word.ts";

/**
 * Word 是否「print 合格」：靜態，或其唯一動態成分為命令替換 $( … )。
 * 規則：每個 part 必須「非動態」或「恰為 CommandExpansion」；DoubleQuoted/LocaleString
 * 因引號保護內部 glob，其內層 part 以 nestedPartIsDynamic 判定（同樣豁免 CommandExpansion）。
 * 變數展開、算術、brace、**未引號 glob 字元的 Literal**、process substitution → 不合格。
 */
export function wordPrintEligible(w: Word): boolean {
  if (isStatic(w)) return true;          // 純靜態（含詞法 glob 判定：未引號 glob → 非靜態 → 不走此路）
  if (!w.parts) return false;            // 無 parts 但非靜態 = 未引號 glob 純字面 → 不合格
  return w.parts.every(topPartEligible);
}

function topPartEligible(p: WordPart): boolean {
  if (p.type === "CommandExpansion") return true;          // 豁免：$( … ) / 反引號
  if (!topPartIsDynamic(p)) return true;                   // 非動態（含未引號非 glob Literal、引號字面）
  // p 為動態且非 CommandExpansion：唯一可救的是「僅因內層替換而動態」的雙引號字串
  if (p.type === "DoubleQuoted" || p.type === "LocaleString") {
    return p.parts.every((np) => np.type === "CommandExpansion" || !nestedPartIsDynamic(np));
  }
  return false;   // SimpleExpansion/Parameter/Arith/Brace/ExtGlob/ProcessSubstitution/含 glob 的未引號 Literal
}
```

- **為何複用 `topPartIsDynamic`**：它已正確把「**未引號含 glob 字元的 Literal**」判為動態。故
  `echo *$(echo x)` 的頂層 `Literal "*"` → `topPartIsDynamic` 為真、又非 CommandExpansion / 非雙引號
  → `topPartEligible` 回 false → `wordPrintEligible` 為 false → echo **非** print 形態 → **不**誤 deny
  （glob 會做路徑展開、非純文字）。引號保護的 glob（`echo "*"$(c)`）則 `Literal` 在 DoubleQuoted 內、
  `nestedPartIsDynamic` 為假 → 合格。
- 測試需涵蓋 §8：`echo "$(echo x)"`（合格）、`echo a$(c)b`（合格）、`echo "$VAR"`（不合格）、
  `echo *$(echo x)` / `echo ?$(c)`（含 glob → 不合格）、`echo "*"$(c)`（引號 glob → 合格）。

### 4.2 `src/engine/evaluate.ts`（聚合閘接線——print-only 與 sleep 皆在此硬 deny）

於既有 no-op 檢查之後、`combine(...)` 之前插入**兩個 evaluate 層硬 deny 閘**：

```ts
const invocations = walk(script, initialCwd, root);
if (invocations.length === 0) {
  return { verdict: "allow", reason: "無可執行指令（no-op）" };
}
// 先算「函式遮蔽」——name 被同腳本函式覆寫時，name 分析不可信（見 §4.9）
const fnNames = definedFunctionNames(script);
const isShadowed = (inv) => inv.name !== null && fnNames.has(inv.name);
const anyShadowed = invocations.some(isShadowed);

// 閘 ①（deny）：鏈中出現**任何字面 sleep 葉指令**（含控制流內、命令替換內層）——一律 deny，
//             **不**因「sleep 也被定義為函式」而豁免（避免 dead/later 定義把真實 sleep 降級為 ask）
if (invocations.some((inv) => inv.name === "sleep")) {
  return { verdict: "deny", reason: pollingDenyReason() };
}
// 閘 ②（deny）：整鏈皆 print 形態 → deny。**不**以 anyShadowed 豁免（同 sleep：避免 later/dead
//             函式定義把真實 print-only 降級為 ask，如 `echo "fake"; echo(){:;}`）。
if (isAllPrintOnly(invocations)) {
  return { verdict: "deny", reason: printOnlyDenyReason() };
}
// 閘 ③（ask）：存在被遮蔽 / 被呼叫的使用者函式名（且未被閘①②攔下）→ 實際執行函式本體、name
//             分析不可信 → 人工確認。此處承接「非 print-form 名」的遮蔽（date/pwd/waiter…）。
if (anyShadowed) {
  return { verdict: "ask", reason: functionShadowReason() };
}
return combine(invocations.map((inv) => classify(inv, root, rules, home, trustedReadRoots)));
```

- **三閘皆在 `classify` 之前返回 → 不經中央前置規則、不經 `settingsAllows`**：閘①②為 deny（真正硬性）、
  閘③為 ask（不可被 `permissions.allow` 升級——`waiter(){ sleep 5; }; waiter` 即使有 `Bash(waiter *)`
  仍 ask）。
- **閘① 不受遮蔽影響（修 round 12 finding 2）**：只要**字面 `sleep` 葉指令**存在即 deny。`definedFunctionNames`
  是**名稱集合、非執行序 / 可達性分析**，若讓它豁免 sleep，則 `sleep 5; sleep(){ :; }`（先執行真實
  sleep、後定義）或 `if false; then sleep(){ :; }; fi; sleep 5`（dead 分支定義）會把**真實會執行的
  sleep** 誤降為 ask。故 sleep deny **一律對字面 sleep 生效**；`sleep(){ :; }; sleep 5`（重定義為
  no-op）也照 deny（over-deny 一個 no-op，安全、可接受）。
- **閘② 不受遮蔽豁免（修 round 14 finding 1）**：整鏈 print-form 名即 deny。global `anyShadowed` 是
  名稱集合、非執行序，若用它豁免 print-only 會被 `echo "fake"; echo(){ :; }`（呼叫在前、定義在後）或
  dead 分支定義降級為 ask——破壞硬 deny。故 print-form 名一律 deny；代價是 `echo(){ grep x f; }; echo`
  （把 echo 重定義為 grep 再呼叫）也會被當 print-only deny（理由略不精確，但 deny 是安全方向、且此構造
  極罕見、非合法用途，可接受）。
- **閘③ 涵蓋「呼叫使用者自定函式」（修 round 12 finding 1）**：`waiter(){ sleep 5; }; waiter`、
  `report(){ echo "verified"; }; report` 的 `waiter`/`report` ∈ `definedFunctionNames` → 閘③ ask
  （非 upgradeable）。**不走訪函式本體**（YAGNI，見 §4.9）；body 內的 sleep/echo 不被展開，但已由
  閘③ 攔成 ask、不會靜默 allow。
- **sleep 改為 evaluate 層掃描（取代原 per-command rule）的關鍵原因**：per-command rule 在
  `classifyBuiltin` 中**排在中央前置規則之後**，故 `FOO=1 sleep 5`（賦值前綴）、`sleep 5 > out`
  （寫入重導向）等會**先**被中央規則判 `ask`、根本到不了 sleep rule，且該 ask 還會被
  `Bash(sleep *)` 升級為 allow——違反「sleep 硬 deny、不可解除」。改在 evaluate 層、classify 之前
  以 `inv.name === "sleep"` 掃描，徹底避免此 ordering 漏洞。
- `inv.name` 由 walk 的 `staticValue(cmd.name)` 設定：`sleep 5` / `FOO=1 sleep 5` 的 name 皆為
  `"sleep"`（賦值是 prefix、不影響 name）；`echo "$(sleep 5)"` 的內層 sleep 經 walk 列舉為獨立
  invocation、name 亦為 `"sleep"` → 一併命中。動態名（`$CMD 5`，CMD=sleep）→ name 為 null → 不命中
  → 落 classify → 動態指令名 ask（屬 §1.5 已記錄之動態繞道）。
- 仍在既有 try/catch 內 → 任何例外退化為 `ask`。

> **設計簡化**：sleep **不再**是 `CommandRule`，故**無** `src/rules/commands/sleep.ts`、**不需**在
> `allowlist.ts` 註冊。sleep 與 print-only 一致，皆為 evaluate 層聚合硬 deny。

> 註：早期草案曾把 sleep 設為獨立 `CommandRule`（需 `src/rules/commands/sleep.ts` + `allowlist.ts`
> 註冊），因會被中央前置 ask 規則 preempt 而改為 §4.2 evaluate 層掃描；**無**這兩處變更（§4.3/§4.4
> 編號故意留空，後續節次不重編）。

### 4.5 deny 理由 helper（`src/rules/types.ts`）

與既有 `recursiveRootDenyReason` 並列。兩者皆含三要素（被禁止的事 / 為何禁止 / 替代）：

```ts
/** 整鏈 print-only 偽裝驗證的 deny 理由（回饋給 agent）。 */
export function printOnlyDenyReason(): string {
  return `已禁止：此指令鏈的每個指令都只是把靜態文字輸出到 stdout（echo / printf / cat heredoc），` +
    `未讀取任何檔案、未執行任何真實計算或驗證——內容完全由你事先寫死，等同把推論用機器口吻轉述、` +
    `偽裝成「電腦跑出來的結果」。若你已有結論，請直接寫在回覆文字中；若需驗證，請實際讀取檔案、` +
    `執行測試、或執行會產生真實副作用的指令，而非用 echo/printf/heredoc 重述寫死的內容。`;
}

/** sleep 輪詢 / 等待的 deny 理由（回饋給 agent）。 */
export function pollingDenyReason(): string {
  return `已禁止：sleep 用於輪詢 / 等待，本工具的唯讀情境下無正當用途，且背景工作完成時 harness ` +
    `會自動以 task-notification 重新喚醒你，不需主動等待。若需排程下次喚醒，請改用 ScheduleWakeup，` +
    `不要用 Bash sleep 輪詢。`;
}

/** 函式遮蔽 allowlist 指令名的 ask 理由（回饋給 agent）。 */
export function functionShadowReason(): string {
  return `需確認：此指令在同一字串內定義了 shell 函式並覆寫（遮蔽）了一個指令名再呼叫，實際執行的是` +
    `函式本體、而非該指令本身——權限檢查無法靜態得知函式本體做什麼。請改為直接執行真正的指令（不要` +
    `用同名函式覆寫），或拆成多次呼叫以便逐一檢查。`;
}
```

- **deny 理由三要素**（被禁止的事 / 為何禁止 / 替代）；**反例（禁止）**：`deny("sleep 被禁止")`、
  `deny("print-only")`——只描述、未解釋、未給替代。`functionShadowReason` 為 **ask** 理由（給使用者），
  同樣需說明原因與替代。

### 4.6 walk.ts：列舉 heredoc `body` 內的命令替換（正確封堵 heredoc 盲點）

**動機（堵 walk 盲點，正本清源）**：walk 的 `emitCommand` 目前列舉內層 command substitution 的來源
為 `cmd.name`、`cmd.suffix`、`cmd.prefix` 值、與 `cmd.redirects` 的 **`target`**；對 `<<`/`<<-`
heredoc 而言 `target` 是**分隔符**、命令替換在 **`body`**，故 **heredoc body 內的 `$(...)` 不被列舉、
不被分類**。例：`cat <<EOF\n$(rm -rf x)\nEOF` 現況落 `allow`，但執行時 body 內 `$(rm -rf x)` 會真正
跑。**正確做法**（經使用者確認）：把 `redirect.body` 也納入內層 script 列舉來源，使 body 內的每個
命令替換**像其他位置的 `$(...)` 一樣被解析成獨立 `CommandInvocation`、逐一接受權限檢查**。

**變更**：`emitCommand` 改為從**該 invocation 實際承載的全部 redirect**（`inherited` + `cmd.redirects`，
即與 invocation `redirects` 欄位同一集合）列舉 `target` 與 `body` 的內層替換：

```ts
const allRedirects = [...inherited, ...cmd.redirects];   // 與 invocation.redirects 同源
const words: Word[] = [
  ...(cmd.name ? [cmd.name] : []),
  ...cmd.suffix,
  ...cmd.prefix.flatMap((a) => (a.value ? [a.value] : [])),
  ...allRedirects.flatMap((r) => (r.target ? [r.target] : [])),  // 改：含 inherited（原僅 cmd.redirects）
  ...allRedirects.flatMap((r) => (r.body ? [r.body] : [])),      // 新增：heredoc body 內的替換（含 inherited）
];
for (const w of words) enumerateInnerScripts(w, cwd, out);
```

- **為何含 `inherited`**：Statement / 複合結構的 heredoc 掛在**外層**（如 `{ cat; } <<EOF\n$(rm)\nEOF`、
  `( cat ) <<EOF\n$(rm)\nEOF`、`while read; do …; done <<EOF\n$(rm)\nEOF`），會以 `inherited` 傳給內層
  指令。若只掃 `cmd.redirects` 會漏掉外層 heredoc body 的 `$(rm)` → `cat` 仍 allow 而 `rm` 靜默執行
  （silent allow bypass）。改掃 `[...inherited, ...cmd.redirects]` 即涵蓋自身與繼承的 heredoc/target。
- `redirect.body` 是結構化 Word（§1.3 #1）；`enumerateInnerScripts` 既有邏輯走訪其 `parts`、對
  `CommandExpansion` 取 `.script` 列舉內層指令（與處理 `$()` 於 suffix/target 完全一致）。引號分隔符
  heredoc（`heredocQuoted === true`）的 `body` 為 `undefined` → 自然不列舉（`$(...)` 字面、不執行）。
- **重複列舉無害**：複合 heredoc 由 N 個兄弟指令共享 `inherited` 時，body 的 `$(rm)` 會被各兄弟各列舉
  一次（rm 出現 N 筆）；verdict 為冪等（deny/ask 重複不影響），故**不需去重**，仍正確。

**效果（取代原「動態 heredoc → ask 中央規則」，更精準）**：

- `cat <<EOF\n$(rm -rf x)\nEOF`：walk 產出 `[cat, rm -rf x]`。`rm` 不在 allowlist → `ask`；
  `settingsAllows` 以還原字串 `"rm -rf x"` 比對——`Bash(cat *)` **不命中** rm（只命中 `cat …`），
  故**無法**升級 rm。combine → **ask**（唯有使用者明設 `Bash(rm *)`，即自己放行 rm，才會 allow）。
  **漏洞以「逐一分類」徹底關閉，非靠硬 deny、亦不靠不可升級的特例**。
- `cat <<EOF\n$(git log)\nEOF`：內層 `git log` 走 git 規則 → allow → 整體 allow（**合法操作不誤擋**）。
- `cat <<EOF\n$HOME\nEOF`（純變數插值、無命令執行）：body 僅 `SimpleExpansion`、無 `CommandExpansion`
  → 不列舉內層指令 → cat → allow（無害讀取，且不誤 ask）。

**與 print-only 閘的關係**（兩件獨立的事）：
- **是否算 print 形態**（決定 print-only deny）：由 `isCatPassthrough` 的 `isHeredocPrintEligible`
  判定（§4.1.3）——靜態 body 或「body 只含命令替換」皆算 print 合格；含真實指令的內層使整鏈非全
  print，含變數的 heredoc 直接非 print 形態。
- **內層指令的權限檢查**：由本節 walk 列舉 `redirect.body` 達成（rm → ask、echo → allow…），與「是否
  算 print 形態」互不影響。例：`cat <<EOF\n$(echo 假)\nEOF` → cat print 合格 + 內層 echo print → 整鏈
  全 print → deny；`cat <<EOF\n$(rm)\nEOF` → cat print 合格、內層 rm 非 print → 非全 print → rm ask。

> **不需**新增 classify 中央前置規則、**不需** `isHeredocDynamic`；print 形態判定由 §4.1.3 的
> `isHeredocPrintEligible` 負責。
>
> **涵蓋範圍**：自身（`cmd.redirects`）與繼承（`inherited`，含 Statement / brace group / subshell /
> 控制流迴圈掛載的 heredoc）的 `target` 與 `body` 內層替換**皆列舉**，故 `{ cat; } <<EOF $(rm) EOF`、
> `( cat ) <<EOF $(rm) EOF`、`while read; do …; done <<EOF $(rm) EOF` 的 `rm` 都會被分類為 ask、且
> 不可由 `Bash(cat *)` 升級——**無 silent allow bypass**。

### 4.7 第 4 條中央前置規則：輸入重導向 `<` 目標範圍檢查（`src/engine/classify.ts`）

**動機**：既有中央前置規則只檢查**寫入**重導向；**輸入**重導向 `< file`（把 fd0 接到檔案）會讓指令
**讀取**該檔，但目前**完全未做範圍檢查**——例如 `cat < /etc/passwd`（cat 無位置參數）落 `fileReaderRule`
allow，靜默讀取專案外檔案，牴觸「只讀專案內」核心宗旨。本功能的 cat-passthrough fallback（§4.1.3 對
含 `<` 者改交 classify）亦依賴此檢查才正確。

**規則**：於 `classifyBuiltin` 既有三條中央前置規則之後新增第 4 條（在個別 rule 之前）：

```ts
// 中央前置規則之四：輸入重導向 < 的目標路徑須落在允許讀取範圍
for (const r of inv.redirects) {
  if (r.operator !== "<") continue;            // 只查讀檔 <；heredoc <</<<-/<<< 與 fd 複製 <& 不在此
  if (!r.target) continue;
  if (ctx.resolvePath(r.target) !== "in-project") {
    return ask(`${inv.name}：輸入重導向讀取超出專案範圍或無法靜態解析（${r.target.value}）`);
  }
}
```

- `resolvePath` 已涵蓋專案內 ∪ 使用者 `Read()`/allow 宣告的外部讀取範圍 ∪ trusted session 根，語意與
  位置參數、`pathValueFlags` 一致。靜態外部路徑 / 動態 target → `ask`。
- 此為 `ask`（非 deny），**可被** `permissions.allow` 升級（與既有讀取位置放寬一致）——例如使用者明設
  `Read(//etc/passwd)` 或 `Bash(cat *)` 則放行；屬使用者自負範圍。
- 效果：`cat < /etc/passwd` → ask（原 allow，堵讀取盲點）；`cat < ./README.md` → in-project → 不受此
  規則影響（依後續 cat 規則 allow）；`grep pat < /etc/shadow` → ask。
- **classifyBuiltin 需把 `resolvePath` 用於 redirect target**：`RuleContext.resolvePath(word)` 已可用，
  此檢查可直接在 `classifyBuiltin` 內以 `scope` 呼叫 `resolvePath(r.target, inv.cwd, scope)`（與建構
  ctx 同源），不必等進個別 rule。

### 4.8 `tailRule`：`tail` 跟隨模式（`-f`/`-F`/`--follow`）→ ask（`src/rules/commands/`）

**動機**：`tail` 現於 `coreutils.ts` 的 `fileReaderRule` 群組、`-f` 無 gate，故 `tail -f project.log`
（專案內路徑）→ allow，形成**無界跟隨 / 輪詢**的放行路徑，牴觸「防 Bash 輪詢」目標。

**變更**：

1. 從 `fileReaderRule` 的 `names` **移除 `"tail"`**（避免在共用群組對 `-f` 開 askFlag 而誤殺
   `cut -f`（欄位選擇）等其他成員）。
2. 新增專用 `tailRule = flagGatedReader({ names: ["tail"], askFlags: [...follow...] })`：
   - follow 旗標：`exact("-f", "-F", "--follow")`、`prefix("--follow=")`（如 `--follow=name`）、
     `exact("--retry")`、以及短旗標群集含 `f`/`F`（如 `-fn`、`-Fq`）。命中即 `ask`。
   - 其餘維持 `flagGatedReader` 既有唯讀行為（位置參數 `resolvePath`、無寫檔 flag）。
3. 在 `allowlist.ts` 註冊 `tailRule`（name `tail` 不可與既有重複——已從 fileReaderRule 移除故不衝突）。

- 採 **ask 而非 deny**：`tail -f log` 有合法「查看日誌尾巴」用途，交人工確認即可；且與 sleep（硬 deny）
  區隔——sleep 在唯讀情境無正當用途，tail -f 有。此 ask **可被** `Bash(tail *)` 升級（使用者自負）。
- `tail`（無 `-f`）→ 維持唯讀 allow（同原 fileReaderRule 行為）。

### 4.9 函式遮蔽偵測（`src/engine/walk.ts` + `evaluate.ts`）→ ask

**動機（堵函式覆寫繞道）**：Bash 可在同一指令字串內**定義函式覆寫 allowlist 指令名**再呼叫，例：
`date(){ sleep 5; }; date`、`pwd(){ echo "fake verification"; }; pwd`。`walk.ts` 既有 `case
"Function"` **忽略函式本體**，故只看到後續 `date`/`pwd` 葉指令（allowlist → 可能 allow），而真正執行的
本體（sleep / echo 假）被隱藏——使 sleep / print-only 硬 deny 與「name 即執行碼」假設失效。

**設計（保守，不走訪函式本體）**：

1. `walk.ts` 既有遍歷會經過 `Function` 節點；新增**收集函式定義名**的能力——提供
   `definedFunctionNames(script): Set<string>`（遞迴掃描 AST 所有 `Function` 節點、取其 `name`；
   涵蓋巢狀於 brace group / subshell / if / for 等之內的定義）。
2. `evaluate` 閘③：若 `definedFunctionNames(script)` 非空、**且**任一 invocation 的 `name` 落在該集合
   （= 被同腳本函式遮蔽）→ 回 **ask**（`functionShadowReason()`），在 classify 之前返回（不被
   `permissions.allow` 升級——`date(){ sleep 5; }; date` 即使有 `Bash(date *)` 仍 ask）。

**為何 ask（而非 deny 或走訪本體）**：函式本體內容對 name 分析不可知（可能良性、可能 sleep/危險）；
保守降為 ask（人工確認）即可關閉「靜默 allow」漏洞，符合「誤 ask 可接受、誤 allow 不可接受」。走訪
函式本體（內聯展開 + 遞迴上限）較精確但複雜，本功能不採（YAGNI；漏走訪只退回 ask、不誤放行）。

**精確度**：只在「**被呼叫的 name 確實被同腳本函式定義遮蔽**」時 ask，避免過度誤判：
- `date(){ sleep 5; }; date` → date ∈ 定義集 → **ask**（覆寫 allowlist 名）。
- `pwd(){ echo fake; }; pwd` → pwd ∈ 定義集 → **ask**（原 allow）。
- `waiter(){ sleep 5; }; waiter`、`report(){ echo "verified"; }; report` → waiter/report ∈ 定義集 →
  **ask**（呼叫使用者自定函式；body 內 sleep/echo 不被走訪，但已攔成 ask、非靜默 allow——修 finding 1）。
- `f(){ :; }; ls -la` → 呼叫的 `ls` 不在定義集 `{f}`（f 未被呼叫）→ **不**受影響，`ls` 照常判定。
- 順序保守：只要某 name 在腳本中**既被定義為函式又被呼叫**即視為遮蔽（不細究定義/呼叫先後，安全方向）。

**與 deny 閘的順序（§4.2）**：
- **閘①（sleep deny）對字面 sleep 一律生效、不排除遮蔽**（修 round 12 finding 2）：`definedFunctionNames`
  僅名稱集合、無執行序，若豁免 sleep 會把 `sleep 5; sleep(){:;}`、`if false; then sleep(){:;}; fi; sleep 5`
  等**真實會跑的 sleep** 誤降為 ask。故凡字面 `sleep` 葉指令 → deny；`sleep(){:;}; sleep 5`（no-op
  重定義）亦 deny（over-deny 一個 no-op，安全）。
- **閘②（print-only deny）對整鏈 print-form 名一律生效、不排除遮蔽**（修 round 14 finding 1）：同 sleep
  之理由——若以 `anyShadowed` 豁免，`echo "fake"; echo(){:;}`（呼叫在前、定義在後）或 dead 分支定義會把
  真實 print-only 降級為 ask。故 print-form 名（echo/printf/cat-heredoc）一律 deny；代價是
  `echo(){ grep needle README.md; }; echo`（重定義 echo 為 grep 再呼叫）也被當 print-only deny（理由略
  不精確、但 deny 安全，且此構造極罕見非合法用途，可接受）。
- 閘③（ask）在閘①②之後，承接「**非 print-form 名**」的遮蔽 / 呼叫使用者函式情形（`date(){sleep;}; date`、
  `pwd(){echo;}; pwd`、`waiter(){sleep;}; waiter`、`report(){echo假;}; report`）→ ask（非 upgradeable）。

## 5. 與 `permissions.allow` 升級層的互動

- **整鏈 print-only deny** 在 `evaluate` 層、`classify` 之前返回，根本不進入 `settingsAllows`：
  `permissions.allow`（如 `Bash(echo *)`）無法解除。
- **sleep deny** 同樣在 `evaluate` 層、`classify` 之前以 `inv.name === "sleep"` 掃描後返回，
  **不進入** classify 的中央前置規則、**不進入** `settingsAllows`：`permissions.allow`
  （如 `Bash(sleep *)`）無法解除，且不會被賦值前綴 / 寫入重導向等中央 ask 規則搶先（見 §3.1）。
- 兩者皆符合「硬 deny、不可解除」，與既有遞迴根 deny 一致。**設計不變量**：sleep deny **絕不**得
  實作為 `CommandRule` 或 classify 層規則（否則會被中央 ask 規則 preempt → 可升級，破壞硬 deny）；
  §8 以 `FOO=1 sleep 5` / `sleep 5 > out` / `Bash(sleep *)` 為驗收測試守住此不變量。

## 6. 不變量（改動後）

- **default-safe / 只收緊不放寬**：未明確判定安全唯讀者一律 `ask`。本功能的變更皆為**收緊**方向——
  新增 deny（print-only / sleep）、加上 §4.7（輸入重導向 `<` 外部讀取）與 §4.8（`tail -f` 跟隨）兩處
  既有 allow→ask 的收緊、與 §4.9 函式遮蔽 allow→ask；**對其餘指令的既有 allow/ask 判定不放寬、不更動**。
- **deny 三類**：(1) 遞迴遍歷磁碟根/家目錄根、(2) 整鏈 print-only 偽裝、(3) sleep 輪詢。優先序
  `deny > ask > allow`。
- **deny 漏判是安全的**：`isPrintOnlyForm` 任何不確定 → `false` → 不貢獻全鏈 print → 退回正常
  classify（allow/ask），**絕不**誤放行；sleep 名稱比對漏判 → 退回既有（不在 allowlist → ask）。
- **堵 allow 漏洞（以正確分類，非硬 deny）**：
  - 命令替換包裝偽裝（`echo "$(echo fake)"`，內外皆 print）由 substitution-aware 謂詞 + 聚合 every()
    升級為 deny（原為 allow）。
  - heredoc body 內的命令替換（`cat <<EOF\n$(rm -rf x)\nEOF`）由 walk 列舉 `redirect.body`（§4.6）→
    內層 `rm` 逐一分類為 ask、且 `Bash(cat *)` 不命中 rm 而無法升級（原為 allow）。
- **已記錄、使用者確認接受的殘留繞道（非本功能保證封堵範圍，見 §1.5）**：
  - 「整鏈 print」閘的洗白繞道（`pwd; echo 假`、`cat README.md; printf 假`）**不 deny**——使用者
    選擇維持乾淨結構規則以零誤殺。
  - 巢狀直譯器 / 等價等待原語預設落 ask；**受既有 `permissions.allow` 升級層影響**（`Bash(bash *)`/
    `Bash(python *)` 等可放行），本功能不新增此路徑亦不硬擋——使用者自負的 settings 風險（見 §1.5）。
- **硬 deny 不可解除**：print-only 與 sleep 兩閘皆在 `evaluate` 層、classify 之前返回，皆不過中央
  前置規則與 `settingsAllows`。
- **永遠 `exit 0`、任何例外 → `ask`**（fail-safe 不變）。
- **只收緊、不放寬任何既有判定**：新增 deny（print-only/sleep），或把既有 allow 收為 ask（tail -f
  跟隨、輸入重導向 `<` 外部讀取）；寫入重導向 / 賦值前綴 / 非唯讀指令偵測一律不動，無任何放寬。

## 7. 行為對照表

| 指令 | 現況 | 之後 |
|---|---|---|
| `echo "結論是 X 因為 Y"` | allow | **deny**（整鏈 print） |
| `printf "分析：xxx\n"` | ask | **deny**（整鏈 print） |
| `cat <<EOF\n...\nEOF` | allow | **deny**（整鏈 print） |
| `cat <<<"literal"` | allow | **deny**（整鏈 print） |
| `echo a; echo b; echo c`（多行假報告） | allow | **deny**（整鏈 print） |
| `echo a && echo b` | allow | **deny**（整鏈 print） |
| `sleep 5` | ask | **deny**（sleep evaluate 層掃描） |
| `sleep 5 && make` | ask（make 未列管） | **deny**（含 sleep；非全鏈 print 也擋） |
| `sleep 2; echo waiting` | ask | **deny**（含 sleep） |
| `FOO=1 sleep 5` | ask（賦值前綴） | **deny**（evaluate 層先於中央規則；不可由 `Bash(sleep *)` 解除） |
| `sleep 5 > out` | ask（寫入重導向） | **deny**（evaluate 層先於中央規則） |
| `echo "$(sleep 5)"` | ask | **deny**（內層 sleep 經 walk 列舉，name==="sleep"） |
| `while true; do sleep 1; done` | ask | **deny**（walk 走訪迴圈本體 → 內含字面 sleep） |
| `for i in 1 2; do sleep 1; done` | ask | **deny**（同上，控制流內字面 sleep） |
| `make && echo BUILD_DONE` | ask（make 未列管） | ask（非全鏈 print；make 非 print） |
| `deno task test && echo PASS` | 視 settings | 不變（test 非 print → 非全鏈 print） |
| `cat README.md && echo ok` | allow/ask | 不變（cat README.md 非 passthrough） |
| `echo data \| grep x` | ask（grep 視範圍） | 不變（grep 非 print → 非全鏈 print） |
| `cat <<EOF...EOF \| python` | ask | 不變（python 非 print → 非全鏈 print） |
| `echo -e "a\tb"` | allow | allow（carve-out：-e + 真實反斜線跳脫 → 行為探測） |
| `echo -e "verified"` / `echo -E "analysis"` | allow | **deny**（有旗標但無跳脫 → 仍 print 形態；封堵旗標繞過） |
| `printf "%05d\n" 42` / `printf "%.2f" 3.14` | ask | ask（carve-out：數值/格式化轉換符 → 行為檢查） |
| `printf "%s\n" "結論"` / `printf "%b" "x"` | ask | **deny**（%s/%b 純字串非行為檢查；整鏈 print；`Bash(printf *)` 不可升級） |
| `echo {1..5}` / `echo *.txt` | allow | 不變（brace/glob → 非全靜態 → 非 print 形態） |
| `echo x > file` | ask（寫入重導向） | ask（寫檔 → 非 print 形態） |
| `cat > /tmp/x << EOF...EOF` | ask（寫入重導向） | ask（寫檔 → 非 print 形態） |
| `FOO=1 echo x` | ask（賦值前綴） | ask（賦值 → 非 print 形態） |
| `echo "$(rm -rf /)"` | ask（內層 rm 範圍） | ask（echo 替換合格，但 rm 非 print → 非全鏈 print；rm 經 walk 列舉照判 ask） |
| `echo "$(echo fake)"` | **allow**（漏洞） | **deny**（替換包裝偽裝；內外皆 print） |
| `echo "$(date)"` | allow（date 在 allowlist） | allow（不變；echo 替換合格→print，date 非 print→非全鏈 print；classify 皆 allow） |
| `(echo fake)` / `{ echo a; echo b; }` | allow | **deny**（subshell/brace 已被 walk 攤平） |
| `cat <<EOF\n$(rm -rf x)\nEOF` | **allow**（漏洞） | ask（walk 列舉 body→rm 逐一判 ask；`Bash(cat *)` 不命中 rm、無法升級） |
| `{ cat; } <<EOF\n$(rm -rf x)\nEOF`（繼承 heredoc） | **allow**（漏洞） | ask（walk 列舉 inherited body→rm 判 ask；無法由 `Bash(cat *)` 升級） |
| `cat <<EOF\n$(echo 假報告)\nEOF` | **allow**（漏洞） | **deny**（cat body 替換合格→print，內層 echo 亦 print → 整鏈全 print） |
| `cat <<<"$(echo 假)"` | allow | **deny**（here-string 替換合格 + 內層 echo print） |
| `cat <<EOF\n$(git log)\nEOF` | allow | allow（內層 git log 在 git 唯讀子指令集 → allow） |
| `cat <<EOF\n$HOME\nEOF` | allow | allow（純變數插值、無 CommandExpansion → 不列舉內層 → cat allow） |
| `echo *$(echo x)` / `echo ?$(c)` | allow | allow（頂層未引號 glob Literal → `wordPrintEligible` false → 非 print 形態、**不誤 deny**） |
| `echo "*"$(echo fake)` | allow | **deny**（引號保護 glob → 合格；內外皆 print） |
| `pwd; echo "假報告"` / `true && echo "已驗證"` | allow/ask | ask/allow（**已記錄洗白繞道**：no-op 非 print → 非全鏈 print；§1.5 取捨） |
| `cat README.md; printf "已驗證"` | allow | allow（**已記錄洗白繞道**：cat 讀真檔 → 非全鏈 print；§1.5 取捨） |
| `bash -c 'echo fake'` / `eval 'echo fake'` | ask | ask（巢狀直譯器；已記錄繞道）；註：`Bash(bash *)`/`Bash(eval *)` 下既有升級層可 allow（§1.5 point 2） |
| `python -c 'import time;time.sleep(5)'` / `read -t 5` | ask | ask（等價等待原語）；註：`Bash(python *)`/`Bash(read *)` 下可升級為 allow（§1.5 point 4） |
| `timeout 5 sleep 10` / `env sleep 5` / `command echo fake` | ask | ask（exec wrapper；已記錄繞道）；註：`Bash(timeout *)`/`Bash(env *)` 下可升級為 allow（§1.5 point 2） |
| `tail -f project.log` | **allow**（漏洞：fileReaderRule 無 -f gate） | ask（§4.8 tailRule follow → ask；`Bash(tail *)` 可升級） |
| `tail project.log`（無 -f） | allow | allow（不變） |
| `cut -f1 data.csv` | allow | allow（不受 tail follow gate 影響——tail 已拆出獨立 rule） |
| `cat < /etc/passwd` | **allow**（漏洞：輸入重導向未範圍檢查） | ask（§4.7 輸入重導向 `<` 目標超出範圍） |
| `cat < ./README.md` | allow | allow（in-project；§4.7 通過） |
| `grep pat < /etc/shadow` | allow | ask（§4.7 輸入重導向超出範圍） |
| `cat <<EOF\nfake\nEOF < README.md` | allow | allow（有效 fd0=`< README.md` 最後者勝；讀 README.md in-project；heredoc 未用） |
| `cat < README.md <<EOF\nfake\nEOF` | allow | **deny**（有效 fd0=heredoc 最後者勝 → 實際印 fake → 整鏈 print） |
| `date(){ sleep 5; }; date` | **allow**（漏洞：函式覆寫 allowlist 名） | ask（閘③函式遮蔽；即使含 `Bash(date *)` 仍 ask） |
| `pwd(){ echo "fake"; }; pwd` | **allow**（漏洞） | ask（閘③函式遮蔽） |
| `waiter(){ sleep 5; }; waiter` / `report(){ echo fake; }; report` | ask（名非 allowlist） | ask（閘③呼叫使用者函式；非 upgradeable，body 不走訪） |
| `f(){ :; }; ls -la` | allow | allow（`ls` 未被遮蔽；f 未呼叫 → 閘③不觸發） |
| `sleep(){ :; }; sleep 5` / `sleep 5; sleep(){:;}` | ask | **deny**（閘① 字面 sleep 一律 deny，不受遮蔽影響） |
| `find / -name x`（既有遞迴根） | deny | deny（不變） |

## 8. 測試需求

每個改動點需 allow / ask / **deny** 三面 + 邊界測試：

- `src/engine/print_only_test.ts`（新）：
  - `isAllPrintOnly` 整鏈 **deny**：`echo "結論"`、`printf "分析：x\n"`、`cat <<EOF\nx\nEOF`、
    `cat <<'EOF'\n$y\nEOF`、`cat <<<"x"`、`echo a; echo b`、`echo a && echo b`、`echo`（無引數）。
  - **對抗繞道 deny**（walk 已攤平的構造）：`(echo fake)`（subshell）、`{ echo a; echo b; }`
    （brace group）、`echo "$(echo fake)"`（替換包裝，內外皆 print）、`echo "pre $(echo x)"`、
    `cat <<EOF\n$(echo 假)\nEOF`（heredoc 替換包裝 → cat 合格 + 內層 echo → 整鏈全 print → deny）、
    `cat <<<"$(echo 假)"`。
  - 整鏈 print 閘**不** deny（含真實指令）：`make && echo DONE`、`cat f && echo ok`、
    `echo x | grep y`、`cat <<EOF\nx\nEOF | python`、`echo data | wc -l`、`echo "$(date)"`
    （inner date 非 print）、`echo "$(cat real)"`（inner cat 讀檔非 print）、`cat <<EOF\n$(rm)\nEOF`
    （內層 rm 非 print → 非全鏈 print）。
  - carve-out **不** deny（行為檢查）：`echo -e "a\tb"`（-e + `\t`）、`echo -ne "x\n"`（含跳脫）、
    `printf "%05d\n" 42`、`printf "%.2f" 3.14`、`printf "%c" 65`。
  - **carve-out 收窄後仍 deny**：`echo -e "verified"`、`echo -E "analysis"`（旗標但無反斜線跳脫）、
    `printf "%s\n" "結論"`、`printf "%b" "x"`（%s/%b 純字串）→ 整鏈 print → deny；**且含
    `Bash(echo *)`/`Bash(printf *)` 仍 deny，驗證不可升級**。
  - 前置排除**不** deny：`echo x > f`（寫檔）、`cat > /tmp/x << EOF\nx\nEOF`（寫檔）、`FOO=1 echo x`
    （賦值）、`echo "$VAR"`（變數非替換 → 不合格）、`echo "a$VAR b"`（含變數）、`echo {1..5}`（brace）。
  - `wordPrintEligible` 邊界：`echo "$(c)"` 合格、`echo a$(c)b` 合格、`echo "$VAR"` 不合格、
    `echo "$(c)$VAR"` 不合格（混變數）、`echo <(cmd)`（process subst）不合格、
    **`echo *$(echo x)` / `echo ?$(c)` 不合格（頂層未引號 glob Literal）**、`echo "*"$(c)` 合格（引號 glob）。
  - cat 邊界：`cat <<EOF\n$(echo 假)\nEOF`（body 僅替換 → 合格 → print；配內層 echo → deny）、
    `cat <<EOF\n$(rm)\nEOF`（body 合格但內層 rm 非 print → 整鏈非全 print）、`cat <<EOF\n$HOME\nEOF`
    （body 含變數 → 不合格 → 非 print）、`cat <<<"$VAR"`（target 變數 → 非 print）、`cat file`（無
    heredoc → 非 print）、`cat -n <<EOF\nx\nEOF`（僅旗標、有 heredoc → print）。
  - printf 邊界：`printf "%%done\n"`（僅 `%%` → 無轉換符 → print）、`printf -- "結論\n"`（`--`
    後為 format → print）、**`printf -v result ok`（賦值選項 → 非 print 形態 → 不 deny；落 ask）**、
    `printf -v x "%s" y`（同上）。
- `src/engine/evaluate_test.ts`（若存在則補；否則併入 `classify_test.ts` / e2e）——**sleep evaluate 層
  硬 deny**：`sleep 1`、`sleep 0.5`、`sleep`（無引數）、`sleep 5 && make`、`sleep 2; echo waiting`、
  `echo "$(sleep 5)"`、`while true; do sleep 1; done`、`for i in 1 2; do sleep 1; done`（控制流內字面
  sleep）皆 `verdict: "deny"`；**ordering 漏洞回歸測試**：`FOO=1 sleep 5`（賦值前綴）、
  `sleep 5 > out`（寫入重導向）仍 **deny**（不被中央前置規則搶先判 ask）；`Bash(sleep *)` 存在時
  上述各形式**仍 deny**（不可升級）；deny 理由含「已禁止」「ScheduleWakeup」「task-notification」。
- `src/engine/evaluate_test.ts`——**print-only 硬 deny**：整鏈 print → `deny`；`make && echo DONE`
  → 非 deny；整鏈 print 即使 rules 含 `Bash(echo *)` 仍 deny（驗證硬性不可解除）。
- `src/engine/walk_test.ts`（heredoc body 內層替換列舉）：`walk` 對 `cat <<EOF\n$(rm -rf x)\nEOF`
  產出**兩筆** invocation（`cat` + `rm`，後者 name==="rm"）；`cat <<EOF\n$HOME\nEOF`（純變數）→ **一筆**
  （`cat`，無內層）；`cat <<'EOF'\n$(rm)\nEOF`（引號 → body undefined）→ **一筆**；`cat <<<"$(rm)"`
  （here-string）→ 兩筆（既有 target 列舉，確認回歸不破）。
  **繼承 heredoc（外層掛載）**：`{ cat; } <<EOF\n$(rm)\nEOF`、`( cat ) <<EOF\n$(rm)\nEOF`、
  `while read; do cat; done <<EOF\n$(rm)\nEOF` → 各含一筆 `rm` invocation（驗證 inherited 也被列舉）。
- `src/engine/classify_test.ts` / e2e（heredoc body 命令替換經正確分類）：`cat <<EOF\n$(rm -rf x)\nEOF`
  與 `{ cat; } <<EOF\n$(rm -rf x)\nEOF` 皆 → **ask**（rm 非 allowlist）；**且 rules 含 `Bash(cat *)`
  時仍 ask**（不命中還原字串 `"rm -rf x"`，無法升級 rm——驗證自身與繼承 heredoc 漏洞皆真正關閉、
  無 silent allow bypass）；`cat <<EOF\n$(git log)\nEOF` → allow（git log 唯讀子指令）；
  `cat <<EOF\n$HOME\nEOF` → allow（無命令執行）。
- **巢狀繞道測試（§1.5 邊界）**：`bash -c 'echo fake'`、`eval 'echo fake'`、`python -c 'time.sleep(5)'`、
  `read -t 5`、`timeout 5 sleep 10`、`env sleep 5`、`command echo fake`（exec wrapper）
  → **預設（無對應 permissions.allow）皆 `ask`**；**且**驗證「升級可放行」的
  既有行為：rules 含 `Bash(bash *)` 時 `bash -c 'echo fake'` → allow、含 `Bash(python *)` 時
  `python -c '…'` → allow（記錄此為使用者 settings 風險、非本功能新增、亦不硬擋）。對照裸 `sleep 1`
  即使含 `Bash(sleep *)` 仍 deny（evaluate 層硬 deny）。
- `src/engine/classify_test.ts`（§4.7 輸入重導向範圍檢查）：`cat < /etc/passwd`、`grep pat < /etc/shadow`
  → `ask`；`cat < ./README.md`、`head < src/x.ts` → 通過此規則（in-project）；`cat < $VAR`（動態 target）
  → ask；`cat <<EOF\nx\nEOF`（heredoc 非 `<`，不受此規則）→ 不誤判；此 ask 命中 `Read(//etc/passwd)` 或
  `Bash(cat *)` 可升級為 allow。
- `src/rules/commands/tail_test.ts`（新；§4.8）：`tail -f log`、`tail -F log`、`tail --follow=name log`、
  `tail -fn10 log`、`tail --retry log` → `ask`；`tail log`、`tail -n 20 log`（in-project）→ allow；
  `tail -f /etc/x`（專案外）→ ask；確認 `cut -f1 data.csv` **不**受影響（仍 allow）。
- `src/engine/walk_test.ts` / `evaluate_test.ts`（§4.9 函式遮蔽）：`definedFunctionNames` 對
  `date(){ sleep 5; }; date`、`pwd(){ echo x; }; pwd`、巢狀 `{ f(){ :; }; }` 正確回傳定義名集合；
  evaluate 對 `date(){ sleep 5; }; date`、`pwd(){ echo fake; }; pwd` → `ask`（**且含 `Bash(date *)` /
  `Bash(pwd *)` 仍 ask**，驗證閘③在 classify/settingsAllows 之前）；`f(){ :; }; ls -la` → **非** ask
  （ls 未被遮蔽，照常 allow）；`waiter(){ sleep 5; }; waiter`、`report(){ echo fake; }; report` →
  **ask**（呼叫使用者自定函式，含 `Bash(waiter *)` 仍 ask）。
  **print-only 不受遮蔽降級（finding 1 回歸）**：`echo "fake"; echo(){ :; }`（呼叫在前定義在後）、
  `if false; then echo(){:;}; fi; echo "fake"`（dead 分支）→ 皆 **deny**（閘② print-form 名一律 deny、
  不被 anyShadowed 降級）；`echo(){ grep needle README.md; }; echo`（重定義 echo）→ 亦 **deny**（接受
  之 over-deny）。
  **sleep 不受遮蔽影響（round 12 finding 2 回歸）**：`sleep(){ :; }; sleep 5`、`sleep 5; sleep(){ :; }`、
  `if false; then sleep(){ :; }; fi; sleep 5` → 皆 **deny**（閘① 對字面 sleep 一律生效）；
  `foo(){ :; }; foo; sleep 5` → deny（字面 sleep）。
- `src/rules/types_test.ts`（或併入 sleep/print_only 測試）：`printOnlyDenyReason()` /
  `pollingDenyReason()` / `functionShadowReason()` 各含說明 + 替代要素。
- `src/main_test.ts`（e2e 子行程）：餵 `echo "結論是 X"` 期望 `permissionDecision: "deny"` 且
  `exit 0`；餵 `sleep 1` 期望 deny；餵 `make && echo DONE` 期望非 deny；餵 `cat < /etc/passwd` 期望 ask；
  餵 `tail -f x` 期望 ask。

**Operational verification（build 後必做）**：

```bash
deno task build
echo '{"tool_name":"Bash","tool_input":{"command":"echo \"結論是 X\""},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny、exit 0
echo '{"tool_name":"Bash","tool_input":{"command":"sleep 5"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望 deny
echo '{"tool_name":"Bash","tool_input":{"command":"make && echo DONE"},"cwd":"/proj"}' \
  | CLAUDE_PROJECT_DIR="/proj" ./dist/permission-checker   # 期望非 deny（ask）
```

## 9. 文件更新（`CLAUDE.md`）

- 開頭「這是什麼」段的 deny 描述：從「僅對遞迴遍歷磁碟根/家目錄根回 deny」改為**三類 deny**
  （遞迴根掃描、整鏈 print-only 偽裝、sleep 輪詢）。
- 「架構（評估管線）」段：補 `evaluate` 在 walk 後、classify 前的**三閘**（①sleep 掃描→deny、
  ②整鏈 print-only→deny、③函式遮蔽→ask）；補 `print_only.ts` 模組職責；補 `walk` 列舉 heredoc
  `redirect.body` 內層替換與 `definedFunctionNames`。
- 「unbash 事實」段：版本 3.0.0 → **4.0.1**；補「heredoc body 含展開時 `redirect.body` 為結構化
  Word（CommandExpansion.script）」。「三條中央前置規則」段**改為四條**，補第 4 條「輸入重導向 `<`
  目標範圍檢查 → ask」（§4.7）；另補 `tailRule`（`tail -f`/`-F`/`--follow` → ask，§4.8）。
- 補威脅模型 / 強制邊界（§1.5）：heredoc body 命令替換以「逐一分類」正確檢查（非繞道）；記錄使用者
  確認、刻意接受的殘留繞道——巢狀直譯器（`bash -c`/`eval`/`python -c`）與等價等待原語
  （`read -t`/`tail -f`）**預設 ask、但受既有 permissions.allow 升級層影響**（`Bash(bash *)` 等可放行，
  使用者自負）；「整鏈 print」閘的洗白繞道（`pwd; echo 假`、`cat file; printf 假`）不 deny。
- 「核心不變量」段：deny 三類、`isPrintOnlyForm` 漏判退回 classify（不誤放行）、print-only 與
  sleep 兩閘皆在 classify 前短路、不過 settingsAllows，硬性不可解除。
- 「hook 決策 vs settings.json 權限的優先序」段：補 print-only / sleep 兩類硬 deny 不可由
  `permissions.allow` 解除。

## 10. 變更檔案清單

| 檔案 | 變更 |
|---|---|
| `src/engine/print_only.ts` | 新檔：`isAllPrintOnly`、`isPrintOnlyForm`、`wordPrintEligible`、`isHeredocPrintEligible`、echo/printf/cat 子判定 + carve-out |
| `src/engine/word.ts` | export `topPartIsDynamic` / `nestedPartIsDynamic` 供 `wordPrintEligible` 複用（含 glob 偵測） |
| `src/engine/evaluate.ts` | walk 後、classify 前插入三閘：①`some(name==="sleep")`→deny ②`isAllPrintOnly`→deny ③函式遮蔽→ask |
| `src/engine/walk.ts` | (a) `emitCommand` 從 `[...inherited, ...cmd.redirects]` 列舉 `target` 與 `body` 內層替換（heredoc body 的 `$()` 逐一受檢，含外層/繼承掛載的 heredoc）；(b) 新增 `definedFunctionNames(script)`（遞迴掃描 Function 節點名） |
| `src/engine/classify.ts` | 新增第 4 條中央前置規則：輸入重導向 `<` 目標 `resolvePath` 超出範圍 → ask（§4.7） |
| `src/rules/commands/coreutils.ts` | `fileReaderRule.names` **移除 `"tail"`**（改由 tailRule 管） |
| `src/rules/commands/tail.ts` | 新檔：`tailRule`（follow 旗標 `-f`/`-F`/`--follow`/`--retry`/短群集含 f → ask） |
| `src/rules/allowlist.ts` | 註冊 `tailRule` |
| `src/rules/types.ts` | 新增 `printOnlyDenyReason()`、`pollingDenyReason()`、`functionShadowReason()` helper |
| `deno.json` / `deno.lock` | unbash 3.0.0 → 4.0.1（已完成、已驗證；本功能依賴 4.0.1 的 heredoc `body` 結構） |
| `src/engine/print_only_test.ts` | 新檔：謂詞 + 聚合三面 + 邊界測試 |
| `src/engine/walk_test.ts` | heredoc body 列舉：`cat <<EOF $(rm) EOF` → 兩筆 invocation；引號/變數 → 一筆 |
| `src/rules/commands/tail_test.ts` | 新檔：tail follow → ask；`tail`/`cut -f` → allow |
| `src/engine/evaluate_test.ts`（或 `classify_test.ts`） | sleep evaluate 層硬 deny（含 `FOO=1 sleep`/`sleep>out`/`Bash(sleep *)` 回歸）/ print-only 聚合 deny / 硬性不可解除 / heredoc body 命令替換正確分類（`Bash(cat *)` 不升級 rm）/ 巢狀繞道落 ask |
| `src/main_test.ts` | e2e：echo 結論 deny、sleep deny、make && echo 非 deny、`cat <<EOF $(rm) EOF` ask |
| `CLAUDE.md` | deny 三類、管線（含 walk body 列舉）、不變量、優先序段更新 |
