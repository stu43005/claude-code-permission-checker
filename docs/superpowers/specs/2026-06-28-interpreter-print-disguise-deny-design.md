# 設計規格：對「直譯器執行靜態-print payload 偽裝驗證」回 `deny`

- 日期：2026-06-28
- 狀態：設計（待實作）

## 1. 背景與問題

本工具是 Claude Code 的 `PreToolUse`（matcher `Bash`）hook：解析 Bash 指令，只在「純唯讀且全部落在
當前專案內」時回 `allow`，其餘回 `ask`，並對三類情形回**硬 `deny`**（不可由 `permissions.allow`
解除）：① 遞迴遍歷磁碟根/家目錄根的唯讀指令；② 整鏈 print-only 偽裝（echo/printf/cat-heredoc 靜態
吐字）；③ sleep 輪詢等待（見 2026-06-21 規格）。其中 ②③ 在 `evaluate` 層、`classify` 之前短路；
① 在 `classify` 內以 `isDangerousRoot` 判定並對 `deny` 短路（per-leaf）。三者皆**不**經 `settingsAllows`
升級層、不可由 `permissions.allow` 解除。

### 1.1 痛點

本工具既有的「整鏈 print-only 偽裝」硬 deny（閘②）只攔截 **shell 層**的 echo/printf/cat-heredoc 靜態
吐字。但 agent 可改用**直譯器**達成同一偽裝——寫一段「整段只有 print 印死字串」的程式交給 node/python
執行，把事先寫死的結論用程式口吻吐到 stdout、偽裝成「跑出來的驗證結果」，而閘②看不到：

```bash
cat > /tmp/verify.mjs << 'EOF'
console.log("=== <某主題> 行為驗證 ===");
console.log("1. <步驟說明>：…（全部事先寫死的結論）");
console.log("結論：<寫死的是/否判斷>");
EOF
node /tmp/verify.mjs
```

這段腳本**整段只有 `console.log` 印死字串**——沒讀任何檔、沒跑任何真實計算或查證，內容完全由 agent
事先寫死，等同把推論用 `node` 轉述、偽裝成「程式跑出來的驗證」。常見變形還包括：把同樣的寫死內容塞進
註解、只在最後 `console.log("done")`；或改用 `-e`/`-c` inline、heredoc/pipe 餵 stdin。差別只在把吐字
載具從 shell 換成 JS/Python 直譯器。

### 1.2 目標案例現況（已實機驗證，信心度：高）

以 `evaluate()` 餵入下列指令（cwd 在專案根內）實測：

| 指令形態 | 現況 verdict | 現況原因 |
|---|---|---|
| `cat > /tmp/x.mjs <<'EOF' … EOF`＋`node /tmp/x.mjs`（目標案例） | `ask` | `cat：寫入型重導向`（中央前置、不可升級） |
| `cat > ./x.mjs <<'EOF' … EOF`＋`node ./x.mjs`（寫專案內） | `ask` | 同上 |
| `node -e 'console.log("x")'` | `ask` | 未列入 allowlist（**可被** `Bash(node *)` 升級為 allow） |
| `node <<'EOF' … EOF`（heredoc 餵 stdin） | `ask` | 同上 |
| `python -c 'print("x")'` | `ask` | 同上（可被 `Bash(python *)` 升級） |

**關鍵**：目標案例（單一 Bash 呼叫的整條 chain）目前已是**不可升級的 `ask`**（因 `cat >` 的寫入
重導向是不可升級中央前置 ask），故**不會誤放行**。但 inline `-e`/`-c`、heredoc-stdin、pipe-stdin 等
直接交付向量目前是**可升級的 ask**——使用者若設 `Bash(node *)`/`Bash(python *)` 即升級為 allow。
且所有這些形態目前都**得不到硬 deny 的教育性回饋**（不像裸 echo 鏈會被閘②擋下並告知 agent）。

### 1.3 使用者要求與逐項確認的設計約束

使用者要求：把「直譯器執行**全靜態-print** payload」這類偽裝**升級為硬 `deny`**（不可由
`permissions.allow` 解除），並把禁止原因回饋給 agent。經逐項確認：

1. **目標 verdict＝硬 deny**：與既有三類 deny 同級，`evaluate` 層短路、不經 `settingsAllows`。
2. **涵蓋範圍＝最廣（四向量）**：(A) inline 旗標 `-e`/`-c`/`deno eval`；(B) heredoc 餵 stdin；
   (C) 同鏈內「靜態寫腳本檔 → 用直譯器執行同檔」；(D) pipe 餵 stdin（`靜態生產者 | 直譯器`）。
3. **直譯器集合**：`node`、`nodejs`、`python`、`python3`、`deno`、`bun`、`ts-node`。**已知良性** execution-shaping
   旗標（`--transpile-only`/`--experimental-*`/`--allow-*` 等，在 §4.2.1 的無值旗標集合內）**不影響**「會執行
   該腳本」的判定——帶這些旗標的 script 執行仍 deny（使用者 round-17 決定）。**未知旗標**因 arity 不可知 →
   保守當帶值、可能吃掉 entrypoint → **under-deny（安全方向，非 flag-agnostic 保證）**；副作用/預載旗標則使
   inline/stdin payload 失純（§4.2.1）。
4. **carve-out＝極保守**：只有「**每一條有效敘述都是 `printfn(純字串/數字字面量)`**」才 deny；任何運算子
   /變數/函式呼叫/模板表示式/import/控制流/賦值 → **不 deny**（退回既有 ask）。寧可漏 deny（安全），
   絕不誤 deny。
5. **政策反轉（明確納入）**：本工具既有政策「巢狀直譯器＝預設 ask、可升級」對 **node/python/deno/bun/
   ts-node 這五者的全靜態-print 子集**改為硬 deny；其真實運算 payload 仍維持可升級 ask。**`bash -c`/
   `sh -c`/`eval`/`perl -e`/`source` 不在範圍**（維持既有可升級 ask）。

### 1.4 已查證事實

#### 1.4.1 直譯器旗標（research 實測）

版本：node v24.14.1、python 3.14.6、deno 2.9.0、bun 1.3.8、ts-node（官方文件）。

| 直譯器 | lang | inline eval | stdin 讀碼 | script 檔 |
|---|---|---|---|---|
| node / nodejs | js | `-e`/`--eval[=]<code>` | `-` 或無檔案位置參數 | 第一個非旗標位置參數 |
| python / python3 | py | `-c <code>`（其後選項終止） | `-` 或無參數 | 第一個非旗標位置參數 |
| deno | js | 子指令 **`deno eval <code>`**（非 `-e`） | `deno run -` | `deno run <file>` |
| bun | js | `-e`/`--eval[=]<code>` | `bun run -` | `bun <file>` / `bun run <file>` |
| ts-node | js | `-e`/`--eval <code>` | 管道（無旗標；未實機確認） | 第一個非旗標位置參數 |

- 兩個**正交**的旗標分類（避免混淆，回應 round 19 structural）：
  - **(A) arity（供 entrypoint 解析）**：「無值旗標」略過 1 token、其餘略過 2（§4.2.1）。
  - **(B) 預載/注入碼旗標（供 inline/stdin payload 純度）**：出現即破壞「純 print」→ inline/stdin 回 `Unknown`。
- **(B) 預載/注入碼旗標清單**：node `-r`/`--require`/`--import`/`--env-file`；python **`-m`**（執行模組碼）；
  deno `--preload`/`--require`/`--allow-*`/`-A`；bun `-r`/`--preload`/`--require`/`--import`。
  （python `-i` **不在 (B)**——它只在執行後進 REPL、**不注入額外碼**；分類為 **(A) 的無值良性旗標**，
  見 §4.2.1。此一致性修正 round 19 的 `-i` 雙重分類。）
- **value-flags**（資訊性；列出各直譯器帶值旗標）：**本設計刻意不維護精確 arity 表**——§4.2.1 對 script
  執行採**保守 entrypoint 解析**（§4.2.1：已知無值旗標略過 1 token、其餘一律當帶值略過 2 token；
  arity 誤判只會吃掉 entrypoint → under-deny，**絕不**把旗標值升格成 entrypoint），故只需一個小「無值旗標」
  集合、不需精確帶值表；inline 的 code 直接取 `-e`/`-c` 值。此表僅供理解 CLI、不進入辨識邏輯。
- `-p`/`--print` 的 payload 是**運算式**（非 `printfn(...)` 敘述），保守述詞天生不命中 → 不 deny
  （可接受的漏 deny）。本設計**不**特別處理 `-p`。

#### 1.4.2 unbash 4.0.1 解析行為（沿用 2026-06-21 規格，信心度：高）

1. 閘④ **唯一資料來源＝單一 source-order（前序）AST 走訪**（§4.2），**不**讀攤平 `invocations`（攤平後
   不保留執行順序、函式定義位置、管段相鄰，無法做 order-aware 遮蔽與向量 C/D）。走訪以 §4.2.2 的
   `leafOf` 對每個 `Command` 節點純讀化約，**鏡射 `walk` 的取值規則**：`name=staticValue(cmd.name)`、
   `argv=cmd.suffix`、`assignments=cmd.prefix`、`redirects`＝**規範順序 `[...inherited, ...statement.redirects,
   ...cmd.redirects]`**（`inherited`＝走訪下降時由外層 `CompoundList`/`BraceGroup`/`Statement` 累積者，與 walk
   對複合結構繼承 redirect 一致；fd0「最後者勝」依此序，見 §4.2.2）、
   `cwd`＝由 `initialCwd` 沿循序序列以 walk 相同 `cd` 規則 thread 的快照。**不改** `walk.ts`／
   `CommandInvocation`。（既有閘①②③ 仍各自用攤平 `invocations`，與閘④ 獨立。）
2. heredoc：引號分隔符（`<<'EOF'`）→ `heredocQuoted === true`、body 為 `undefined`、$ 不展開（靜態）；
   未引號且含展開 → `body` 為結構化 Word；純文字 → body `undefined`、文字在 `content`。靜態性判定沿用
   `print_only.ts` 既有的 `isHeredocPrintEligible`（引號分隔符，或 body/content 無 `$`/反引號）。
3. **Pipeline 結構**：unbash AST 有 `Pipeline` 節點（`Pipeline.commands: Statement[]`）。walk 攤平時
   各段以同 cwd 列舉、**不保留管段相鄰關係**；故 **vector D（pipe）由 §4.2 的 source-order AST 走訪** 直接讀
   循序序列上的 `Pipeline.commands` 取得「生產者 → 直譯器」相鄰結構（見 §4.6）。
4. `staticValue(word)` 對含任何展開/未引號 glob 的 word 回 `null`（動態）。payload 來源字串取不到靜態
   值即視為不可判定 → 不 deny。

#### 1.4.3 Claude Code hook 語意（沿用既有，信心度：高）

`permissionDecision: "deny"` 阻止工具呼叫並把 `permissionDecisionReason` 回饋給 agent，優先序
`deny > ask > allow`。deny 理由須含三要素：① 被禁止的事、② 為何禁止、③ 可行替代。

## 2. 目標與非目標

### 2.1 目標

- 在 `evaluate` 既有閘②（整鏈 print-only）之後新增**閘④（deny）**：偵測「直譯器執行全靜態-print
  payload」四向量，命中即整鏈 deny，`classify` 前短路、不可由 `permissions.allow` 升級。
- 新增 `src/engine/interp_print.ts`：
  - 純函式 `payloadIsAllStaticPrint(source: string, lang: "js" | "py"): boolean`——手寫極小、
    **fail-safe** 的 tokenizer + 窄文法比對（§4.1）。
  - 四向量的偵測入口 `interpreterPrintSprayDeny(script, initialCwd): boolean`——**單一 source-order 前序
    AST 走訪**（§4.2）為唯一資料來源（不另吃攤平 `invocations`；cwd 由 `initialCwd` 沿循序序列 thread）。
- 新增 deny 理由 helper `interpreterPrintDenyReason()`（`src/rules/types.ts`，§4.8）。
- 同步更新 CLAUDE.md：deny「三類/三閘」→「四類/四閘」、政策反轉段落、架構管線圖（§6）。
- 全程 fail-safe：任何不確定一律不 deny（退回 ask）；`evaluate` 既有 try/catch 把例外收斂成 ask；
  永遠 `exit 0`。

### 2.2 非目標（YAGNI，刻意排除）

- **不**做跨 Bash 呼叫的關聯、**不引入任何持久 taint/狀態**：hook per-call 無狀態，「呼叫 1 寫檔、
  呼叫 2 執行」無法偵測（§5.1 item 1，本工具所有 deny 共有的根本邊界）。**硬 deny 的 shipped guarantee
  僅及單一 Bash 呼叫鏈內**的寫檔→執行（向量 C）。
- **不**完整解析 JS/Python 語法（不引入 acorn 等依賴；Python 側 Deno 無好 parser）。只用窄詞法器辨識
  「純 print 字面量序列」這一種形狀，其餘全部放手。
- **不**處理 `-p`/`--print` 運算式吐值（payload 非 printfn 敘述、述詞天生不命中）。
- **不**涵蓋 `bash -c`/`sh -c`/`eval`/`perl -e`/`ruby -e`/`php -r`/`source`（維持既有可升級 ask）。
- **不**改 echo/printf/cat 既有 print-only 閘②語意、**不**改寫入重導向/賦值前綴/中央前置任何既有判定。
  本功能**只收緊（新增 deny）**，不放寬任何既有判定。
- **不**改 `walk.ts` 攤平職責。閘④ 為**單一 source-order 前序 AST 走訪**（唯一資料來源、不讀攤平
  `invocations`）：向量 A/B 對任何位置的直譯器節點生效、向量 C/D 在循序序列上判相鄰，皆於同一走訪內。
  **不**改 `CommandInvocation` 結構。
- **不**引入快取、**不**讀 enterprise managed-settings。

## 3. 架構與資料流

新增邏輯只掛在 `evaluate`：walk 之後、既有閘①②③ 之間插入閘④。`classify`/`combine`/`parse`/`walk`/
`scope`/各 `rules` 皆不改。

```
main.ts → evaluate(command, root, initialCwd, rules, home, trustedReadRoots)
  └─ parse → script；walk(script) → invocations[]
       ├─ invocations.length === 0 → allow（no-op，不變）
       ├─ 閘①(deny)：some(name === "sleep") → deny(pollingDenyReason())            （不變）
       ├─ 閘②(deny)：isAllPrintOnly(invocations) → deny(printOnlyDenyReason())      （不變）
       ├─ 閘④(deny)：interpreterPrintSprayDeny(script, initialCwd)                   （★新增；source-order 走訪、order-aware 遮蔽）
       │             → deny(interpreterPrintDenyReason())
       ├─ 閘③(ask) ：函式遮蔽（whole-script fnNames）→ ask(functionShadowReason())   （不變）
       └─ combine(invocations.map(classify))                                        （不變）
                     └─ classify 內：遞迴遍歷磁碟根/家目錄根 deny（既有、per-leaf，於 classify 短路）
```

- **遞迴根 deny 的位置**：它**不是** evaluate 層的閘，而是各遞迴指令規則在 `classify` 內以
  `isDangerousRoot` 判定、由 `classify` 對 `deny` 短路（既有行為，本功能不動）；故未列於上方 evaluate
  閘序列，而在 `combine→classify` 步驟內。它與閘①②④ 同為硬 deny，彼此順序無關（`deny > ask > allow`）。
- 閘④ 列於閘②之後、閘③之前：閘④ 置於閘③（ask）之前，確保命中時硬 deny 不被函式遮蔽 ask 降級
  （與閘①②同理）。
- **閘編號說明**（沿用 2026-06-21 規格的歷史編號、非執行序）：①sleep-deny、②print-only-deny、
  ③函式遮蔽-ask 為既有 evaluate 層閘；④（本功能）為新增 evaluate 層 deny 閘。**執行序**為
  ①→②→④→③→`combine/classify`。遞迴根 deny 不在此編號內（classify-level，見上）。
- 閘④ 在 `classify` 之前返回 → 天生硬性、不經中央前置規則、不經 `settingsAllows`。`Bash(node *)`/
  `Bash(python *)` 等**無法**解除。

## 4. 詳細設計

### 4.1 `payloadIsAllStaticPrint(source, lang)`（`src/engine/interp_print.ts`，新檔）

純函式。`lang`：python/python3 → `"py"`；node/nodejs/deno/bun/ts-node → `"js"`。回 `true`（→ 該向量
命中、整鏈 deny）**僅當**下列全部成立，否則一律 `false`：

**步驟 0：資源上限（per-payload，無全域 fail-open；回應 round 3 + round 7 finding 2）**
- `source` 位元組數 > `MAX_PAYLOAD_BYTES`（建議 **64 KiB**）→ **此 payload** 立即 `false`（不 tokenize），
  但**繼續掃描其他候選 payload**（不影響後續小 payload 的判定）。
- tokenize 過程 token 數 > `MAX_TOKENS`（建議 **20000**）→ **此 payload** `false`，同樣繼續掃描其他候選。
- **不設「全域 byte 預算一旦超過就整體 `false`」**（round 7 finding 2：否則大的不相符 payload 會先耗盡預算、
  令後續小的相符 `node -e 'fake'` 漏判）。
- **memoize（回應 round 14 finding 2）**：`payloadIsAllStaticPrint(source, lang)` 以 **(source 字串值, lang)**
  為鍵（`Map<string, boolean>`，鍵為 lang 與 source 以一個分隔字元串接，例：`js` + 分隔 + source；分隔字元
  取不會出現在 lang 列舉中的字元以避免碰撞）快取結果。繼承式 redirect 會讓**同一個** heredoc body 被多個葉指令共用（如
  `{ node; node; …多次…; } <<'EOF' …64KiB… EOF`），若不快取則每個 `node` 各 tokenize 一次 →
  葉數×payload。memoize 後每個**相異** source 只 tokenize 一次。故總工作量＝Σ(相異 payload 大小) ≤ 指令
  長度（OS/Bash 已對指令長度設限）→ O(指令長度)，**不隨葉數放大**。
- 上述皆 fail-safe 方向（超限的**個別** payload 不 deny、退回既有 ask），確保 hook 同步路徑恆有界、永遠
  `exit 0`。

**步驟 1：Tokenize**（線性掃描，依 lang 區分註解）
- 跳過：空白、換行、shebang（行首 `#!`…整行）、註解（js `//`…行尾、`/* … */`；py `#`…行尾）。
- 產生 token（回應 round 13 finding 2，明確各語言靜態字串字面量）：
  - js `STRING`：`'…'`、`"…"`；**模板字串 `` `…` ``：不含 `${` → `STRING`（靜態）；含 `${` → `DYNAMIC`**。
  - py `STRING`：`'…'`、`"…"`、**三引號 `'''…'''`/`"""…"""`（多行靜態）**；含一般引號逸脫。
  - **動態前綴 → `DYNAMIC`**：py f-string `f"…"`/`f'…'`/`f"""…"""`（含 `rf`/`fr` 等含 `f` 的組合）。
    （py `r`/`b`/`rb` 等**不含 `f`** 的前綴仍是靜態字串 → `STRING`。）
  其餘 token：`NUMBER`、
  `NAME`（識別字，含點號鏈如 `console.log`、`sys.stdout.write`）、`PUNCT`（`(` `)` `,` `;`）、
  其餘任何字元（`+ - * / = % < > [ ] { } & | ! : ? ~ ^` 等）→ `OTHER`。
- **`NUMBER` 形狀**（明確化，回應 structural advisory）：`[+-]?` 前導正負號、十進位整數或小數
  （`123`、`1.5`、`.5`、`12.`）、可選指數（`1e9`、`2.5E-3`）；js 另允許 `0x…`/`0o…`/`0b…`/底線分隔/
  `…n`(BigInt)。任何不完整/含其他字元的數字序列 → 退化為 `OTHER`/`NAME`（→ fail-safe 不 deny）。
- 字串逸脫、未閉合引號/括號在此層偵測；**任何未閉合 → 整體 `false`**。

**步驟 2：文法比對**（消費 token 串，須完全消費）
整個 token 串必須是「一條以上 print 敘述」的序列，每條：
```
PRINT_FN '(' ARG (',' ARG)* ')' ';'?
```
- `PRINT_FN`：js ∈ {`console.log`,`console.info`,`console.warn`,`console.error`,`console.debug`,
  `process.stdout.write`,`process.stderr.write`}；py ∈ {`print`,`sys.stdout.write`,`sys.stderr.write`}。
  以 `NAME` token 的點號鏈完全相等比對。
- `ARG`：恰為一個 `STRING` 或一個 `NUMBER`。**不允許** `NAME`（變數）、`OTHER`（運算子）、`DYNAMIC`
  （模板/f-string）、巢狀 `(`。
- 須 **≥1 條** print 敘述（零有效 token → `false`）。

**步驟 3：fail-safe（任何不確定即 `false` → 不 deny、退回既有 ask；絕不誤 deny）**
比對過程遇到任何不吻合（`NAME` 出現在該是 `STRING`/`PRINT_FN` 的位置、`OTHER`、`DYNAMIC`、未閉合、
token 未完全消費、py `print` 出現 `=` keyword 引數）→ 立即 `false`。

**對照「真實工作」範例（皆須 `false`、不 deny）**：
`console.log(1+1)`（`OTHER` `+`）、`print(sorted([…]))`（`(` 巢狀/`NAME`）、`print(json.dumps(d))`
（`NAME`）、`console.log(JSON.stringify(x))`（`NAME`）、`import json; print(…)`（`import`→`NAME` 在
敘述首非 PRINT_FN）、`console.log(`${x}`)`（`DYNAMIC`）、`print(f"{x}")`（`DYNAMIC`）、
`console.log("a"+"b")`（`OTHER` `+`）→ 全部 `false`。
**目標案例** 整段 `console.log("…")`＋註解 → 每條吻合 → `true`。**註解＋單句 `console.log("done")`**
（全部寫死、只剩一句 no-op print 的變形）→ 註解剝除後一條 print 字面量 → `true`。

> 邊界：`console.log("a", "b")`（多字面量逗號分隔）→ `true`；`console.log()`（無引數）→ 無 ARG →
> 視實作為 0 個 ARG，文法要求 `ARG (',' ARG)*` 至少一個 → 不吻合 → `false`（保守，無妨）。

### 4.2 直譯器葉指令辨識與向量分派（`interpreterPrintSprayDeny`）

**閘④ 為單一、source-order 的 AST 前序走訪（pre-order），是四向量的唯一資料來源**（回應 round 8/9：
單一架構、order-aware 遮蔽、無 off-spine 繞道）。**不**讀攤平 `invocations`，而是依**原始碼順序**前序走訪
整棵 `script`，維護兩組狀態：

- `definedBefore`＝**在原始碼順序上、此節點之前、且在「同一 shell scope」可見的函式定義名**（**scope-aware**，
  回應 round 11 finding）。Bash 函式定義只影響**同一 shell** 中其**之後**執行的指令；「同 scope ＋
  textually-before」是「**可能在執行前先於本 shell 定義**」的健全 over-approximation。
  - **同 shell scope（會累積進 definedBefore）**：`Script.commands`、`CompoundList`、`BraceGroup`、`AndOr`、
    以及 `If`/`For`/`While`/`Case` 的本體（控制流分支在當前 shell 執行；其定義**可能**洩漏到之後 → 視為
    可能遮蔽 → 跳過、不 deny；回應 round 9 finding 1：`if cond; then node(){:;}; fi; node -e …` → ask）。
  - **不同 shell scope（descend 進去但其內定義 NOT 洩漏回父 → 不計入父的 definedBefore）**：`Subshell`
    `( … )`、命令替換 `$( … )`、程序替換 `<( … )`/`>( … )`、背景 `&`、coproc。實作上以**傳值複本**進入：
    子範圍可加自己的定義供其內部使用，但返回後**父範圍 definedBefore 不變**（回應 round 11：
    `(node(){:;}); node -e 'fake'` 中 subshell 的 node 定義**不遮蔽**父 shell 的 `node` → **deny**）。
  - 故識別三態：**確定為 binary（無同-scope 前置定義）→ 可 deny**；**同-scope 前置（含條件分支）定義 →
    身分不確定 → 跳過、落閘③ 不可升級 ask**；subshell/替換內定義**不影響**父範圍判定。
- 在每個**循序序列**（`Script.commands`、`CompoundList`、`BraceGroup`、`&&`/`;` 的 `AndOr`——皆當前
  shell 循序）內維護 `prevWrite`＝緊鄰前一個 sibling 的靜態截斷 WRITE（向量 C 用）。

**向量分派**：
**統一原則**：閘④ 依**結構/意圖**偵測偽裝，**在 AST 中任何位置**命中即 deny（與本工具既有 deny 哲學
一致——閘① 連 dead 分支的 sleep 都 deny；使用者 round-3 明確採意圖導向）。唯三類「身分/資料流不確定」
才跳過：**(i) 名被 source-order 前置函式定義遮蔽**、**(ii) payload/路徑動態無法靜態取得**、**(iii) 改變
資料流/啟動順序的包裝**（背景 `&`、coproc、整體 pipeline redirect、消費端 fd0 蓋過 pipe）。**否定 `!`
不在此列**（`!` 只反轉退出碼、不改 producer→consumer 資料流，回應 round 20 finding 1）。
- **向量 A/B（單葉 inline/stdin）對任何位置的直譯器 Command 節點生效**（含 `if`/`for`/subshell/命令替換
  內——回應 round 9 finding 2：`if true; then node -e 'fake'; fi`、`(node -e 'fake')` 不再繞過硬 deny）。
- **向量 D（兩段 `producer|interpreter` Pipeline）亦對任何位置的 Pipeline 節點生效**（pipe 內「生產者
  stdout→消費者 stdin」是該節點**內在**資料流、非跨敘述順序假設，故不限循序序列；含 (iii) 排除）。
- **向量 C（寫檔→執行）需跨敘述的執行順序保證，故僅在循序序列上判**：比對 EXEC 與其循序序列內**緊鄰
  前一個 sibling** 的 WRITE；跨控制流/subshell 邊界不延續 `prevWrite`（無此保證即不 deny）。

`defs` 為「**當前 shell scope** 中、此前已定義的函式名」集合，**scope-aware**：同 shell 的循序/複合/控制流
節點**共享並 mutate** 同一個 `defs`（定義洩漏給其後）；進入 subshell/命令替換/程序替換/背景/coproc 時以
**複本** `defs.copy()` 下降（其內定義不洩漏回父）。

```
interpreterPrintSprayDeny(script, initialCwd):
  found = false
  // visit 回傳更新後 cwd；defs 依 scope 規則傳遞（同 shell 共享、新 shell 傳複本）
  visit(node, cwd, defs, prevWriteRef):
    switch node:
      FunctionDef(name):           defs.add(name); prevWriteRef = null          // 加入「當前 scope」
      SeqSemicolon(children):      // Script.commands / CompoundList / BraceGroup（`;`/newline，無條件循序）
        local prev = null; local c = cwd
        for child in children: c = visit(child, c, defs, &prev)                 // prev 在相鄰 simple-leaf 間延續
        prevWriteRef = null                                                      // 序列結束不外帶
      AndOr(legs, ops):            // `&&`/`||` 鏈（成功閘控，回應 round 23/24）
        local c = cwd
        // 向量 C 對 AndOr 僅認**恰兩 leg 的 `WRITE && EXEC`**（exactly 2 legs、唯一 op 為 `&&`、leg0 為
        // simple WRITE、leg1 為 EXEC）。任何其他形狀（>2 legs、任一 `||`、混合）→ 一律不帶 prevWrite。
        if legs.length == 2 and ops == ["&&"] and legs[0] 為 simple WRITE leaf:
          visit(legs[0], c, defs, &null)                                         // WRITE leg
          local prev = WRITEof(legs[0])
          visit(legs[1], c, defs, &prev)                                         // EXEC leg：對 prev 做向量 C 比對
        else:
          for leg in legs: c = visit(leg, c, defs, &null)                        // 其餘：各 leg 獨立、無 C 相鄰
        prevWriteRef = null                                                      // `&&`/`||` 鏈邊界不外帶 prevWrite
      ControlFlow(If/For/While/Case):                                           // 本體在當前 shell 執行
        // 各分支互斥：以「分支本地複本」掃描，掃完才把各分支離開時定義的「聯集」併回父 defs（回應 round 12）
        union = {}
        for branch in 各分支/本體:
          local d = defs.copy()
          visit branch with d（共享 d；其內定義只在該分支可見）, fresh prevWrite = null
          union = union ∪ (d \ defs)               // 該分支新定義
        defs.add_all(union)                         // 構造之後（同 shell）視為可能遮蔽（保守）
        prevWriteRef = null
      Pipeline(2段 producer|interp)  (任何位置；含 (iii) 包裝排除):              // 向量 D
        if checkVectorD(node, defs): found = true        // 消費者/生產者名 ∈ defs → 跳過
        descend 各段 with defs.copy()（各段在 subshell）以收集定義/跑 A/B; prevWriteRef = null
      NewShellScope(Subshell ( )/命令替換 $( )/程序替換/&背景/coproc):           // 其內定義不洩漏回父
        visit-children with defs.copy()（父 defs 不變）, fresh prevWrite = null, cwd 多為 unknown
        prevWriteRef = null
      SimpleCommand(node):                               // 任何單一簡單 Command（含 cat/echo/printf/node/python…）
        leaf = leafOf(node)                              // §4.2.2（含繼承 redirect、cwd 快照、assignments=prefix）
        exec = (leaf != null) ? resolveExec(leaf) : null // §4.2.0：透視 command/env/timeout/nice/nohup wrapper
        if exec != null and exec.name in INTERPRETERS
           and leaf.name not in defs and exec.name not in defs   // 外層 wrapper 名與內層直譯器名「皆未被遮蔽」才 deny-eligible
                                                                 //（回應 round 20/21：zero-false-deny 優先；任一被遮蔽 → 身分不確定 → 跳過、落閘③ 不可升級 ask）
           and leaf.assignments is empty:                // 無賦值前綴（round 14：PATH=… 可改變解析 → 不 deny；env 改環境已於 resolveExec→Unknown）
          switch recognizeInterpreter(exec):             // §4.2.1（exec＝§4.2.0 透視後的 name+argv）
            InlineEval(code,lang): if payloadIsAllStaticPrint(code,lang): found = true     // A（任何位置）
            StdinRead(lang): b=staticStdinBody(leaf); if b and payloadIsAllStaticPrint(b,lang): found = true  // B（leaf.redirects 上的 fd0）
            ScriptExec(entrypoint,lang):                 // C（僅 SameShellSeq、緊鄰；entrypoint＝被執行腳本，非旗標值）
              if prevWriteRef is WRITE(P',content,cwd_v,writerName) and writerName not in defs
                 and pathsEqualCwdAware(P',cwd_v, entrypoint,cwd) and payloadIsAllStaticPrint(content,lang): found = true
        // ★關鍵（回應 round 13 finding 1）：對**任何**簡單指令更新 prevWrite——寫檔者 cat/tac/echo/printf
        // 並非 INTERPRETERS，但正是向量 C 的 WRITE 來源；若只在 interpreter 分支更新，旗艦案例 cat>x; node x 會漏。
        prevWriteRef = (leaf != null) ? staticTruncatingWriteOf(leaf) : null      // 非靜態截斷寫檔 → null
        update cwd（leaf 為 cd 則 thread；僅 SameShellSeq 內持久）
    return updated cwd
  visit(script, initialCwd, {}/*defs*/, &null)
  return found
```

> `staticTruncatingWriteOf(leaf)` 回 `WRITE(P, content, cwd, writerName)`：當 `leaf` 名 ∈
> {`cat`,`tac`,`echo`,`printf`}、**無賦值前綴**（`leaf.assignments` 空；回應 round 14：`PATH=… cat` 等可改變
> 指令解析）、且有靜態截斷寫入重導向 `>`/`>|`（target 靜態 P）且內容可靜態還原（§4.5 步驟 3）；否則回
> `null`。任何**非簡單指令**或無此寫入 → `prevWrite` 重置為 `null`（緊鄰中斷）。**向量 D 的生產者/消費者**
> 同理：任一段帶賦值前綴 → 身分不確定 → 跳過、不 deny。

- **遮蔽 scope + source-order**：`node -e 'fake'; node(){:;}`（def 在後）→ `node -e` 時 defs 無 node →
  **deny**；`node(){:;}; node -e 'fake'`、`if cond; then node(){:;}; fi; node -e 'fake'`（同 shell、def 在前/
  條件分支）→ node ∈ defs → 跳過 → 落閘③ **不可升級 ask**；**`(node(){:;}); node -e 'fake'`、
  `$(node(){:;}); node -e 'fake'`（def 在 subshell/替換內）→ 不洩漏回父 → defs 無 node → **deny****
  （回應 round 11）。writer/生產者名同理以同 scope `defs` 判。
- **不改** `walk.ts`／`CommandInvocation`；此為**獨立**前序 AST 走訪（`leafOf` 取 leaf，§4.2.2）。`evaluate`
  的閘③ 仍用既有 whole-script `fnNames`（over-ask 安全），與閘④ 的 scope-aware `defs` 獨立。

**共用 leaf 萃取 `leafOf(statement)`（詳見 §4.2.2）**：把單一簡單 `Command` 化約成 `{name, argv, redirects,
cwd}`，`redirects` **規範順序＝`[...inherited, ...statement.redirects, ...cmd.redirects]`**（與 walk 一致，
fd0「最後者勝」依此序）。**函式定義（`FunctionDef`）的 body 不被走訪做 hard-deny 分析**（body 未被呼叫前
不執行）——只把函式名加入 `defs`；控制流/subshell/命令替換的 body **會**被走訪（其內指令會在某執行路徑跑）。
此 helper 純讀、與 `walk.ts` 的 `emitCommand` 取值方式一致但**不修改** walk，僅供 `interp_print.ts`
的單一 source-order AST 走訪（§4.2）使用。

`INTERPRETERS = {node, nodejs, python, python3, deno, bun, ts-node}`。

#### 4.2.0 exec-wrapper 透視 `resolveExec(leaf)`（回應 round 19 finding：閉合 wrapper 繞道）

在判定 `leaf.name ∈ INTERPRETERS` **之前**，先透視一小組**保留執行語意**的 exec wrapper，得到真正被執行的
`(name, argv)`；使 `timeout 5 node -e 'fake'`、`command node -e 'fake'`、`nohup python -c 'fake'` 等仍走
gate ④（與使用者 round-17 意圖一致——附帶 wrapper 不改變「會跑這支 print 腳本」）。**保守、fail-safe**：
任何 wrapper 旗標/位置參數動態、或 env 改變環境 → 回 `Unknown`（不 deny），解析錯誤只會 under-deny。

- `command [-p] CMD…`（`-v`/`-V` 查詢模式 → `Unknown`）→ 透視成 `CMD…`。
- `nohup CMD…`、`setsid CMD…`、`stdbuf <-oL 等opts> CMD…` → 透視成 `CMD…`（stdbuf 的 `-oL/-eL/-iL` 等吃值）。
- `nice [-n N | -N] CMD…` → 略過 `-n N`，透視成 `CMD…`。
- `timeout [opts] DURATION CMD…` → 略過 opts（`--preserve-status`/`--foreground`/`-s SIG`/`--signal=`/
  `-k DUR`/`--kill-after=`）與 `DURATION` 位置參數，透視成 `CMD…`。
- `env CMD…`：**僅當無環境改變**（無 `NAME=VAL` 賦值、無 `-i`/`--ignore-environment`、無 `-u NAME`）→ 透視成
  `CMD…`；否則（改環境，`PATH=` 等可改變指令解析）→ `Unknown`（與 §4.2.1 賦值前綴跳過同理）。
- **遞迴**透視（wrapper 套 wrapper，如 `timeout 5 nice -n 1 node …`）；遇未知 wrapper 名或非上述形 → 不再
  透視（以當前 name 判定，多半非 INTERPRETERS → under-deny）。動態 CMD 名 → `Unknown`。

> 透視後 `(name, argv)` 餵 `recognizeInterpreter`；其餘 gate ④ 邏輯（賦值前綴跳過、entrypoint 解析、向量
> A/B/C/D）不變。**安全**：透視只在保留執行語意且**靜態可解**的 wrapper 形式啟用；任何不確定 → `Unknown`、
> 不 deny。e2e 須驗 `env node -e 'fake'`/`timeout 5 python -c 'fake'` 即使有 `Bash(node *)`/`Bash(timeout *)`
> 仍 **deny**（gate ④ 短路、不經 settingsAllows）。
>
> **wrapper × 函式遮蔽（zero-false-deny 優先；解決 round 20↔21 張力）**：deny-eligible 須**外層 wrapper 名
> 與透視後內層直譯器名「皆未在當前 scope 被函式定義遮蔽」**。技術上 `timeout`/`env`/`nice`/`nohup` 以
> `execvp` 執行外部 binary、`command` 明確繞過函式——其 exec 的 `node` 是 binary 而非 shell 函式（匯出
> 函式 `BASH_FUNC_*` 只對「子 bash」可見、對 `execvp` 的非-bash 子行程無效），故 `node(){:;}; timeout 5
> node …` 實跑 binary、deny 在語意上正確。**但 hard deny 不可復原**，為杜絕任何環境差異風險，**保守要求內層
> 名亦未被遮蔽**：若使用者已定義同名函式（`node(){…}`）→ 視為身分不確定 → 跳過、落閘③ **不可升級 ask**
> （安全 under-deny；殘留：此時 `node(){}; timeout node …` 得 ask 而非 deny，仍非放行）。e2e 應涵蓋
> `node(){:;}; export -f node; timeout 5 node -e '…'` → **ask**（內層遮蔽 → 不 deny）、與無同名函式時 → deny。

#### 4.2.1 `recognizeInterpreter(inv)`（每直譯器一組規則）

掃描 `inv.argv`（靜態化），回傳 `InlineEval(code, lang)` / `StdinRead(lang)` /
`ScriptExec(entrypoint, lang)` / `Unknown`。

> **旗標策略（回應 round 17 使用者決定 + round 18 finding 1）**：使用者指出「execution-shaping 旗標不改變
> 『會執行該腳本』——有沒有 `--transpile-only`/`--experimental-*` 沒差」。故**略過良性旗標、找出真正的
> entrypoint 腳本**；但**旗標的「值」（如 `--require <preload>`、`--loader <l>`、`--import <m>` 的檔案值）是
> 輔助檔、非 entrypoint，絕不可當 entrypoint**（否則 `node --require ./setup.js real-test.js` 會誤把 preload
> `setup.js` 當被執行腳本而誤 deny 合法測試——round 18 finding 1）。
>
> **保守 entrypoint 解析（arity 安全失敗方向＝under-deny）**：逐一掃 argv（deno/bun 先吃 `run` 子指令）：
> - **inline-eval 旗標** `-e`/`-c`/`--eval`（含 `=` 黏寫）／`deno eval` → `InlineEval(值, lang)`。
> - **stdin** `-`／無 entrypoint → `StdinRead(lang)`。
> - **`--flag=value`**（自含值）→ 1 token、略過。
> - **裸旗標 `-x`/`--flag`（無 `=`）**：若 ∈ 該直譯器的**「已知無值旗標」集合**（見下）→ 略過 1 token；
>   **否則（已知帶值旗標 + 未知旗標一律）→ 視為帶值、略過 2 token（連同其下一個值 token）**。此「不確定就
>   當帶值」使 arity 誤判**只會吃掉可能的 entrypoint → under-deny（安全）**，絕不會把旗標值當成 entrypoint。
> - 第一個**非旗標位置參數** → `entrypoint`（→ `ScriptExec(entrypoint, lang)`）；其後 token 為程式 argv。
> - **已知無值旗標集合（常見良性 mode；可擴充，誤漏只會 under-deny）**：node/bun `--no-warnings`/
>   `--experimental-vm-modules`/`--enable-source-maps`/`-b`(bun) 等；ts-node `--transpile-only`/`-T`/`--esm`/
>   `--files`；python `-O`/`-B`/`-u`/`-v`/`-q`/`-I`/`-s`/`-E`/`-i`；deno `-A`/`--allow-all`/`--no-check`/`--quiet`。
>   （`--experimental-default-type=module` 屬 `=` 形 → 自含值、1 token。）
> - **覆蓋宣稱（明確、回應 round 22 finding 1）**：本設計**不宣稱 flag-agnostic 全覆蓋**。涵蓋的是「**已知
>   無值旗標 + `=` 形 + 帶值旗標**」之 script 執行；**未在無值集合內的未知旗標**（含 CLI 版本演進新增的
>   no-value 旗標）會被當帶值、可能吃掉 entrypoint → **under-deny（安全；可被 `Bash(node *)` 升級，屬既有
>   settings 風險）**。此無值集合**刻意維護為可擴充清單**，新增常見 no-value 旗標即提升覆蓋；其誤漏方向
>   恆為 under-deny，**絕不誤 deny**。（不採「未知→當無值」是因那會把帶值旗標的值誤當 entrypoint → 誤 deny，
>   違反 zero-false-deny。）
> - **python `-m <module>` 是「模組執行」終結形（回應 round 25 finding，**避免誤 deny**）**：`-m` 之後是
>   **模組名**、其餘 token 是**該模組的 argv**（**非**直譯器 script entrypoint）。故 `python -m <module> …` →
>   **無 entrypoint** → 回 `Unknown`（**不**產生 `ScriptExec`）。例：`echo 'print("x")' > t.py; python -m pytest
>   t.py`、`python -m unittest t.py` → `t.py` 是 pytest/unittest 的引數、非被執行腳本 → **不 deny**。
> - **副作用/預載旗標**（`-r`/`--require`/`--import`/`--preload`/`--env-file`、deno `--allow-*`/`--preload`/
>   `--require`）：對 **inline/stdin**（payload 須純 print）→ 注入額外執行碼、破壞純度 → `Unknown`、不 deny。
>   **須掃描整個 argv**（回應 round 24 advisory）：`node -e '…' -r x` 與 `node -r x -e '…'` 同樣 → `Unknown`
>   （預載旗標在 inline 值之後亦算）。對 **script 執行**：其值被當帶值 token 吃掉（非 entrypoint）→ 不影響、
>   亦不誤 deny preload 檔。
> - 動態 token（entrypoint 或 inline 值動態）→ `Unknown`。`-p`/`--print` 運算式吐值 → 述詞天生不命中
>   （§1.4.1），不特別處理。

> 此辨識器**只負責分派**，fail-safe（任何歧義 → `Unknown`/under-deny）；真正判定靜態-print 由 §4.1 述詞。
> 安全要點：**entrypoint 解析錯誤的唯一方向是 under-deny**（把 entrypoint 誤吃成旗標值）；**永遠不會**把
> 旗標值升格成 entrypoint，故 round 18 的 preload 誤 deny 不會發生。

#### 4.2.2 共用 leaf 萃取 `leafOf(statement)`

§4.2 的 source-order AST 走訪以此把單一 `Command` 節點化約成 `{name, argv, redirects, cwd}`：
- 僅當 `statement.command` 為單一簡單 `Command` 節點時回傳該形狀；`name = staticValue(cmd.name)`
  （動態 → `null`）、`argv = cmd.suffix`、`assignments = cmd.prefix`、`redirects = [...inherited,
  ...statement.redirects, ...cmd.redirects]`（`inherited`＝走訪下降時由外層 `CompoundList`/`BraceGroup`/
  `Statement` 累積的繼承 redirect，與 `walk` 對複合結構繼承一致）、`cwd`＝走訪由 `initialCwd` 沿循序序列
  以 `walk` 相同 `cd` 規則 thread 的快照（控制流/subshell 內 cwd 多為 unknown，見 §4.5）。
- command 為 `Pipeline`/`Subshell`/`If`/`For`/`While`/`Case`/`Function` 等複合節點 → `leafOf` 回 `null`
  （非單一簡單 `Command`）。走訪對它們的處理（回應 round 22 finding 2，**單一明確規則**）：
  - **`Subshell`/控制流（`If`/`For`/`While`/`Case`）/命令替換的 body → 下降走訪**（其內指令會在某執行路徑
    執行）→ 對其內直譯器跑向量 A/B、收集函式定義；C/D 相鄰不跨此邊界（§4.5）。
  - **`Function` 定義的 body → 不下降做 hard-deny 分析**（body 未被呼叫前不執行；`f(){ node -e 'fake'; }`
    僅定義 → **不 deny**）。只把函式名加入當前 scope 的 `defs`。被呼叫的同名函式（`f(){…}; f`）由既有
    **閘③ 函式遮蔽 → 不可升級 ask** 承接（gate ④ 不解析函式體內的 interpreter 呼叫，避免 over-deny dead
    body、亦不做同呼叫函式內聯）。
- 純讀，取值方式與 `walk.ts` 的 `emitCommand` 一致，但**不修改** `walk.ts`／`CommandInvocation`。

### 4.3 向量 A（inline）詳述

`recognizeInterpreter` 取得 `InlineEval(code, lang)`，`code` 為 `staticValue` 還原的字串，餵 §4.1。
例：`node -e 'console.log("x")'` → js、code=`console.log("x")` → `true` → deny。
`python -c 'print("a");print("b")'` → py → `true` → deny。
`deno eval 'console.log(1+1)'` → 述詞遇 `+` → `false` → 不 deny。

### 4.4 向量 B（heredoc/here-string 餵 stdin）詳述

`recognizeInterpreter` 回 `StdinRead(lang)` 時，取該葉指令 fd0 的有效輸入（沿用 `print_only.ts`
`isCatPassthrough` 的「fd0 最後者勝」邏輯抽出 `staticStdinBody`）：有效 stdin 為 `<<`/`<<-`/`<<<` 且
`isHeredocPrintEligible` → 取其靜態 body 字串餵 §4.1。
例：`node <<'EOF'\nconsole.log("x")\nEOF` → body=`console.log("x")` → `true` → deny。
`python <<'EOF'\nimport os; print(os.getcwd())\nEOF` → 含 import/`NAME` → `false` → 不 deny。
有效 stdin 為 `< file`（讀真實檔）/`<&n`（fd 複製）/動態 heredoc → `staticStdinBody` 回 null → 不 deny。

**繼承式 stdin 明確排除於硬 deny 範圍（回應 round 8 finding）**：bare `node`／`node -`／bare `python`／
`python -`／`deno run -`／`bun run -`／`ts-node`（**無任何 fd0 重導向**）會從**繼承的 stdin 串流**讀程式
碼，而本 hook **只收到 Bash 指令字串、看不到該 stdin 內容**。此情形 `staticStdinBody` 必回 `null` →
**不 deny**（無可靜態檢視的 payload）。這是**明確、有意的範圍排除**（非靜默 fallthrough）：繼承式 stdin
執行**不在**硬 deny 保證內，落既有 classify（直譯器不在 allowlist → ask，**可被** `Bash(node *)` 等升級
為 allow——屬使用者自負的 settings 風險）。唯有「向量 B 的靜態 heredoc/here-string」與「向量 D 的可見
pipe 生產者」這兩種**hook 能靜態看到 payload** 的 stdin 來源才在硬 deny 範圍。

### 4.5 向量 C（同鏈寫腳本檔 → 執行同檔）詳述

**順序感知、緊鄰前驅**（修 round 1 design-soundness no-ship：原「掃全表建 map」忽略執行順序，會把
`node x; cat > x <<EOF…EOF`（node 實際跑既有檔）誤判為跑後寫的靜態 payload）。向量 C 在 §4.2 的
source-order AST 走訪中、**在循序序列上**判定（其 `prevWrite` 即實作「緊鄰前驅 WRITE」、`definedBefore`
即 source-order 遮蔽）；以下為其規則。

1. **循序序列與 `&&` 成功閘控（回應 round 23 finding：`&&` 帶成功閘控、不可等同 `;`）**：
   - **`;`/newline 序列**（`Script.commands`、`CompoundList`、`BraceGroup`）：相鄰 sibling **無條件**循序執行
     → `prevWrite` 在相鄰 simple-leaf sibling 間延續；`WRITE ; EXEC`（緊鄰）→ deny。
   - **`&&`-`AndOr`**：第 i leg 須前 0..i-1 leg 皆成功才執行，**reachability 有條件**。故向量 C 對 AndOr
     **僅認「恰兩 leg 的 `WRITE && EXEC`」**（**exactly 2 legs、唯一 operator 為 `&&`、leg0 為 simple WRITE、
     leg1 為 EXEC**，回應 round 24）；**任何其他 AndOr 形狀**（>2 legs、含任一 `||`、混合）→ 一律不帶
     prevWrite、不 deny。`cat > x <<EOF…EOF && node x` → deny（airtight：node 只在 write 成功才跑）；
     `false && cat > x <<EOF…EOF && node x`（3 legs）、`cat > x <<EOF…EOF && false || node x`（含 `||`）、
     `x && cat > x <<EOF…EOF && node x` → **不 deny**（非恰兩-leg `&&`，避免誤 deny 條件/inert 鏈）。
   - **`prevWrite` 不跨下列邊界延續**（其後的指令到達性無保證）：`&&`/`||`-`AndOr` 的**邊界**（一個 `&&`/`||`
     鏈完成後，其末 leg 只條件執行 → 不把 prevWrite 帶給後續 `;`-sibling，如 `false && cat > x; node x` →
     `node x` 不 deny）、`Subshell`/`Pipeline`/`If`/`For`/`While`/`Case`/`Function`、命令替換、`&` 背景/coproc。
     這些邊界內的 body 走訪仍跑向量 A/B 與收集函式定義，但 C 相鄰不跨界。**WRITE 與 EXEC 兩者皆不得為背景/async statement**（回應 round 4 finding 2：`cat > x & node x`
   中背景寫入不保證在 `node` 讀檔前完成、甚至未必先啟動 → 不 deny；與向量 D 排除背景 pipeline 一致）。cwd
   沿循序序列以 `walk` 相同規則 thread（遇 `cd` 後標 unknown），**每個節點記下其自身的 cwd 快照**。
2. **緊鄰前驅比對**（cwd-aware，回應 round 2 finding 1；旗標無關，回應 round 17）：對循序序列上每個節點，
   `leafOf` 取其 leaf。若某 statement 為 **`ScriptExec(entrypoint, lang, cwd_e)`**（`leafOf` 名 ∈
   INTERPRETERS、非 inline/stdin；`entrypoint`＝§4.2.1 保守解析出的被執行腳本，**非旗標值**），檢查其
   **緊鄰前一條** statement 是否為 **`WRITE(P', content, cwd_v)`**（靜態寫腳本檔，見下）。比對使用**各自
   statement 的 cwd 快照**：**僅當 `cwd_v` 與 `cwd_e` 皆為 `known` 且 `normalizeAbsolute(P', cwd_v) ===
   normalizeAbsolute(entrypoint, cwd_e)`** 才算「執行了該寫出檔」；任一快照 `unknown` 或不相等 → **跳過、
   不 deny**。命中且 `payloadIsAllStaticPrint(content, lang)` → **deny**。否則不 deny。
   `ts-node --transpile-only x.ts`、`node --experimental-* x.mjs`、`deno run -A x.ts` 等帶旗標形式 →
   entrypoint 仍是 x → 命中前驅 P 即 **deny**；`node --require setup.js real-test.js` → entrypoint=real-test.js
   ≠ 寫出的 setup.js → **不 deny**（回應 round 18）。
   （註：緊鄰時 `cwd_v === cwd_e`，因兩者間無任何 statement；`cd` 介於兩者間時 `cd` 自身即緊鄰前驅、
   非 WRITE → 自然不 deny，見下例。）
3. **`WRITE(P, content)` 定義**：statement 的 leaf 有**截斷型寫入重導向 `>`/`>|`**（target 為**靜態路徑**
   P），且內容可由該 leaf 靜態還原：`cat`/`tac` 搭靜態 heredoc/here-string（`isHeredocPrintEligible`）→
   內容＝body；`echo`/`printf` 靜態 payload（沿用 `print_only.ts` 的 `wordPrintEligible`，printf 僅無格式化
   轉換符時可還原）→ 內容＝還原輸出字串。任何無法靜態還原 → 非 WRITE。
   - **排除 append `>>`（回應 round 4 finding 1）**：`>>` 是**附加**，最終檔案內容＝既有內容＋本次片段，
     無法靜態證明整檔皆 print，且 `echo 'console.log("x")' >> real-test.js; node real-test.js` 會**誤 deny
     既有真實腳本**。故 `>>`（及任何非截斷寫入）**不算 WRITE** → 不 deny。只有 `>`/`>|` 截斷覆寫使
     「整檔內容＝本次靜態還原內容」成立，才可比對。
   - **函式遮蔽跳過（order-aware，回應 round 6/7 finding）**：以 §4.2 的 `definedBefore`（**此前已定義**的
     函式名）判；若 **EXEC 直譯器名 ∈ definedBefore** 或 **WRITE 指令名（`cat`/`tac`/`echo`/`printf`）∈
     definedBefore** → 該配對身分不確定 → 跳過、不 deny（落閘③ ask）。**只有在該指令之前定義的函式才算
     遮蔽**（之後定義的不影響）。

**為何「緊鄰前驅」而非「任意前驅」**：靜態上要鎖定「**若 EXEC 執行、餵給它的就是這次寫入的內容**」。
只認**緊鄰**前一條寫入，可同時免疫三種**靜態可判定**的錯配（皆會讓 node 跑到「已知不同的檔/內容」）：
執行在寫入之前（`node x; cat > x …` → EXEC 的前驅非寫 x → 不 deny）、中間插入可能改寫 P 的其他 statement
（前驅非 WRITE → 不 deny）、cwd 在兩者間改變（前驅是 `cd` → 不 deny）。代價是非緊鄰的
`cat > x …; echo hi; node x` 不 deny（保守漏 deny，安全、可接受）。

**不變量框架＝偵測「偽裝結構/意圖」，非「runtime 執行保證」（明確設計決策，回應 round 3 finding 1）**：
vector C 在「靜態上 EXEC 緊鄰於寫同檔同 cwd 的 WRITE」即 deny；它**刻意不要求靜態證明寫檔 runtime 成功**
（權限/唯讀/ENOSPC/缺父目錄等動態失敗無法靜態得知）。**這與本工具既有 deny 哲學一致**——閘① 對**字面
`sleep`** 一律 deny（連不可達 dead 分支內的 sleep 也 deny，不論是否真的執行）、閘② 對 echo/printf/cat
依**結構**判 print-only deny；三者偵測的都是「**該指令鏈所表達的禁止行為（意圖/結構）**」，而非「runtime
必然發生」。「寫一段每行都 `console.log/print` 死字串的腳本、緊接著用直譯器執行它」**無任何正當用途**，
其結構本身即偽裝意圖，故 `&&`（成功閘控）與 `;`/newline（緊鄰）**一律硬 deny**（使用者明確決定，
2026-06-28）。`&&` 形式連 runtime 寫檔失敗的殘留都無；`;`/newline 形式的「寫檔失敗 → node 跑既有/缺檔」
屬已知、刻意接受的殘留（見下，與 sleep dead-branch deny 同性質——依結構/意圖 deny，不視為有意義的
false-deny）。

- 目標案例 `cat > /tmp/x.mjs <<'EOF'\nconsole.log("…")\nEOF`（newline＝`;`）`node /tmp/x.mjs` → 兩條
  在同一循序序列上**緊鄰**、同 path、內容全 console.log 字面量 → **deny**。
- `cat > x.mjs <<'EOF'…EOF && node x.mjs`（`&&` 連接）→ 緊鄰 → deny；且 `&&` 保證寫入成功才執行。
- `node x.mjs; cat > x.mjs <<'EOF'…EOF` → EXEC 前驅不是寫 x → **不 deny**（修正後正確）。
- `echo 'console.log("x")' > x.mjs; node x.mjs` → deny。
- `cat > x.mjs <<'EOF'…EOF; cd other; node x.mjs` → EXEC 緊鄰前驅是 `cd other`（非 WRITE）→ **不 deny**
  （即使緊鄰，cd 也使 `node x.mjs` 實際讀 `other/x.mjs`≠寫入的 `./x.mjs`；本規則天然不命中）。
- `cd "$D"; cat > x.mjs <<'EOF'…EOF; node x.mjs`（先前 `cd <動態>` 使 cwd 標 unknown）→ 兩端 cwd 快照
  皆 `unknown` → 無法證明同檔 → **跳過、不 deny**。
- `cat > x.py <<'EOF'\nimport sys; print(sys.argv)\nEOF; python x.py` → 述詞遇 import → 不 deny。

> lang 一律由**執行的直譯器**決定（不靠副檔名）：`cat > x.txt <<'EOF'…EOF; node x.txt` 仍以 js 判定。
> 殘留（已知、可接受）：以 `;`/newline 連接時，若寫入在 runtime 失敗（如目標路徑唯讀），EXEC 仍會跑
> 既有/不存在的檔，而本 pass 已先 deny——但「寫一段全 print 腳本緊接著執行它」這整條鏈**無論寫入成敗
> 都是偽裝意圖**，deny 仍為正確方向（`&&` 形式則連此殘留都無）；故不視為有意義的 false-deny。

### 4.6 向量 D（pipe 餵 stdin）詳述

向量 D 在 §4.2 的 source-order AST 走訪中、對**任何位置的 `Pipeline` 節點**判定（`checkVectorD`；pipe 內
資料流為節點內在、非跨敘述順序假設，故不限循序序列——亦與 A/B「任何位置」一致、無控制流包裝繞道）。
**函式遮蔽跳過（scope/order-aware）**：消費者直譯器名或生產者名 ∈ 當前 `defs`（此前同 shell 已定義）→ 跳過、
不 deny（回應 round 6/7）。**範圍可見性（回應 round 14 structural）**：pipeline 各段在 subshell 執行——走訪以
**當前 `defs` 的複本**進入各段，故**此前同 shell 的函式定義在段內可見**（`node(){:;}; echo … | node` 一致跳過），
但段內新定義**不洩漏回外層**。對每個 `Pipeline` 節點，
只處理形如**恰兩段** `producer | interpreter` 的 Pipeline（`Pipeline.commands.length === 2`；多段
`a | b | node` → 跳過、不 deny），且該 Pipeline statement 須**無下列改變語意的包裝，否則跳過、不 deny**：
- **背景/async** `producer | node &`、coproc → 跳過。
- **pipeline 整體掛載的 redirect**（如 `(producer | node) > f`、statement 級重導向影響整體）→ 跳過。
- **否定 `!` 不跳過**（回應 round 20 finding 1）：`!` 僅反轉退出碼、不改 producer→consumer stdin 流 →
  `! echo 'console.log("fake")' | node` 仍照常判向量 D → **deny**。
**兩段各為一個 `Statement`**，皆以 §4.2.2 的 `leafOf` 化約成 `{name, argv, redirects, cwd}`（任一段
`leafOf` 回 `null`，即該段非單一簡單 Command → 跳過、不 deny）：
- 右段（消費者）：先 `resolveExec`（§4.2.0；故 `echo … | timeout 5 node`、`… | command node` 亦涵蓋），
  透視後名 ∈ INTERPRETERS 且 `recognizeInterpreter` 回 `StdinRead(lang)`（無 script 檔/inline/副作用旗標）；
  外層 wrapper 名與內層名皆未被遮蔽（同 §4.2.0）。
- **消費端 fd0 不得有蓋過 pipe 的重導向**（cwd-aware 的 stdin 來源判定，回應 round 2 finding 2）：
  在 pipeline 中，消費者的 fd0 預設來自 pipe，**但**若消費者自身帶 fd0 輸入重導向（`< file` / `<<`heredoc
  / `<<<` / `<&n`），依「fd0 最後者勝」其有效 stdin 可能**不是** pipe。故須以 `staticStdinBody` 同款
  fd0 分析檢查消費者：**唯有消費者無任何 fd0 輸入重導向、有效 stdin 即為 pipe** 時，才取左段輸出為
  source；否則（fd0 被 `< file`/heredoc/fd-dup 蓋過）→ **跳過、不 deny**（該 case 落消費者自身既有判定，
  或其 heredoc 由向量 B 處理）。
- 左段（生產者）`leafOf` 為**靜態 print 生產者**：`echo`/`printf` 靜態（`isPrintOnlyForm` 為真且能還原
  輸出字串）或 `cat`/`tac` 靜態 heredoc/here-string。取其「輸出字串」＝餵給直譯器 stdin 的 source。
- `payloadIsAllStaticPrint(source, lang)` → deny。

> **與 `walk` 的關係**：閘④ 的 source-order 走訪不經 `walk`、不產生 `CommandInvocation`，而是直接對
> 每個 `Pipeline` 節點的兩個 `Statement` 各跑一次 `leafOf`（純讀 AST、§4.2.2）。`recognizeInterpreter`／
> 靜態生產者判定／`staticStdinBody` 皆為吃 `{name, argv, redirects}` 形狀的純函式，由**同一個 source-order
> 走訪**（四向量唯一資料來源）呼叫，無需改 `walk.ts`／`CommandInvocation`。
>
> 生產者「輸出字串」還原：echo＝argv 以空白接合（`-n`/`-e` 等語意過於複雜時保守跳過、不 deny）；printf
> 僅無格式化轉換符時可還原；cat/tac＝heredoc body。任何無法靜態還原 → 不 deny。

例：`echo 'console.log(1)' | node` → 左 echo 輸出 `console.log(1)`、右 node 無 fd0 重導向、StdinRead js
→ `true` → deny。`cat <<'EOF'\nprint("x")\nEOF | python` → deny。`grep x f | node` → 左非靜態生產者 →
不 deny。`echo x | node app.js` → 右段為 ScriptExec（非 StdinRead）→ 不屬向量 D（落向量 C／既有判定）。
`echo 'console.log("x")' | node < real.js` → 右 node 有 fd0 `< real.js` 蓋過 pipe（實際讀 `real.js`）→
**跳過、不 deny**。`echo … | node <<'EOF'…EOF` → 消費者 heredoc 為有效 stdin → 不取 pipe source（其
heredoc 另由向量 B 判）。

### 4.7 閘④ 接線（`src/engine/evaluate.ts`）

於閘②之後、閘③之前插入：

閘④ 為 §4.2 的單一 source-order AST 走訪，吃 `script` 與 `initialCwd`（自備 order-aware `definedBefore`，
不需外部 `fnNames`；`initialCwd` 供向量 C 沿循序序列 thread cwd 做 cwd-aware 路徑比對，§4.5）：

```ts
// 閘 ④（deny）：直譯器執行全靜態-print payload（四向量，source-order 走訪）——classify 前短路、不可升級
if (interpreterPrintSprayDeny(script, initialCwd)) {
  return { verdict: "deny", reason: interpreterPrintDenyReason() };
}
```

- 仍在既有 try/catch 內 → `interpreterPrintSprayDeny` 任何例外 → `evaluate` 收斂為 ask（fail-safe）。
- `script`、`initialCwd` 皆已是 `evaluate` 既有參數；閘④ 自走 AST、自算 `definedBefore`，**無新狀態穿透**。
- **與閘③ 的關係**：閘④ 仍列於閘③ 之前（保硬 deny 不被遮蔽降級），但對「**在該指令之前已定義函式**」
  而遮蔽的名自我跳過（order-aware）→ 該情形落閘③ 回不可升級 ask。閘③ 沿用既有 whole-script `fnNames`
  （over-ask、安全），與閘④ 的 order-aware `definedBefore` 各自獨立、互不影響。

### 4.8 deny 理由 helper（`src/rules/types.ts`）

```ts
/** 直譯器執行全靜態-print payload 偽裝驗證的 deny 理由（回饋給 agent）。 */
export function interpreterPrintDenyReason(): string {
  return `已禁止：你正用直譯器（node/python/deno/bun/ts-node）執行一段「每一行都只是 console.log/print ` +
    `印死字串」的程式——無論是 -e/-c inline、heredoc/pipe 餵 stdin、或先寫檔再執行同檔，內容都完全由你 ` +
    `事先寫死，沒讀任何檔、沒做任何真實計算或查證，等同把推論用程式口吻轉述、偽裝成「跑出來的驗證結果」。` +
    `若你已有結論，請直接寫在回覆文字中；若需查證第三方套件/程式行為，請實際讀取其原始碼、執行會真正 ` +
    `計算或讀檔的程式、或跑真實測試，而非用直譯器重述寫死的內容。`;
}
```

## 5. 威脅模型與邊界（明確界定 deny 完整性，避免「漏堵即漏放行」誤解）

本功能是疊加的**額外 deny 層**：把使用者列舉的常見直譯器-print 偽裝硬 deny，但**不追求攔截所有
繞道**；任何未被閘④命中的形式退回既有 classify 的 allow/ask。完整性界定：

### 5.1 已知、刻意接受的限制（退回 ask/既有判定，本功能不新增任何 allow 路徑）

1. **跨 Bash 呼叫拆分（本工具的根本架構邊界、非本功能特有；明確界定 shipped guarantee）**：本 hook
   **per-call、無狀態**——每次 Bash 呼叫獨立評估，**不**保存任何跨呼叫狀態（無檔案 taint、無 mtime 追蹤）。
   故凡「拆成兩次呼叫」的偽裝皆不在硬 deny 範圍：呼叫 1 `cat > /tmp/x.mjs <<'EOF'…EOF`（→ 不可升級 ask，
   寫入重導向）、呼叫 2 `node /tmp/x.mjs`（若使用者設 `Bash(node *)` → 升級 allow）。**此為本工具所有 deny
   類別共有的限制**（既有 print-only deny 同樣無法關聯呼叫 1 `echo 'fake' > f` 與呼叫 2 `cat f`），**非**
   本功能新增的弱點，也**非**本功能可在不引入持久狀態下解決者。**明確的 shipped guarantee：硬 deny 僅
   涵蓋「單一 Bash 呼叫鏈內」的寫檔→執行（向量 C）**；跨呼叫拆分維持既有 `permissions.allow` 語意（使用者
   自負）。新增跨呼叫 stateful tainting 屬本工具未採用的重大架構變更（無狀態為刻意設計），列為非目標
   （§2.2）。
2. **非範圍直譯器**：`bash -c`/`sh -c`/`eval`/`source`/`perl -e`/`ruby -e`/`php -r` → 維持既有可升級
   ask（§2.2）。
3. **動態 token**：直譯器名動態（`$CMD -e …`）、payload 動態（`-e "$CODE"`）、script 路徑動態、
   heredoc 未引號含展開 → 不可靜態判定 → 不 deny（退回 ask）。
4. **`-p`/`--print` 運算式吐值**、**多段 pipeline**（`a|b|node`）、**副作用旗標併用**（`node -r x -e …`）
   → 保守跳過、不 deny。
5. **間接寫檔/執行**：用 `tee`、`sed -n w`、`dd` 等非列舉寫檔形態，或經變數傳 path → 不 deny。
   - **向量 C 僅及「緊鄰循序-sibling」的寫→執行（明確、刻意的邊界；回應 round 16）**：WRITE 必須是 EXEC
     在**同一循序序列內的緊鄰前一個 sibling**。故**寫檔巢狀於控制流、再 `&&`/`;` 接執行**者——如
     `if cond; then cat > x.mjs <<'EOF'…EOF; fi && node x.mjs`、`{ … ; cat > x; } ; node x` 跨非循序邊界、
     或 `cat > x; echo hi; node x`（非緊鄰）——**不 deny**（退回 ask）。選擇此邊界的理由：緊鄰相鄰才能
     **靜態保證「被執行的內容＝該次寫入」** 且 **zero false-deny**；放寬到「控制流內任意前置寫」會引入
     分支可達性/最後寫者歧義。**安全性**：此 under-deny 與已無解的「跨 Bash 呼叫拆分」（item 1）同性質
     ——欲規避者本就能拆兩次呼叫；單一呼叫內的控制流包裝並未新增任何 allow 路徑（最差落既有 ask，依
     `Bash(node *)` 設定升級，使用者自負）。**inline/heredoc/pipe（向量 A/B/D）不受此限**，於任何位置
     （含控制流內）皆 deny；僅向量 C 的「寫→執行關聯」需此循序相鄰前提。
6. **副作用/預載旗標使 inline/stdin payload 失純（回應 round 5/17）**：`node -r ./pre.js -e '…'`、
   `python -m mod`、`deno eval --allow-read '…'` 等——預載/模組會注入額外執行碼，inline/stdin 的「純 print」
   前提不成立 → `Unknown`、不 deny。（**script 執行**不受此限：帶任何旗標的 `node … x.mjs`、
   `ts-node --transpile-only x.ts`、`deno run -A x.ts` 等，x 仍是被執行腳本 → 命中前驅 P 即 deny，§4.2.1。）
7. **繼承式 stdin（回應 round 8）**：bare `node`/`python`/`deno run -`/`bun run -`/`ts-node` 無 fd0 重導向、
   從**繼承 stdin** 讀碼 → hook 看不到 payload → 不 deny（落 ask，可被 `Bash(node *)` 升級）。只有靜態
   heredoc/here-string（向量 B）與可見 pipe（向量 D）在硬 deny 範圍（§4.4）。
8. **指令身分不確定（回應 round 14/19）**：(a) 直譯器/寫檔者帶**賦值前綴**（`PATH=… node -e …`、
   `LD_PRELOAD=…`）可改變指令解析 → 身分不確定 → **不 deny**。(b) **保留執行語意的 exec wrapper**
   （`command`/`nohup`/`nice`/`timeout`/`env`(無環境改變)/`setsid`/`stdbuf`）→ §4.2.0 **透視**後仍走 gate ④ →
   `timeout 5 node -e 'fake'`、`command node -e 'fake'` 等 **deny**（回應 round 19，閉合此繞道）。**殘留
   under-deny**：env 帶 `NAME=VAL`/`-i`（改環境）、未知 wrapper、wrapper 帶動態參數 → `Unknown`、不 deny
   （安全方向；與賦值前綴同理）。

> 上述 ask 多數**可被** `settingsAllows` 升級（使用者自設 `Bash(node *)` 等）——屬使用者自負的 settings
> 風險；本功能不新增此升級路徑，亦不硬擋這些繞道。被閘④命中的全靜態-print 形態則**不可**升級。

### 5.2 零誤 deny 保證（最重要）

§4.1 述詞 fail-safe：任何運算子/變數/呼叫/模板/import/控制流/未閉合/無法靜態還原 → `false`（不 deny）。
故所有「真實工作」payload（含算術、排序、格式轉換、讀檔、序列化驗證等）一律**不被 deny**，最差退回
既有 ask。deny 僅命中「純 printfn(字面量) 序列」這一窄形狀。

## 6. CLAUDE.md / 文件同步

- 「這是什麼」段：deny「三類」→「四類」，加入「④ 直譯器執行全靜態-print payload 偽裝」。
- 「核心不變量 / deny 三類」→「四類/四閘」：補閘④（evaluate 層、classify 前短路、不可由
  `permissions.allow` 解除）。
- 架構評估管線圖：在閘②後補閘④。
- 「已接受繞道」段的「巢狀直譯器（預設 ask、可升級）」：明確標註 **node/python/deno/bun/ts-node 的全
  靜態-print 子集現為硬 deny**；其真實運算 payload 與 `bash -c`/`eval`/`perl -e` 等仍維持可升級 ask。
- 補一行：跨呼叫拆分為已知 stateless 限制（§5.1）。

## 7. 測試與「誤 deny」稽核

### 7.1 `interp_print_test.ts`（述詞單元測試，deny 與不-deny 兩面 + 邊界）

- **deny（`true`）**：js 多行 `console.log("…")`；py 多行 `print("…")`；含 `//`/`#`/`/* */` 註解＋print；
  shebang＋print；`console.error`/`process.stdout.write`/`sys.stdout.write` 變體；多字面量逗號分隔；
  數字字面量 `console.log(42)`；同行 `print("a");print("b")`；**py 三引號 `print("""fake""")`/`print('''x''')`**；
  **js 無 `${` 模板 `` console.log(`fake`) ``**；**py 非-f 前綴 `print(r"raw")`/`print(b"x")`**（回應 round 13）。
- **不-deny（`false`）**：`console.log(1+1)`、`"a"+"b"`、`JSON.stringify(x)`、`sorted([…])`、`json.dumps`、
  變數 `console.log(x)`、**含 `${}` 模板 `` `${x}` ``**、**py f-string `print(f"{x}")`/`print(f"""{x}""")`**、
  `import`/`require`、`if`/`for`、賦值、未閉合括號/引號、空 payload、`console.log()`、`print("x", end="")`（kwargs `=`）。

### 7.2 向量整合測試（`evaluate_test.ts` 或 `interp_print_test.ts`）

- 向量 A：每直譯器 `-e`/`-c`/`deno eval` 全 print → deny；含運算 → ask。
- 向量 B：`node`/`python`/`bun run -`/`deno run -` heredoc-stdin 全 print → deny；`< file` → 不 deny；
  **bare `node`/`python`/`deno run -`/`bun run -`/`ts-node` 無 fd0 重導向（繼承 stdin）→ 不 deny**（回應
  round 8；落 ask，非硬 deny 範圍）。
- 向量 C（含順序感知，回應 round 1 design-soundness）：
  - **deny**：目標案例 `cat > /tmp/x.mjs <<'EOF'…EOF; node /tmp/x.mjs`（newline 緊鄰）；`&&` 連接
    `cat > x.mjs <<'EOF'…EOF && node x.mjs`；`echo 'console.log("x")' > f; node f`；寫專案內同理。
  - **不 deny（順序/邊界）**：`node x.mjs; cat > x.mjs <<'EOF'…EOF`（執行在寫之前）；
    `cat > x.mjs <<'EOF'…EOF; echo hi; node x.mjs`（非緊鄰前驅）；
    `cat > x.mjs <<'EOF'(real)EOF; cat > x.mjs <<'EOF'(print)EOF; node x.mjs`（最後緊鄰是 print → deny）
    與反序（最後緊鄰是 real → 不 deny）；含 import 的 body → 不 deny；path 不符 → 不 deny；
    寫/執行分屬不同 `if`/subshell 分支（非同一循序序列、無緊鄰）→ 不 deny。
  - **cwd（回應 round 2 finding 1）**：`cat > x.mjs <<'EOF'…EOF; cd other; node x.mjs` → 不 deny（前驅是
    cd）；`cd "$D"; cat > x.mjs <<'EOF'…EOF; node x.mjs`（cwd unknown）→ 跳過、不 deny；相對 vs 絕對
    路徑解析到不同目錄 → 不 deny。
  - **append / 背景（回應 round 4 findings）**：`echo 'console.log("x")' >> real.js; node real.js`（append `>>`）
    → **不 deny**（非截斷寫入，無法證明整檔皆 print）；`cat > x.mjs <<'EOF'…EOF & node x.mjs`（背景寫入）
    → **不 deny**（背景不保證寫入先完成）。
  - **控制流巢狀寫檔 `&&`-接執行（明確邊界，回應 round 16）**：`if cond; then cat > x.mjs <<'EOF'…EOF; fi
    && node x.mjs`、`{ cat > x.mjs <<'EOF'…EOF; } 跨非循序邊界後 node x.mjs` → **不 deny**（非緊鄰循序
    sibling；§5.1 item 5）。對照緊鄰 `cat > x.mjs <<'EOF'…EOF && node x.mjs` → deny。
  - **`&&` 成功閘控、恰兩-leg（回應 round 23/24）**：`cat > x.mjs <<'EOF'…EOF && node x.mjs`（恰 2 legs、
    `&&`）→ **deny**（airtight）；**以下皆**不 deny**（非恰兩-leg `&&`）**：`false && cat > x.mjs <<'EOF'…EOF
    && node x.mjs`（3 legs）、`cat > x.mjs <<'EOF'…EOF && false || node x.mjs`（含 `||`、混合）、
    `cat > x.mjs <<'EOF'…EOF && true && node x.mjs`（3 legs）、`false || cat > x.mjs <<'EOF'…EOF && node x.mjs`、
    `x && cat > x.mjs <<'EOF'…EOF && node x.mjs`；`false && cat > x.mjs <<'EOF'…EOF; node x.mjs`（`&&` 鏈後接
    `;`）→ node x 不 deny（prevWrite 不跨 `&&`/`||` 邊界外帶）。
- 向量 D：`echo 'console.log(1)' | node` → deny；`cat <<'EOF'…print…EOF | python` → deny；
  `grep x f | node` → 不 deny；`echo x | node app.js`（右為 ScriptExec）→ 不屬 D；多段 `a|b|node` → 不 deny。
  - **fd0 重導向（回應 round 2 finding 2）**：`echo 'console.log("x")' | node < real.js` → 不 deny（消費端
    fd0 被 `< real.js` 蓋過）；`echo … | node <<'EOF'…EOF` → 不取 pipe source（消費者 heredoc 為有效
    stdin）；`echo … | node 0<&3` fd-dup → 不 deny。
  - **包裝/邊界（回應 round 3/20）**：`echo 'console.log(1)' | node &`（背景）、
    `(echo 'console.log(1)' | node) > f`（pipeline 級重導向）→ 不 deny；**`! echo 'console.log(1)' | node`
    （否定）→ **deny**（`!` 不改資料流，回應 round 20 finding 1）**；`if true; then echo 'console.log(1)' |
    node; fi`（conditional 內的 pipe，無 (iii) 包裝）→ **deny**（向量 D 任何位置生效，回應 round 9）。
- 資源上限（per-payload，回應 round 3 + round 7 finding 2）：>64 KiB 或 >20000 token 的**個別** payload
  → 該 payload `false`、不 deny，但**其他候選照常掃描**；關鍵回歸：**大的不相符 heredoc/inline 在前 ＋
  小的相符 `node -e 'console.log("fake")'` 在後 → 仍 deny**（無全域 fail-open 抑制後續判定）。
- 繼承 heredoc fan-out memoize（回應 round 14 finding 2）：`{ node; node; …多次…; } <<'EOF' …大 body… EOF`
  → 同一 body 只 tokenize 一次（memoize）、總工作量不隨葉數放大。
- 指令身分（回應 round 14/19/20）：`PATH=$PWD/bin:$PATH node -e 'console.log("x")'`（賦值前綴）→ 不 deny；
  **`command node -e 'console.log("x")'`/`env node -e …`（無環境改變的 exec wrapper、無同名函式）→ 透視後
  **deny**（§4.2.0）**；`env X=1 node -e …`（改環境）→ 不 deny。**wrapper × 遮蔽（zero-false-deny，round 20↔21）**：
  `node(){:;}; timeout 5 node -e 'fake'`、`node(){:;}; export -f node; timeout 5 node -e 'fake'`（內層 node
  被遮蔽）→ **ask（非 deny）**；外層 `timeout(){:;}; timeout 5 node …`（wrapper 被遮蔽）→ ask。
- 直譯器辨識（inline 純度）：`node -r x -e 'console.log(1)'`、**`node -e 'console.log(1)' -r x`（預載旗標在
  inline 值之後，回應 round 24 advisory）**（inline + 預載旗標 → payload 失純）→ Unknown
  → 不 deny；`deno eval --allow-read 'console.log("x")'`（inline + 副作用）→ Unknown；裸/帶良性旗標
  `node --no-warnings -e 'console.log("x")'`、`deno eval 'console.log("x")'`、`python -i -c 'print("x")'`
  （-i 良性無值）→ deny；動態 `node -e "$C"` → 不 deny。
- exec wrapper 透視（回應 round 19/21）：`timeout 5 node -e 'console.log("fake")'`、`command node -e '…'`、
  `nohup python -c 'print("fake")'`、`nice -n 5 node -e '…'`（無同名函式）→ **deny**；**向量 D 經 wrapper**：
  `echo 'console.log(1)' | timeout 5 node`、`… | command node` → **deny**；**e2e**：含 `Bash(node *)`/
  `Bash(timeout *)` 時 `timeout 5 node -e '…'` 仍 **deny**（不經 settingsAllows）；`env X=1 node -e '…'`
  （改環境）、`foowrap node -e '…'`（未知 wrapper）→ 不 deny（under-deny）。
- script 執行旗標無關（回應 round 17）：`echo 'console.log("x")' > verify.ts; ts-node --transpile-only verify.ts`
  → **deny**；`… > x.mjs; node --experimental-default-type=module x.mjs` → **deny**；`… > x.ts; deno run -A x.ts`
  → **deny**（entrypoint=x、命中前驅 P）；對照路徑不符 `… > a.mjs; node b.mjs` → 不 deny。
- entrypoint vs 旗標值（回應 round 18 finding 1，**不得誤 deny**）：`echo 'console.log("setup")' > setup.js;
  node --require ./setup.js real-test.js` → entrypoint=real-test.js ≠ setup.js → **不 deny**（preload 值非
  entrypoint）；`… > x.mjs; node --unknownflag x.mjs`（未知旗標當帶值、吃掉 x.mjs）→ 無 entrypoint → 不 deny
  （安全 under-deny）。
- python `-m` 模組執行（回應 round 25，**不得誤 deny**）：`echo 'print("x")' > t.py; python -m pytest t.py`、
  `python -m unittest t.py`、`python -m pip install t.py` → `t.py` 為模組引數、非 entrypoint → **不 deny**。
- 函式遮蔽 scope + order-aware（回應 round 6/7/11）：
  - `node() { :; }; node -e 'console.log("x")'`（同 shell、def 在前）→ 跳過 → 閘③ **ask**。
  - `node -e 'console.log("fake")'; node() { :; }`（def 在後）→ 真 node 先執行 → **deny**（不被後置 def 降級）。
  - `if cond; then node(){:;}; fi; node -e 'fake'`（同 shell、條件分支內前置 def）→ 身分不確定 → 跳過 → ask。
  - **`(node(){:;}); node -e 'fake'`、`$(node(){:;}); node -e 'fake'`（def 在 subshell/替換內，不洩漏回父）
    → **deny**（回應 round 11，不被跨 scope 的假定義降級）。
  - **`if false; then node(){:;}; else node -e 'fake'; fi`（互斥 sibling 分支）→ **deny**（回應 round 12：
    then 分支的 def 以分支本地複本掃描、不洩漏到 else 分支）；對照 `if x; then node(){:;}; fi; node -e 'y'`
    （構造之後）→ ask。
  - `python`/`deno`/`bun`/`ts-node` 同理；向量 C `cat(){:;}; cat > x.mjs <<'EOF'…EOF; node x.mjs`（同 shell
    前置遮蔽 cat）→ 跳過 → ask；`(cat(){:;}); cat > x.mjs <<'EOF'…EOF; node x.mjs`（subshell cat 定義）→ deny。
- 控制流內 A/B（回應 round 9 finding 2，不再繞道）：`if true; then node -e 'console.log("x")'; fi`、
  `(node -e 'console.log("x")')`、`$(node -e 'console.log("x")')` → 向量 A 於任何位置生效 → **deny**；
  對照 `if true; then node(){:;}; fi; node -e 'x'`（控制流內前置 def）→ node ∈ definedBefore → 跳過 → ask。
- 函式體不下降（回應 round 22 finding 2）：`f(){ node -e 'console.log("fake")'; }`（只定義、未呼叫）→ **不 deny**
  （body 不執行）；`f(){ node -e 'console.log("fake")'; }; f`（呼叫）→ gate ④ 不解析函式體 → 落閘③（f 被
  呼叫且 ∈ fnNames）→ **不可升級 ask**；對照 `( node -e 'fake' )`（subshell body 會執行）→ deny。

### 7.3 不可升級 e2e（`main_test.ts`，子行程）

- settings `permissions.allow` 含 `Bash(node *)`／`Bash(python *)`：向量 A/B/C/D 全 print 仍 **deny**
  （證明閘④ 不經 settingsAllows）。
- 對照：`node -e 'console.log(JSON.stringify(x))'`＋`Bash(node *)` → **allow**（真實運算可升級，未被閘④
  命中），證明只擋全靜態-print 子集。

### 7.4 誤 deny 稽核清單

對映 §7.1 的「真實工作」範例清單（算術、`sorted`、混型別比較、格式轉換、`json.dumps`、讀檔計算）
逐一斷言 **非 deny**（ask 或 allow）。任一誤 deny 即視為 regression。

### 7.5 Operational verification（build 後）

`deno task build` 後餵痛點對應 JSON（`cat > /tmp/verify.mjs <<'EOF' …全 console.log 字面量… EOF` 接
`node /tmp/verify.mjs`）→ 期望 `deny`、`exit 0`、reason 為 `interpreterPrintDenyReason()`。另餵真實運算
版確認非 deny。

### 7.6 全綠

`deno task check && deno task lint && deno task test` 全綠。

## 8. 風險與邊界（多為已記錄、刻意接受的取捨）

- **向量 C「緊鄰前驅」的有意 under-deny**：只認 EXEC 緊鄰前一條為靜態寫同檔，故 `cat > x …; echo hi;
  node x`、寫/執行分屬不同控制流分支等非緊鄰形態**不 deny**（退回既有 ask）。這是為 zero false-deny 換取
  的保守取捨（§4.5）。
- **向量 C 以 `;`/newline 連接的 runtime 寫入失敗殘留（明確設計決策，非待修）**：design-soundness
  reviewer（round 3）主張此形態不該硬 deny（寫檔 runtime 失敗時 EXEC 跑既有/缺檔、且硬 deny 不可解除）。
  **使用者明確裁定維持硬 deny（2026-06-28）**：理由是「runtime 失敗是邊緣案例，重點是 agent **有意圖**這樣
  做、而非實際是否如此執行」。本工具的 deny 本就是**意圖/結構導向**（閘① 連 dead 分支的字面 `sleep` 都
  deny、閘② 依結構判 print-only）；「寫全 print 腳本緊接執行同檔」無正當用途，其結構即偽裝意圖，故依結構
  deny、不要求靜態證明寫檔成功。此為**有意接受、已記錄並覆寫 reviewer 建議**的取捨（`&&` 形式連此殘留
  都無；§4.5 已詳述不變量框架）。
- **同 shell 條件分支內的函式定義 → 降級為不可升級 ask（已記錄殘留）**：`if false; then node(){:;}; fi;
  node -e 'fake'` 中 node 實際未被遮蔽，但因不 const-eval 條件、保守視為「可能遮蔽」→ 跳過硬 deny、落閘③
  **不可升級 ask**（非 allow）。代價是 agent 可用假條件 def 把 deny 降為不可升級 ask；取捨：避免 round 9
  的「`if true` 真遮蔽卻誤 deny」、且 ask 仍非放行。subshell/替換內定義則因 scope-aware 不降級（仍 deny）。
- **ts-node `-` stdin** 未實機確認（research 註記）：保守僅以「無位置參數＋無旗標」配 heredoc/pipe
  觸發 StdinRead；若 ts-node 實際語意不同，最差是漏 deny（安全方向）。
- **詞法器 fragility**：手寫 tokenizer 對冷僻字串逸脫/多行構造可能誤判——但因 fail-safe，誤判方向恆為
  「不 deny」（漏 deny），不會誤 deny。測試需覆蓋逸脫與未閉合案例固化此性質。
- **效能**：閘④ 對每次 Bash 呼叫多一趟 source-order AST 走訪＋（命中直譯器時）一趟極小詞法；payload
  通常短，總工作量 O(指令長度)（§4.1 步驟 0），額外成本可忽略。
