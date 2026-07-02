# 設計規格：統一「print-only 載具」偽裝驗證 deny 閘（閘②′）

- 日期：2026-06-28（**2026-07-02 合併改版**）
- 狀態：設計（待實作）
- 註：本版將**既有閘②（shell 層 echo/printf/cat-heredoc print-only，已實作於 `print_only.ts`）**與
  **原規劃閘④（直譯器 print 偽裝，尚未實作）**合併為**單一閘②′「統一 print-only 載具閘」**。
  echo/printf/cat-heredoc 與 node/python 等直譯器形態都註冊為「print **載具（carrier）**」，
  合併後只有一個 `evaluate` 層閘（閘① sleep 之後、閘③ 函式遮蔽之前）、一種**聚合語意**（整鏈語意＋setup 豁免）。
  CLAUDE.md 的硬 deny **維持三類**，只是把「整鏈 print-only 偽裝」這一類的定義**擴充為跨載具**。
- 註：本版承接早期「大幅簡化重寫」的威脅模型——**只針對「agent 用常見形態做 print-only 假驗證」，不防駭客刻意
  繞過**；故凡指令含「非偵測目標的結構」一律**跳過偵測（落 ask）或無視不影響執行的旗標**，不過度解析。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，純唯讀且全落專案內才 `allow`，
其餘 `ask`，並對**三類**情形回**硬 `deny`**（不可由 `permissions.allow` 解除，見 2026-06-21 規格）：

- **遞迴遍歷磁碟根/家目錄根**：於 `classify` 內以 `isDangerousRoot` 判定、對 `deny` 短路（per-leaf）。
- **整鏈 print-only 偽裝**：`evaluate` 層**閘②′**（本規格的合併主體，見下）。
- **sleep 輪詢**：`evaluate` 層**閘①**。

（既有 `evaluate` 層另有**閘③**：函式遮蔽 → `ask`。）所有 deny 皆不經 `settingsAllows` 升級層、`classify` 前短路。

**本規格所做的是把「整鏈 print-only 偽裝」這一類 deny 的範圍擴充**：原本只涵蓋 shell 層 echo/printf/cat-heredoc
靜態吐字（舊閘②），現擴充為涵蓋 node/python 等直譯器的 print 偽裝，統一於單一閘②′。**deny 仍是三類、非四類。**

### 1.1 痛點

舊閘②只攔截 **shell 層**的 echo/printf/cat-heredoc 靜態吐字。agent 可改用**直譯器**達成同一偽裝——寫一段
「整段只有 `console.log`/`print` 印死字串」的程式交給 node/python 執行，把事先寫死的結論吐到 stdout、偽裝成
「跑出來的驗證結果」：

```bash
cat > /tmp/verify.mjs << 'EOF'
console.log("=== <某主題> 行為驗證 ===");
console.log("1. <步驟說明>：…（全部事先寫死的結論）");
console.log("結論：<寫死的是/否判斷>");
EOF
node /tmp/verify.mjs
```

這段腳本整段只有 `console.log` 印死字串——沒讀任何檔、沒做任何真實計算或查證。常見變形：`node -e '…'`/
`python -c '…'` inline、heredoc/pipe 餵 stdin。差別只在把吐字載具從 shell 換成 JS/Python 直譯器。

另有一種**純 shell 兩步偽裝**目前也漏網：先把寫死文字寫進暫存檔、再讀回印出——

```bash
cat > /tmp/q.txt << 'EOF'
<多行事先寫死的「研究計畫 / 結論」>
EOF
cat /tmp/q.txt
```

淨效果與 `echo <寫死文字>` 完全相同，但因中間有**寫入重導向**，目前只落「寫入型重導向 ask」而非 deny。

### 1.2 威脅模型與範圍（**核心**）

- **要擋的**：agent **常見**的 print-only 假驗證——典型情境是「想研究第三方套件/程式行為，卻直接用訓練
  資料寫死結論、用載具 print 出來」。形態單純：裸 `echo`/`printf`、`cat` heredoc、裸 `node -e`/`python -c`、
  `cat > x; node x`、`cat > x; cat x`、heredoc/pipe 餵 stdin。
- **不需擋的**：**駭客刻意包裝 bash 繞過偵測器**。agent 不會為了 print-only 而故意做函式遮蔽、exec-wrapper
  包裝、加冷僻旗標來閃避偵測。
- **核心原則（決定整個簡化）**：
  1. 指令若含**非偵測目標的結構**（定義函式、exec-wrapper、賦值前綴、會注入碼的旗標…）→ **不偵測**
     （不 deny、落既有 ask）。**不**為了攔截這些而過度解析。其中**只有「定義函式」是整閘全域跳過**
     （§4.4）；其餘（exec-wrapper/賦值前綴/注入旗標）是**該葉不算載具**、再由整鏈覆蓋收斂。
  2. **控制流（`if`/`for`/`while`/`case`）不是全域跳過**：其 clause/guard 與各分支經 `walk` 攤平進同一
     `invocations[]`，由**整鏈覆蓋**統一處理——含 guard/多分支引入非載具葉時覆蓋失敗 → 不 deny（安全 under-deny）；
     退化的全載具控制流（如 `for x in a b; do echo 假; done`，clause 無非載具葉）仍 deny（§4.4）。
  3. **不影響「會執行什麼」的旗標**（如 `--transpile-only`、`--experimental-*`、deno `--allow-*`，對只有
     `console.log` 的腳本毫無影響）→ **無視該旗標、繼續偵測**（不是跳過）。
  4. 方向恆安全：不偵測＝更保守（多漏 deny）；**除 cat 讀回複合載具此一意識接受的 narrow exception 外
     （§4.3.2(b)），絕不誤 deny、絕不新增 allow 路徑**。
- **相對舊閘②，本版對純 shell 鏈的行為變更僅一處，且為明確接受的回歸（accepted regression）**：
  **腳本定義任何函式 → 閘②′ 整體跳過**（決策見 §4.4 全域跳過閘），故 `f(){ :; }; echo 假` 由**舊 deny 改為
  不 deny**（退回 ask）。其餘純 shell 鏈行為完全不變（見 §7 回歸）。
  - **已查證的回歸事實（信心度：高）**：現行 `walk.ts` 之 `case "Function"` **不下降函式 body**，
    故 `walk("f(){:;}; echo 假")` = `[echo 假]`、`isAllPrintOnly` 為真 → **舊閘② 確實硬 deny 此指令**；
    本版全域跳過使其變 ask。此**確實**弱化一條已上線的硬 deny，且該函式 `f` 與 `echo` 載具**無遮蔽關係**
    （非單純的 name-shadow）。
  - **為何仍接受**：(1) 威脅模型只擋 **agent 常見** print-only——agent 做假驗證時**不會**先定義函式；
    含函式定義的腳本屬「非偵測目標結構」（與 exec-wrapper/賦值前綴同類，核心原則 1）。(2) 函式定義使
    name 靜態分析整體不可信（正是既有閘③ 存在的理由）；與其對「函式＋載具」做 scope/order-aware 的部分遮蔽
    分析（早期 review round 已因複雜度否決），不如整閘跳過、保持零誤 deny 與規則單純。(3) **方向安全**：
    跳過只把 deny 降為 ask（再落閘③ 或 classify），**絕不**新增 allow 路徑；使用者若以 `Bash(...)` 升級，
    屬其自負的既有 settings 行為。此取捨為使用者定案（見 §6、§8），非未審之疏漏。

### 1.3 已查證事實（unbash 4.0.1，信心度：高）

1. 攤平後 `CommandInvocation` 帶 `name`/`argv`(suffix)/`assignments`(prefix)/`redirects`/`cwd`。
2. heredoc：引號分隔符（`<<'EOF'`）→ `heredocQuoted === true`、body 為 `undefined`、不展開（靜態）；
   未引號含展開 → `body` 為結構化 Word；純文字 → 文字在 `content`。靜態性沿用 `print_only.ts` 既有的
   `isHeredocPrintEligible`（引號分隔符，或 body/content 無 `$`/反引號）。
3. `Pipeline.commands: Statement[]`。`staticValue(word)` 對含展開/未引號 glob 回 `null`（動態）。
4. `definedFunctionNames(script)`（walk.ts 既有）回腳本內所有函式定義名集合。
5. hook `permissionDecision: "deny"` 阻止呼叫並回饋 `permissionDecisionReason`，優先序 `deny > ask > allow`；
   deny 理由須含①被禁止的事②為何③替代。

## 2. 目標與非目標

### 2.1 目標

- 把 `evaluate` 既有閘②（`isAllPrintOnly`）**升級為統一閘②′**：以「print 載具」框架同時涵蓋 shell 層（echo/
  printf/cat-heredoc）與直譯器層（inline、heredoc/pipe stdin、寫檔→執行）的 print 偽裝。命中即整鏈 deny、
  `classify` 前短路、不可由 `permissions.allow` 升級。
- **模組結構**（維持 `src/engine/` 扁平慣例）：
  - `static_output.ts`（**新**）：靜態輸出還原原語——echo/printf/cat-heredoc → 具體輸出字串（`string | null`）；
    `wordPrintEligible` / `isHeredocPrintEligible` / fd0「最後者勝」自 `print_only.ts` 移入或 re-export。
    這是複合載具 WRITE→EXEC 的 WRITE 內容、與 pipe 載具的 producer 輸出**共用的關鍵新能力**。
  - `interp_payload.ts`（**新**）：純函式 `payloadIsAllStaticPrint(source, lang)`（手寫 fail-safe 詞法器）、
    `printExprIsStaticString`（§4.1 全文照搬，含資源上限、js/py 分派、write API STRING-only）。
  - `print_only.ts`（**改造**）：載具框架——葉載具判定、複合載具配對、聚合語意入口
    `printDisguiseDeny(script, invocations, initialCwd)`。
  - `evaluate.ts`：閘② 改呼叫 `printDisguiseDeny`；deny 理由依命中形態客製（見 §4.5）。
- 全程 fail-safe：任何不確定/非目標結構 → 不 deny；`evaluate` 既有 try/catch 收斂例外為 ask；永遠 `exit 0`。

### 2.2 非目標（**刻意排除、皆為安全 under-deny**）

- **不**防刻意繞過：以下一律**跳過偵測（落 ask）**，不嘗試解析/攔截：
  - 腳本**定義任何函式**（`f(){…}`）→ **整個閘②′ 全域跳過**（§4.4.c）；
  - **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`/`xargs`…，葉指令名非載具）；
  - **賦值前綴**（`X=1 node …`、`PATH=… node …`）；
  - 會**注入/改變執行內容**的旗標（`-r`/`--require`/`--import`/`-m`/`--preload`/`--env-file`）；
  - 動態 token（載具名/payload/路徑含變數、`$()`、未引號 glob）。
- **不**做跨 Bash 呼叫關聯（per-call 無狀態）：呼叫1寫檔、呼叫2執行 → 不偵測。本工具所有 deny 共有的根本邊界。
- **不**處理直譯器以外語言（`bash -c`/`perl -e`/`ruby -e`/`php -r`）。
- **不**改寫入重導向/賦值前綴/中央前置任何既有判定。本功能**只收緊（擴充 deny）**，除 §1.2 記錄的函式跳過放寬外，
  不放寬任何既有判定。
- **不**改 `walk.ts` 攤平職責、不改 `CommandInvocation` 結構。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`：walk 之後、閘① sleep 與閘③ 函式遮蔽之間的既有閘②位置，改為呼叫統一入口。
`classify`/`combine`/`parse`/`walk`/各 `rules` 皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ invocations.length === 0 → allow（no-op）
       ├─ 閘①(deny) ：some(name==="sleep") → deny                                  （不變）
       ├─ 閘②′(deny)：printDisguiseDeny(script, invocations, initialCwd) → deny     （★合併升級）
       ├─ 閘③(ask)  ：函式遮蔽 → ask                                                （不變）
       └─ combine(invocations.map(classify))                                        （不變）
```

閘②′ 在 `classify` 前返回 → 天生硬性、不經中央前置、不經 `settingsAllows`。`Bash(node *)`/`Bash(echo *)` 等無法解除。

## 4. 詳細設計

### 4.1 述詞 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_payload.ts`）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該載具視為 print）
**僅當**下列全部成立，否則 `false`（fail-safe）：

**步驟 0：資源上限**（同步 hook 須有界）
- `source` > `MAX_PAYLOAD_BYTES`（建議 64 KiB）或 tokenize token 數 > `MAX_TOKENS`（建議 20000）→ **此 payload**
  `false`，繼續掃其他候選（不全域抑制）。

**步驟 1：Tokenize**（線性掃描，依 lang）
- 跳過：空白、換行、shebang（行首 `#!`…）、註解（js `//`…行尾、`/* */`；py `#`…行尾）。
- `STRING`：js `'…'`/`"…"`、**無 `${` 的模板 `` `…` ``**；py `'…'`/`"…"`/**三引號 `'''…'''`/`"""…"""`**、
  含非-`f` 前綴（`r`/`b`）。**動態（→ `DYNAMIC`）**：含 `${` 的模板、py f-string（`f"…"`/`f'''…'''`）。
- `NUMBER`：`[+-]?` 十進位/小數/指數；js 另允許 `0x`/`0o`/`0b`/底線/`n`(BigInt)。
- `NAME`（識別字，含點號鏈如 `console.log`）、`PUNCT`（`( ) , ;`）、其餘字元（運算子等）→ `OTHER`。
- 字串逸脫、未閉合引號/括號在此偵測；**任何未閉合 → `false`**。

**步驟 2：文法比對**（消費全部 token）：整串須為「一條以上 print 敘述」，每條 `PRINT_FN '(' ARG (',' ARG)* ')' ';'?`：
- `PRINT_FN`：
  - **可帶 `STRING` 或 `NUMBER` 引數**（文字輸出 API）：js `console.log`/`info`/`warn`/`error`/`debug`；py `print`。
  - **僅 `STRING` 引數**（write API：`process.stdout.write(42)` 等數字引數非靜態文字、runtime 可能失敗 →
    不算純文字 print）：js `process.stdout.write`/`process.stderr.write`；py `sys.stdout.write`/`sys.stderr.write`。
- `ARG`：恰一個 `STRING`（write API 僅此）或 `NUMBER`（僅文字輸出 API）。**不允許** `NAME`/`OTHER`/`DYNAMIC`/
  巢狀 `(`/`=`(py kwargs)。
- 須 ≥1 條。

`printExprIsStaticString(source, lang)`：供 `-p`/`--print`（吐運算式值）用——source 須為**純字串字面量/字串串接**
（`STRING (('+') STRING)*`，js；py 同理），非算術/呼叫/變數/模板。

> **對照「真實工作」（皆 `false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、
> `print(json.dumps(d))`、變數 `console.log(x)`、模板 `` `${x}` ``、f-string、`import …`、`if`/`for`。
> **命中（`true`）**：多行 `console.log("…")`、`print("…")`、註解＋print、多字面量逗號分隔、三引號/無 `${}`
> 模板字串、`console.error`/`process.stdout.write` 變體。

### 4.2 靜態輸出還原 `static_output.ts`（**新**）

提供「把 shell 靜態吐字載具還原成具體輸出字串」的純函式，回 `string | null`（`null` = 無法靜態還原）：

- `echoOutput(inv)`：echo 靜態 payload → 還原輸出字串（沿用 `isEchoPrintOnly` 的合格判定與 `-e`/`-E`/反斜線
  carve-out；不合格回 `null`）。
- `printfOutput(inv)`：printf 靜態格式 → 還原輸出（沿用 `isPrintfPrintOnly` 的 carve-out；含格式化轉換符/動態 → `null`）。
- `commandOutput(inv)`：對 `cat`/`tac` 之 heredoc/here-string passthrough（`isCatPassthrough`＋`isHeredocPrintEligible`
  為真、fd0「最後者勝」）→ 還原其**實際 stdout**：**`cat` 原序**、**`tac` 需將 body 按行反轉**（tac 反向逐行輸出）；
  不合格回 `null`。內部可用底層 `heredocOutput(redirect)` 取 body 原文，再依 `inv.name` 決定是否套 tac 反轉。
  此為統一入口——葉載具（echo/printf/cat/tac）皆經此取具體輸出字串。

`wordPrintEligible` / `isHeredocPrintEligible` / fd0「最後者勝」判定自 `print_only.ts` 移入本檔（或於此定義、
`print_only.ts` re-export），因為它們同時被葉載具判定、WRITE→EXEC 的 WRITE 內容還原、與 pipe producer 輸出還原共用。

**此還原能力是本版關鍵新增**：舊閘② 只需判斷「是否 print 形態」（boolean），合併後複合載具 WRITE→EXEC(a) 需要
**取得 WRITE 寫出的實際內容**餵給 §4.1 述詞、pipe 載具需要**取得 producer 的實際輸出**餵給述詞。

### 4.3 載具分類

一個「print 載具（carrier）」是「淨效果為靜態吐字」的單元。分**葉載具**（單一簡單 `Command`）與**複合載具**
（跨葉 pattern）。

#### 4.3.1 葉載具（單一簡單 `Command`，逐指令判定、與位置無關）

> **識別 ≠ 觸發 deny**：葉載具身分是**逐指令**（依 `name`/`argv`/`redirects`）判定、與其在鏈中的位置無關；
> 但 deny 是**整鏈聚合**（§4.4 兩階段）——單一葉載具只有在**全鏈覆蓋成立**時才貢獻 deny，孤立一個
> `node -e '<print>'` 若鏈中另有非載具葉並**不會** deny。


- **shell 靜態吐字**（判定邏輯不變，沿用 `print_only.ts` 既有）：echo 靜態、printf 靜態、cat/tac
  heredoc/here-string passthrough。
- **直譯器 inline**（原向量 A）：`leaf.name ∈ INTERPRETERS`、依 §4.3.3 旗標規則取出 inline-eval payload、
  payload 靜態且無第 2 類注入旗標之前綴 → `payloadIsAllStaticPrint(payload, lang)`。`-p`/`--print` →
  `printExprIsStaticString`。
- **直譯器 heredoc-stdin**（原向量 B）：`leaf.name ∈ INTERPRETERS`、無 inline-eval 旗標、無 script 位置參數、
  fd0 為靜態 heredoc/here-string（fd0「最後者勝」＋`isHeredocPrintEligible`）→ body 餵 `payloadIsAllStaticPrint`。
  無 fd0 重導向（繼承 stdin，hook 看不到）→ 非載具。

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。**deno 子指令解析**：`deno eval <payload>`
→ inline；`deno run -`（裸 dash，`-` 是 stdin 標記、非 script 位置參數）→ heredoc-stdin；`deno run <file>` →
下述 WRITE→EXEC 的 EXEC（`<file>` 為執行 token）。

#### 4.3.2 複合載具（跨葉 pattern）

- **WRITE→EXEC**（原向量 C，緊鄰前驅＋同檔比對規則照舊）：由**緊鄰前一個 sibling 的靜態 WRITE** 與其後
  **EXEC** 成對；EXEC 有兩種：
  - **(a) 直譯器執行同檔**：EXEC 葉 `name ∈ INTERPRETERS`、為「script 執行」形態（非 inline、非 stdin），
    其**直譯器 script 進入點**等於 WRITE 寫出的路徑 P，且 **WRITE 內容須過 `payloadIsAllStaticPrint`**（lang
    由該直譯器決定）。
    - **進入點＝略過旗標/子指令後的第一個位置參數**（回應 review high finding）：依 §4.3.3 略過良性旗標
      （含其值）與注入旗標偵測、deno 的 `run` 子指令後，取**第一個非旗標位置 token** 為進入點；**該進入點之後
      的所有 token 是傳給程式的 argv、不參與比對**。故只有「node/python/deno 真正執行的那個檔＝P」才成對——
      `node runner.js generated.js`（進入點 runner.js ≠ P=generated.js）、`python runner.py fixture.py`、
      `deno run runner.ts fixture.ts` **皆不成對、不 deny**（generated/fixture 只是程式引數，非被執行的腳本）。
  - **(b) cat/tac 讀回同檔**（**新增；意識接受的 narrow 誤-deny exception**）：EXEC 葉 `name ∈ {cat, tac}`、
    其唯一操作元為 WRITE 寫出的路徑 P、無蓋過的 fd0 輸入重導向；**WRITE 內容為任何可靜態還原的文字即可、
    不需過 payload 述詞**（因整個 composite 的淨效果就是把「同呼叫內剛靜態寫死的文字」原樣吐回 stdout）。
    此支封掉 `cat > /tmp/q.txt <<'EOF'…EOF; cat /tmp/q.txt` 兩步偽裝（目前僅落寫入重導向 ask）。
    - **rationale（使用者定案）**：讀回的內容在**同一呼叫內**已被靜態寫死、寫它的模型早已握有該內容 →
      再讀回一次只是「把已知結論繞經 tool 輸入再原樣拿回」的浪費 token 假工作，正是本閘要擋的。
    - **與「絕不誤 deny」的關係（回應 review high finding）**：cat 讀回在詞法上與**合法**的「建立靜態檔再
      檢視」（`cat > config.yaml <<EOF…EOF; cat config.yaml`、建 fixture/README 再 cat）**無法區分**，故此為
      對嚴格「絕不誤 deny」刻意開的**唯一** narrow 例外。**blast radius 受限**：deny 的是**同一呼叫內
      寫死＋立即讀回同檔**這半段冗餘；**合法的檔案「建立」本身不被永久阻擋**——單獨下 WRITE
      （`cat > config.yaml <<EOF…EOF`）＝寫入重導向 ask（可核准），需要檢視時另起一次 `cat config.yaml`
      （純讀取、通常 allow/ask）。使用者僅需**把寫與讀拆到兩次呼叫**或**省去多餘讀回**即可。
    - **鑑別器落差（明載）**：直譯器版 (a) 有 `payloadIsAllStaticPrint` 當鑑別器（全 `console.log` 的 .mjs 交給
      node 執行是強偽裝訊號）；(b) 無任何鑑別器（任何靜態文字皆命中），故 (b) 的誤-deny 面較 (a) 廣——此差異
      為使用者知悉並接受。
  - **WRITE 定義**：緊鄰前一個 sibling 葉指令，名 ∈ {`cat`,`tac`,`echo`,`printf`}、無賦值前綴、其**唯一有效
    fd1 目標**為截斷 `>`/`>|` 到靜態路徑 P、內容可由 `static_output.ts` 靜態還原（cat/tac heredoc body 或
    echo/printf 靜態輸出）。`>>` append、多重輸出重導向、`1>&2` 等 → 非 WRITE。
  - **緊鄰前驅**：WRITE 是 EXEC 在**同一循序序列**（`;`/newline 或 `&&` 連接的 `AndOr`）內的**緊鄰前一個
    sibling**。**WRITE 與 EXEC 之間**有任何其他 statement（含 `cd`：`cat > x; cd other; node x`）、或跨控制流/
    subshell/背景/`||` 邊界 → 非緊鄰前驅 → 不成對。（**允許前面有其他 setup leg**——由 §4.4 聚合語意的 setup
    豁免處理，不在此放寬緊鄰性。）
  - **同檔比對**：以各自 statement 的 cwd 快照 `normalizeAbsolute` 後**字面相等**即同檔。緊鄰前驅時兩端 cwd
    同一快照——cwd known（含 `cd /static`）時解析絕對路徑比對；cwd unknown（如先前 `cd $DYN`）時，**相同
    相對路徑字串**仍同檔（同 cwd）→ 可比對；一絕對一相對且 cwd unknown → 無法證明 → 不成對。
  - `node --require pre.js x.mjs`（第 2 類注入旗標）→ 該 EXEC 葉跳過、不成對。
- **pipe**（原向量 D，規則照舊）：`Pipeline` 節點且為**恰兩段** `producer | interpreter`（多段跳過）：
  - 右段（消費者）：leaf 名 ∈ INTERPRETERS、無賦值前綴、無第 2 類旗標、為 stdin 形態（無 script、無 inline）、
    且**無蓋過 pipe 的 fd0 重導向**（消費端有 `< file`/heredoc/fd-dup → 跳過）。
  - 左段（生產者）：靜態 print 生產者——`echo`/`printf` 靜態或 `cat`/`tac` 靜態 heredoc/here-string，
    以 `static_output.ts` 取其輸出字串為 source。
  - `payloadIsAllStaticPrint(source, lang)` → 成對。
  - 背景 `&`/coproc/整體 pipeline redirect → 跳過；否定 `!` 不改資料流 → 照常判。

#### 4.3.3 旗標規則（直譯器葉）

掃 `inv.argv`（靜態化）。**旗標分三類**：

1. **inline-eval 旗標**：node/bun/ts-node `-e`/`--eval`、python `-c`、`deno eval`（子指令）、`-p`/`--print`
   （吐運算式值）。取其值為 payload。
2. **會注入/改變執行的旗標**（出現即**跳過此葉**、不視為載具）：`-r`/`--require`/`--import`/`-m`/`--preload`/
   `--env-file`（node/bun/python/deno 對應者）。**只計 inline payload/script 位置參數之前的旗標**——
   inline-eval（`-e`/`-c`）值之後的 token 是程式 argv，不視為直譯器旗標（`node -e 'console.log("x")' -r p`
   的 `-r` 在 payload 之後＝argv → 不致跳過 → 仍為載具）。
3. **不影響執行的良性旗標**（**無視、繼續判定**）：其餘旗標——`--transpile-only`/`--experimental-*`/
   `--no-warnings`/deno `--allow-*`/`-A`/`--no-check`、ts-node `--esm`… 以及它們的值（如 `--allow-read=path`）。
   解析時略過這些旗標 token（保守：`--flag=value` 略 1；裸 `--flag` 略 1；不維護精確 arity 表——多略/少略只
   影響是否找到 script 位置參數，方向皆 under-deny）。

### 4.4 聚合語意 `printDisguiseDeny(script, invocations, initialCwd)`（**取代 per-leaf 短路**）

**全域跳過閘（最先檢查）**：若 `definedFunctionNames(script).size > 0` → **整個閘②′ 直接回不 deny**
（腳本定義了任何函式即視為非偵測目標）。

否則做**兩階段**判定（**非** per-leaf 短路——這是本版對舊 spec 的關鍵修正）：

**階段 1（分類，走訪完整鏈）**：先完整走訪整條指令，對**每個**葉指令記錄其**載具身分**，取值為下列之一：
{`葉載具`｜`複合成員:write-exec`（WRITE 或 EXEC 葉）｜`複合成員:pipe`（producer 或 consumer 葉）｜
`setup 白名單葉`｜`以上皆非`}，並記錄是否存在 ≥1 個 **WRITE→EXEC** 複合載具（供 (a) 的 setup 豁免；
**pipe 不觸發 setup 豁免**）。
- **葉載具**（§4.3.1）逐指令判定、與位置無關。
- **複合載具成員**（§4.3.2）由一趟 source-order AST 走訪識別：沿循序序列（`Script.commands`/`CompoundList`/
  `BraceGroup`/`&&`/`;` 的 `AndOr`）thread cwd（由 `initialCwd`；遇 `cd` 後標 unknown）、維護「緊鄰前一個
  sibling 的靜態 WRITE」`prevWrite`。
  - **WRITE→EXEC 成對**：成對後把 WRITE 葉與 EXEC 葉各自標記為 `複合成員:write-exec`。
  - **pipe 成對（回應 review medium）**：`Pipeline` 節點且 §4.3.2 pipe 條件成立時，**把 producer 與 consumer
    兩個葉都標記為 `複合成員:pipe`**。此為必要契約——consumer（裸直譯器讀 stdin、無 fd0 重導向）本身**非**葉載具，
    唯有成對後被標為複合成員才使 (a) 覆蓋通過；否則 `echo 'console.log(1)' | node` 會因 node 非載具而覆蓋失敗。
  - WRITE→EXEC 與 pipe **僅在循序序列/pipeline 節點上判**，**不跨控制流/subshell 邊界**。
- **分類的葉全集＝ `walk` 攤平的 `invocations[]`**（同一 leaf 集合，含 `$()`/控制流 clause＋各分支 body 內層）。
  分類完成前**不做任何 deny 決定**。
  - **AST 葉 ↔ `invocations[]` 對應（實作註記）**：葉載具與 setup 白名單身分**可直接逐一對 `invocations[]` 判定**
    （依 `name`/`argv`/`redirects`/`assignments`，位置無關），不需 AST。只有複合成員（WRITE→EXEC、pipe）需 AST
    識別相鄰/pipeline 結構；實作時 `printDisguiseDeny` 的 source-order 走訪應以與 `walk` **相同的葉列舉順序**
    產生葉序列（兩者皆前序、同一下降規則），即可用序列索引把「AST 走訪判定的複合成員」對位回 `invocations[]`。
    覆蓋 (a) 最終以 `invocations[]` 為權威葉集。若兩序列長度不一致（理論上不應發生）→ fail-safe 不 deny。

**階段 2（判定，走訪結束後才決定）**：**整鏈 deny ⟺ 同時滿足下列三者**：

- **(a) 覆蓋**：**`invocations[]` 中每個葉指令**身分 ∈ { `葉載具`, `複合成員:write-exec`, `複合成員:pipe` }。
  **唯一例外**：若鏈中含 ≥1 個 **WRITE→EXEC 複合載具**，則額外允許 **setup 白名單** `{mkdir, cd, true, :}` 的葉
  （**裸 print 鏈與 pipe 鏈——不含 WRITE→EXEC——不吃此豁免**）。setup 白名單葉若處於**否定（`!`）之下**不算
  setup（`! true` 排除——否定的 true 不是 setup）。
- **(b) 存在**：至少一個 print 載具存在（葉載具或複合載具）。
- **(c) 未遮蔽**：載具名未被同腳本函式定義遮蔽——已由全域跳過閘（更強：任何函式定義即整閘跳過）保證。

**控制流路徑不敏感（安全 under-deny，回應 review）**：`walk` 把 `if`/`for`/`while`/`case` 的 clause/guard
與**所有分支** body 一併攤平進 `invocations[]`；聚合覆蓋 (a) 施加於此**完整扁平集**、**不**區分互斥執行路徑。
後果：任何含 guard 或多分支的控制流包裝，只要引入一個非載具葉（如 `command -v node` guard），覆蓋 (a) 即失敗
→ **不 deny**。故 `if command -v node; then node -e '<print>'; else echo 假; fi` **不 deny**（guard 為非載具）；
`if true; then echo 假; fi` 也不 deny（clause `true` 非載具）。**控制流本身不是全域跳過**（唯一全域跳過是函式
定義）——它與其他指令一樣受整鏈覆蓋約束：含 guard/多分支引入非載具葉即 (a) 失敗（安全 under-deny）；退化的
全載具控制流（如 `for x in a b; do echo 假; done`，clause 無非載具葉、body 全載具）**仍 deny**，且與舊閘②
`isAllPrintOnly` 行為一致（無回歸）。此「有 guard/分支即不 deny」為刻意接受的 under-deny（agent 常見假驗證
不會包在 feature-detection 控制流內）。

**行為對照**（每案於 §7 有對應測試）：

| 指令 | 葉分類 | 判定 | 說明 |
|---|---|---|---|
| `echo a; echo b` | echo＋echo（葉載具）| **deny** | 純 shell 整鏈 print（舊閘② 行為不變）|
| `echo a; node -e 'console.log("b")'` | echo＋直譯器 inline | **deny** | **新增**：混載具全 print 鏈 |
| `ls; node -e 'console.log("假")'` | ls（非載具）＋inline | 不 deny | (a) 失敗；原向量 A 由 per-leaf **弱化為整鏈**，落既有 ask |
| `ls; echo 假` / `pwd; echo 假` | 非載具＋echo | 不 deny | 洗白繞道維持（(a) 失敗）|
| `true && echo 已驗證` | true（無 composite→非 setup、非載具）＋echo | 不 deny | 裸 print 鏈不吃 setup 豁免 |
| `mkdir build && echo done` | mkdir（無 composite→非 setup）＋echo | 不 deny | 同上 |
| `cat > x <<'EOF'…EOF; cat x` | WRITE＋cat 讀回（composite 兩成員）| **deny** | **新增**：兩步偽裝（原僅落寫入重導向 ask）|
| `cat > x <<'EOF'…EOF; node x` | WRITE＋直譯器 EXEC（composite）| **deny** | 原向量 C(a) |
| `mkdir -p /tmp && cat > x <<EOF…EOF && node x` | mkdir（setup✓）＋composite | **deny** | 旗艦；有 composite → setup 豁免生效 |
| `cd /tmp; cat > x <<EOF…EOF; node x` | cd（setup✓）＋composite | **deny** | 同上 |
| `false && cat > x && node x` | false（非白名單）＋composite | 不 deny | false 非 setup、非載具 → (a) 失敗（原「靜態不可達排除」被聚合語意自然涵蓋）|
| `! true && cat > x && node x` | true 被否定（明文排除 setup）＋composite | 不 deny | `! true` 明文排除 |
| `echo 假; ls` / `node -e '<print>'; ls` | 載具＋ls（非載具）| 不 deny | **兩階段**：走完全鏈才判；前綴載具不因後綴 ls 出現前就誤 deny |
| `if command -v node; then node -e '<print>'; else echo 假; fi` | guard（非載具）＋分支載具 | 不 deny | 控制流路徑不敏感：guard 非載具 → (a) 失敗 |
| `for x in a b; do echo 假; done` | 僅 echo（clause 無非載具葉）| **deny** | 退化全載具控制流；與舊閘② 一致（無回歸）|
| `echo 'console.log(1)' \| node` | producer＋consumer（皆 `複合成員:pipe`）| **deny** | pipe；成對後 node 才被覆蓋 |
| `grep x f \| node` / 三段 pipe | grep（非載具 producer）/多段 | 不 deny | producer 非靜態 print / 非恰兩段 → 不成對，node 仍非載具 |

判定在**階段 2、走訪整條指令之後**才做出（**非** per-leaf 短路）；命中時回 `{ kind }`（主要命中形態，見 §4.5），
否則回 `null`。唯一的提前退出是 **fail-safe**：分析途中拋例外 → 由 `evaluate` 既有 try/catch 收斂為 ask
（**不** deny）。此設計取代舊 spec 的「短路單調」——後者與整鏈覆蓋語意矛盾（會在看到後綴非載具葉之前就誤 deny 前綴）。

### 4.5 閘②′ 接線與 deny 理由

```ts
// 閘②′（deny）：統一 print-only 載具偽裝——classify 前短路、不可升級
const hit = printDisguiseDeny(script, invocations, initialCwd);
if (hit) {
  return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
}
```

- `printDisguiseDeny` 回 `null`（不 deny）或 `{ kind }`，`kind ∈ { "shell-print", "interp-inline",
  "write-exec", "cat-readback", "pipe" }`。**kind 決定性優先序**（同一鏈可能同時含多形態時，理由取最具體者，
  使 deny reason 測試可預期）：`write-exec` > `cat-readback` > `pipe` > `interp-inline` > `shell-print`
  （即：存在 WRITE→EXEC(a) 直譯器複合 → `write-exec`；否則存在 cat 讀回複合 → `cat-readback`；否則存在 pipe
  複合 → `pipe`；否則存在直譯器 inline/stdin 葉 → `interp-inline`；否則純 shell 葉載具 → `shell-print`）。
- `script`/`invocations`/`initialCwd` 皆 `evaluate` 既有；無新狀態穿透。
- **兩階段、走訪後才判**：`printDisguiseDeny` 先分類完整鏈、再依 §4.4 (a)(b)(c) 決定，**不**在走訪途中提前回
  deny；`if (hit)` 之 `hit` 為走訪結束後的最終判定。既有 try/catch 僅在「分析途中拋例外」時退化為 ask（不 deny）。
- `printDisguiseDenyReason(kind)`（置於 `rules/types.ts`，取代舊 `printOnlyDenyReason`）：共用「**被禁的事＋
  原因＋替代**」骨架，依 kind 客製措辭：
  - `shell-print`：「整條指令每段都只是 echo/printf/cat 印死字串…」
  - `interp-inline`：「你正用 `-e`/`-c`/`-p` 跑一段每行都只是 `console.log`/`print` 印死字串的程式…」
  - `write-exec`：「你先把寫死文字寫進暫存檔、再用直譯器執行同檔把它印出來…」
  - `cat-readback`：「你先把寫死文字寫進暫存檔、再 `cat` 讀回印出——與直接 echo 無異…」
  - `pipe`：「你把寫死文字 pipe 給直譯器印出來…」
  - 共同結尾：「內容完全寫死、沒讀檔沒計算——偽裝成跑出來的驗證結果。若已有結論請直接寫在回覆；若需查證請
    實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。」

## 5. 邊界（皆已記錄、安全方向 under-deny；不防刻意繞過）

- **跨 Bash 呼叫拆分**（呼叫1寫檔、呼叫2執行）：per-call 無狀態 → 不偵測。**shipped guarantee 僅及單一呼叫
  鏈內**。本工具**所有** deny 閘（sleep、遞迴根、print-only）**共有的根本邊界**，且為**任務鎖定不變量**
  （§2.2）：每次 hook 呼叫都是「first-run／無先前狀態」，**刻意不引入持久 taint／歷史**。
  - **hook 從不自主放行跨呼叫偽裝**：呼叫2 `node /tmp/x.mjs`（裸 script 執行、當次呼叫無配對 WRITE）之
    **預設判定為 ask**——`node`/`python` **不在 allowlist**（已查證 `rules/allowlist.ts` 無 `nodeRule`），classify
    default-deny → ask。唯有使用者**明確**設 `Bash(node *)` 時才升級為 allow；而 `Bash(node *)` 語意即
    「授權 node 執行任何腳本」，是使用者**自負且與 print 偽裝正交**的 settings 決策，本 hook 忠實沿用
    （即既有 `(hook=ask, settings=allow) → allow` 設計）。**本功能不新增任何自主 allow 路徑**。
  - **為何不封此路（三修法皆違反鎖定不變量，故明確非目標）**：(1) 跨呼叫持久 taint → 直接違反鎖定的
    per-call 無狀態、且引入狀態管理與 race；(2) 讀取 `/tmp/x.mjs` 檔案內容再判 → 違反本工具「**純詞法、
    永不碰檔案系統**」不變量（`scope.ts` 全程不 stat/不讀檔），且有 TOCTOU（hook 後、執行前檔案可被換掉）、
    並會誤 deny 合法的全 print 檔；(3) 對「近期寫過的檔」抑制 `Bash(node *)` 升級 → 仍需跨呼叫狀態，同 (1)。
  - **安全方向**：無 `Bash(node *)` 時呼叫2 恆 ask（人工把關）；此邊界與工具其餘 deny 一致，非本功能獨有，
    亦非新引入之退化。
- **定義函式 → 整個閘②′ 跳過**：腳本含 `f(){…}` 即不偵測（非目標常見形態）。這是本版**唯一的 accepted
  regression**（弱化一條已上線的 shell 硬 deny，如 `f(){:;}; echo 假`）——完整回歸事實與接受理由見 §1.2，
  文件同步見 §6、§8。方向安全：只把 deny 降為 ask，絕不新增 allow。
- **控制流路徑不敏感**：`if`/`for`/`while`/`case` 的 clause/guard 與各分支經 `walk` 攤平進同一 `invocations[]`、
  覆蓋 (a) 施加於完整扁平集；含 guard 或多分支者通常引入非載具葉 → (a) 失敗 → 不 deny（§4.4）。
- **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`…）：葉名非載具 → 該葉非載具 →（若鏈中尚有非載具葉）
  聚合 (a) 失敗 → 落 ask。
- **賦值前綴**（`X=1 node …`、`PATH=…`）：跳過此葉、不視為載具。
- **會注入碼的旗標**（`-r`/`--require`/`--import`/`-m`/`--preload`）：跳過此葉。
- **不影響執行的良性旗標**（`--transpile-only`/`--allow-*`/`--experimental-*`…）：**無視、仍判定**（§4.3.3）。
- **繼承式 stdin**（bare `node` 無 fd0 重導向）：hook 看不到 payload → 非載具。
- **動態 token**、**非緊鄰寫→執行**、**多段 pipeline**、`>>` append、背景寫入 → 不成對/非載具。
- 上述「不 deny」多落既有 ask、**可被** `settingsAllows`（`Bash(node *)` 等）升級——屬使用者自負的既有
  settings 行為；本功能不新增此路徑、亦不硬擋。被閘②′命中者**不可**升級。

**誤 deny 面（近零、單一具名例外）**：§4.1 述詞 fail-safe（任何運算/變數/呼叫/模板/import/未閉合 → 不 deny）；
§4.4 聚合語意**兩階段、走訪完整鏈後才判**且要求**每個葉皆載具/成員**（任一非載具、非 setup 葉即令覆蓋 (a)
失敗 → 不 deny，故前綴載具不會在看到後綴非載具葉前誤 deny）；任何非目標結構 → 不偵測。故所有「真實工作」
payload 與含非單純結構的指令一律不被 deny，最差退回既有 ask。**唯一刻意例外**＝**cat 讀回複合載具**（§4.3.2(b)）：
它會 deny 詞法上等同「同呼叫內建靜態檔＋立即讀回同檔」的合法操作；此為使用者定案接受的 narrow exception，
blast radius 限於冗餘讀回半段（檔案建立本身可另起呼叫核准，見 §4.3.2(b)）。除此之外，本工具維持嚴格「絕不誤 deny」。

## 6. CLAUDE.md / 文件同步

- **「這是什麼」「核心不變量」**：deny **維持三類**，把「② 整鏈 print-only 偽裝」的定義由「shell 層
  echo/printf/heredoc」**擴充為跨載具**（涵蓋直譯器 inline/heredoc/pipe/寫檔→執行、及 cat 讀回兩步偽裝）。
  **不要**改成「四類」。
- **架構管線圖**：閘② 描述更新為「統一 print-only 載具閘②′」，模組列出 `static_output.ts`／`interp_payload.ts`／
  改造後 `print_only.ts`（載具框架＋`printDisguiseDeny` 入口）。
- **「已接受繞道」**：
  - node/python/deno/bun/ts-node 的**裸 all-static-print 形態**（inline/heredoc/pipe/寫檔→執行）改**硬 deny**；
    含函式/wrapper/賦值前綴/注入旗標/跨呼叫者維持 ask（明列為刻意 under-deny）。`bash -c`/`perl -e` 等仍 ask。
  - **兩步偽裝**（`cat > x <<EOF…EOF; cat x`）由「寫入重導向 ask」改**硬 deny**（cat 讀回複合載具）。
    須註記此為**唯一刻意接受的誤-deny narrow exception**：詞法上與合法「建檔＋讀回」不可分，deny 限於同呼叫內
    冗餘讀回半段、檔案建立本身仍可另起呼叫核准（§4.3.2(b)）；並明載 (b) 無 (a) 的 payload 述詞鑑別器。
  - **混載具全 print 鏈**（`echo a; node -e print`）改**硬 deny**。
  - **`ls; echo 假` / `pwd; echo fake` / `ls; node -e '<print>'` 這類「整鏈含真實/非載具葉」的洗白繞道維持
    不 deny**（聚合 (a) 失敗，落既有 allow/ask 判定；其中 `node -e` 部分本就 ask）——這是**整鏈語意的核心取捨、
    使用者定案**：寧可讓「加一個無關真實/no-op 葉」洗白（降為 ask、甚至可被 `Bash(node *)` 升級），也**不**採
    per-leaf 硬 deny（那會誤殺合法的 `ls; echo "done"` 狀態訊息、違反「絕不誤 deny」）。**回應 review medium
    downgrade 顧慮**：(1) 此非本功能新引入——shell 洗白繞道早為 CLAUDE.md「已接受繞道」記錄；本版僅把同一整鏈
    語意延伸到直譯器載具。(2) reviewer 建議「硬 deny 無關 pwd/ls/true 前後綴」需要「哪個葉是實質工作」的詞法
    不可判定分析，且會製造誤 deny，與整鏈設計與「絕不誤 deny」直接衝突，故不採。(3) 方向安全：洗白只把 deny
    降為既有 ask（人工把關）或使用者自負的 settings 升級，**不**新增自主 allow。此類**非**「預設 ask + 升級」
    那一類、而是「落既有判定」。
  - **函式定義 → 閘②′ 全域跳過**列為**刻意放寬／accepted regression**：明載其弱化了一條已上線的 shell 硬 deny
    （`f(){:;}; echo 假` 由 deny 改 ask），並附接受理由（威脅模型只擋 agent 常見形態、函式使 name 分析不可信、
    方向安全只降為 ask）。**不得**以「行為不變」帶過。

## 7. 測試與「誤 deny」稽核

### 7.1 純 shell 鏈回歸（`print_only_test.ts` 既有案例全數保留，除一處）
- **保留不變**：`echo a; echo b`、`printf '…'`、`cat <<'EOF'…EOF`、洗白鏈（`ls; echo 假`、`pwd; echo 假`、
  `true && echo x`、`mkdir build && echo done`）、echo `-e`＋反斜線 carve-out、printf 格式化轉換符 carve-out、
  cat 檔案操作元/fd0 最後者勝等。
- **唯一變更（accepted regression，§1.2）**：`f(){ :; }; echo 假` → **改斷言不 deny**（函式定義全域跳過閘②′；
  落 classify ask，因 echo ∉ fnNames 故非閘③）。此案在舊閘② 為硬 deny；測試需明確註記「此為 §1.2 記錄之刻意
  回歸、由 deny 改 ask」，避免日後被當成 bug 修回。

### 7.2 述詞（`interp_payload_test.ts`，deny 與不-deny 兩面 + 邊界）
- deny：多行 `console.log("…")`/`print("…")`、註解＋print、三引號/無 `${}` 模板、數字字面量、多字面量逗號、
  `console.error`/`process.stdout.write` 變體。
- 不-deny：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted`、`json.dumps`、變數、`${}` 模板、
  f-string、`import`/`if`/`for`、未閉合括號/引號、空 payload、`console.log()`、`print("x",end="")`、資源上限超標。
- write API STRING-only：`process.stdout.write("fake")` deny；`process.stdout.write(42)`/`sys.stdout.write(1)` 不 deny。
- `printExprIsStaticString`：`'"fake"'` true；`'1+1'`/`'os.cpus()'` false。

### 7.3 靜態輸出還原（`static_output_test.ts`）
- `echoOutput`/`printfOutput`/`commandOutput` 對合格 → 具體字串、不合格 → `null`（格式化轉換符、動態、append、
  有檔案操作元等）。
- **tac 行反轉**：`commandOutput` 對 `tac <<'EOF'\nA\nB\nEOF` → `"B\nA"`（反序）；對 `cat` 同 body → `"A\nB"`（原序）。
  驗證反轉真的被套用（餵給 payload 述詞的內容正確）。

### 7.4 載具/聚合整合測試（`print_only_test.ts` 新增段）
- **葉載具 inline（A）**：裸 `node -e '<print>'`/`python -c '<print>'`/`deno eval '<print>'`/`bun -e`/`ts-node -e`、
  `node -p '"fake"'` → deny；含運算 `node -e '1+1…'`、`node -p '1+1'`/`os.cpus()` → 不 deny。
- **葉載具 heredoc-stdin（B）**：裸 `node <<'EOF'<print>EOF`/`python <<'EOF'`/`deno run -`/`bun run -` → deny；
  `< file`/無 fd0（繼承）→ 不 deny。
- **複合 WRITE→EXEC(a) 直譯器**：**旗艦** `cat > /tmp/x.mjs <<'EOF'<print>EOF; node /tmp/x.mjs` → deny；
  `&&` 緊鄰 → deny；`echo '<print>' > f; node f` → deny；寫專案內同理。
  - **進入點比對負面（回應 review high finding，須斷言不 deny）**：`echo 'console.log("fixture")' > fixture.js; node runner.js fixture.js`、
    `printf '…' > fixture.py; python runner.py fixture.py`、`echo '<print>' > f.ts; deno run runner.ts f.ts`
    → **不 deny**（P＝被寫檔，但直譯器進入點是 runner.*，P 只是程式 argv、非進入點）。對照 `node /tmp/x.mjs`
    （P＝進入點）→ deny。
- **複合 WRITE→EXEC(b) cat 讀回（新增）**：`cat > /tmp/q.txt <<'EOF'<任意靜態文字>EOF; cat /tmp/q.txt` → deny；
  `printf '…' > q; tac q` → deny。**不 deny 面**：非緊鄰（`cat > q; echo hi; cat q`）、非同檔（`cat > a; cat b`）、
  append（`cat >> q <<EOF…EOF; cat q`）、跨控制流（`if c; then cat > q; fi; cat q`）。
  - **accepted 誤-deny exception（§4.3.2(b)，須明確斷言 deny 並註記為刻意例外）**：合法建檔＋讀回
    `cat > config.yaml <<'EOF'\n<yaml>\nEOF; cat config.yaml` → **deny**（詞法上與偽裝不可分；此為使用者定案接受）。
    **對照緩解可用**：單獨 `cat > config.yaml <<'EOF'\n<yaml>\nEOF`（無讀回）→ **非閘②′ deny**（落寫入重導向 ask，
    可核准），驗證檔案建立本身未被永久阻擋。
- **setup 豁免三案例**：旗艦 `mkdir -p /tmp && cat > x <<EOF…EOF && node x` → **deny**；`cd /tmp; cat > x; node x`
  → **deny**；對照 `mkdir build && echo done` → **不 deny**（無 composite → 不吃豁免）、`true && echo 已驗證`
  → **不 deny**。
- **`! true` 排除**：`! true && cat > x <<EOF…EOF && node x` → **不 deny**（否定的 true 非 setup）；
  對照 `false && cat > x && node x` → **不 deny**（false 非白名單）。
- **混載具全 print 鏈（新增 deny）**：`echo a; node -e 'console.log("b")'` → **deny**；
  對照 `ls; node -e 'console.log("假")'` → **不 deny**（ls 非載具，(a) 失敗）。
- **兩階段前綴 false-deny（回應 review Finding 1）**：`echo 假; ls`、`node -e 'console.log("x")'; ls`、
  `echo a; echo b; ls` → **不 deny**（前綴為載具但後綴 ls 非載具；驗證判定在走訪整鏈後才做、不在看到前綴載具時
  誤 deny）。對照 `echo a; echo b` → deny（全載具）。
- **控制流路徑不敏感（回應 review Finding 3）**：`if command -v node; then node -e 'console.log("fake")'; else echo 假; fi`
  → **不 deny**（guard `command -v node` 非載具，(a) 失敗）；`if true; then echo 假; fi` → **不 deny**（clause `true` 非載具）；
  對照 `for x in a b; do echo 假; done` → **deny**（clause 無非載具葉、body 全載具，與舊閘② 一致）。
- **pipe（D）**：`echo 'console.log(1)' | node` → deny；`grep x f | node`/多段 → 不 deny；`echo … | node < real.js`
  （fd0 蓋過）→ 不 deny。
  - **pipe 覆蓋契約（回應 review medium）**：明確斷言**同一個裸 `node`** 在 pipe 外非載具、pipe 內成對後被覆蓋——
    `echo 'console.log(1)' | node` → deny（node 經 pipe 成對標為 `複合成員:pipe`）；對照 `node`（裸、無 stdin
    重導向、非 pipe）落 ask（consumer 未成對 → 非載具）。驗證覆蓋依賴 pipe 成對狀態、而非 node 自身為載具。
- **良性旗標仍 deny**：`ts-node --transpile-only x.ts`（x.ts 為前驅 all-print WRITE）、
  `node --experimental-default-type=module x.mjs`、`deno run --allow-read x.ts`、
  `node --no-warnings -e 'console.log("fake")'` → **deny**（旗標無視、仍判定）。

### 7.5 跳過/無視（皆**不 deny**）
- 定義函式：`f(){ :; }; node -e 'console.log("fake")'`、`node(){:;}; node -e '…'` → 不 deny（全域跳過閘）。
- exec-wrapper：`timeout 5 node -e '…'`、`command node -e '…'`、`env node -e '…'`、`xargs node -e '…'` → 不 deny。
- 賦值前綴：`X=1 node -e '…'`、`PATH=/x node -e '…'` → 不 deny。
- 注入旗標：`node -r ./pre.js -e '…'`、`python -m pytest t.py`、`node --require setup.js real-test.js` → 不 deny。
- 順序/緊鄰（不 deny）：`node x; cat > x <<EOF…EOF`（執行在寫前）、`cat > x; echo hi; node x`（WRITE 與 EXEC
  間有非-WRITE 指令）、`cat > x; cd other; node x`（cd 介於兩者）、`cat > x > sink <<EOF…EOF; node x`（有效
  fd1=sink、x 截空）、`if cond; then cat > x; fi; node x`（跨控制流邊界）→ 不 deny。

### 7.6 不可升級 e2e（`main_test.ts`）
- settings 含 `Bash(node *)`/`Bash(python *)`/`Bash(echo *)`：載具 A/B/C(a)/C(b)/D 命中（**單一呼叫內**）仍
  **deny**；對照 `node -e 'JSON.stringify(x)'` → allow（真實運算可升級）。
- **跨呼叫拆分 / migration 邊界 e2e（回應 review §5）**——驗證 hook **從不自主放行**跨呼叫偽裝：
  - split create/execute：呼叫1 `cat > /tmp/x.mjs <<EOF…EOF`（全 print WRITE）→ **ask**；呼叫2 `node /tmp/x.mjs`
    **無** `Bash(node *)`（first-run、無先前狀態）→ **ask**（node 不在 allowlist，default-deny）。
  - retry-after-ask：呼叫2 重試仍 → **ask**（無持久 taint 不代表變 allow；預設仍 ask）。
  - 使用者自負升級：呼叫2 `node /tmp/x.mjs`＋`Bash(node *)` → allow（使用者明確授權 node 執行任何腳本；
    已記錄之單呼叫邊界，非 hook 漏洞）。對照：**同一 payload 於單一呼叫內** `cat > /tmp/x.mjs <<EOF…EOF; node /tmp/x.mjs`
    ＋`Bash(node *)` → 仍 **deny**（不可升級），凸顯 deny 保證邊界正落在「單一呼叫」。

### 7.7 Operational verification（build 後）
- 餵兩步偽裝 JSON（`cat > /tmp/research_query.txt << 'EOF'\n<多行靜態文字>\nEOF\ncat /tmp/research_query.txt`）
  → 期望 **deny**、`exit 0`、reason 為 `cat-readback` 客製理由。
- 餵直譯器痛點 JSON（`cat > /tmp/verify.mjs <<'EOF'…全 console.log 字面量…EOF` 接 `node /tmp/verify.mjs`）→
  期望 **deny**、reason 為 `write-exec`。
- 餵真實運算版 `node -e 'console.log(1+1)'` → 期望**非 deny**。

### 7.8 全綠
`deno task check && deno task lint && deno task test`。

## 8. 風險與邊界

- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但 fail-safe，誤判方向恆為「不 deny」。
- **效能**：閘②′ 對每次 Bash 呼叫多一趟 source-order AST 走訪＋（命中時）極小詞法；payload 短，O(指令長度)。
- **跨呼叫拆分 × `settingsAllows` 是最鋒利的殘留邊界（意識接受，回應 review）**：把 WRITE 與 EXEC 拆到兩次
  hook 呼叫時，deny 保證消失；若使用者另設 `Bash(node *)`，呼叫2 執行該檔會被升級為 allow。此非本功能引入的
  漏洞，而是**兩條鎖定不變量的交集結果**：(1) per-call 無狀態（全工具所有 deny 共有、任務鎖定）；(2) 本 hook
  純詞法、永不讀檔內容。封閉此路需持久 taint 或讀檔（均違反上述不變量、見 §5），故**明確不做**。緩解僅靠：
  hook 自主預設 ask（不主動 allow）、單一呼叫內硬 deny 不可升級、以及使用者對 `Bash(node *)` 廣域授權的自負。
- **刻意接受的 under-deny**（§5）：跨呼叫拆分、定義函式、控制流包裝（路徑不敏感）、exec-wrapper、賦值前綴、
  注入旗標、非緊鄰寫→執行、繼承 stdin、多段 pipe。皆安全方向、不防刻意繞過，符合「只擋 agent 常見 print-only
  假驗證」的威脅模型。
- **唯一 accepted over-deny（誤-deny）＝cat 讀回複合載具**（§4.3.2(b)）：deny 詞法上等同合法「建靜態檔＋讀回同檔」；
  使用者定案接受（rationale：同呼叫內讀回剛寫死的內容＝浪費 token 假工作），blast radius 限於冗餘讀回半段
  （檔案建立可另起呼叫核准）。這是本工具對嚴格「絕不誤 deny」開的**唯一**例外。
- **相對舊閘② 的唯一放寬＝唯一 accepted regression**：函式定義全域跳過（§1.2 附完整回歸事實與接受理由、
  §6/§7.1 文件與測試同步）。此為使用者定案；除此之外本版**只擴充 deny、不放寬**（控制流與前綴等其餘 under-deny
  皆與舊閘② 行為一致、非回歸）。
