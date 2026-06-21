import type { AssignmentPrefix, Redirect, Word } from "../deps.ts";
import type { CwdState } from "../types.ts";
import type { PathScope } from "../engine/scope.ts";
import type { UrlScope } from "../permissions/domain_scope.ts";

/** 由 CommandInvocation 投影建構；name 已確認非 null。 */
export interface RuleContext {
  name: string;
  argv: Word[];
  redirects: Redirect[];
  assignments: AssignmentPrefix[];
  cwd: CwdState;
  /** 對某參數做範圍檢查（內部已綁定 cwd 與 root）。 */
  resolvePath(arg: Word): PathScope;
  /** 對 flag 的路徑值（字串）做範圍檢查。 */
  resolvePathValue(value: string | null): PathScope;
  /** 對 URL 字串做網域範圍三態判定（內部已綁定 settings 的 WebFetch 規則與 preapproved 清單）。 */
  resolveUrl(value: string): UrlScope;
  /** 此參數是否指向磁碟根 / 家目錄根（用於遞迴指令的 deny 判定）。 */
  isDangerousRoot(arg: Word): boolean;
}

export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
}

/** 便利建構子。 */
export const allow = (): RuleVerdict => ({ kind: "allow" });
export const ask = (reason: string): RuleVerdict => ({ kind: "ask", reason });
export const deny = (reason: string): RuleVerdict => ({ kind: "deny", reason });

/** 產生「遞迴遍歷磁碟根/家目錄根」的 deny 理由（會回饋給 agent，故須解釋原因 + 替代）。 */
export function recursiveRootDenyReason(name: string, target: string): string {
  return `已禁止：${name} 會遞迴遍歷磁碟根或家目錄根（${target}）。` +
    `此操作會掃描跨專案、跨使用者的大量檔案，屬資料外洩 / 偵察的高風險行為。` +
    `請改為指定專案內的具體子目錄（例如 ./src），而非 / 或 ~。`;
}

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
