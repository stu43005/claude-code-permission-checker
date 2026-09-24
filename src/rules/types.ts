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
  /**
   * glob 路徑操作元的範圍判定（前綴目錄須以目錄形式被涵蓋）。
   * 選填；未提供時呼叫端視同 "dynamic"（fail-closed → ask）。classify 永遠提供。
   */
  resolveGlobPath?(arg: Word): PathScope;
  /**
   * glob 操作元是否可能選中磁碟根 / 家目錄根。
   * 選填；未提供時呼叫端視同 true（fail-closed → deny）。classify 永遠提供。
   */
  globMaySelectDangerousRoot?(arg: Word): boolean;
}

export type RuleVerdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface CommandRule {
  /** 此規則涵蓋的指令名（含別名）。 */
  names: string[];
  evaluate(ctx: RuleContext): RuleVerdict;
  /**
   * 此次呼叫的安全判定是否與 cwd 無關，需同時滿足：
   *  (a) 不以 cwd 相對路徑讀取檔案；
   *  (b) 不隱含以 cwd 為操作對象（如 ls / find 無操作元時作用於 cwd）；
   *  (c) 安全判定所依據的資訊不取決於 shell 對 cwd 的 glob 展開結果。
   * (c) 是「判定不依賴展開結果」，不是「不含 glob 元字元」。
   * 未宣告 = 否（default-deny）。必須為純函式、不得有副作用。
   */
  cwdIndependent?(ctx: RuleContext): boolean;
  /**
   * 此次呼叫是否僅含一種非靜態 token：本工具的判定完全不讀其內容的操作元
   * （目前只有 gh api 的 endpoint）。其餘 token 必須皆為靜態。必須為純函式。
   */
  toleratesNonStaticOperand?(ctx: RuleContext): boolean;
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

/** sleep 輪詢 / 等待的 deny 理由（回饋給 agent）。 */
export function pollingDenyReason(): string {
  return `已禁止：sleep 用於輪詢 / 等待，本工具的唯讀情境下無正當用途，且背景工作完成時 harness ` +
    `會自動以 task-notification 重新喚醒你，不需主動等待。若需排程下次喚醒，請改用 ScheduleWakeup，` +
    `不要用 Bash sleep 輪詢。`;
}

export type PrintDisguiseKind =
  | "shell-print" | "interp-inline" | "write-exec" | "cat-readback" | "pipe";

/** 統一 print-only 載具偽裝的 deny 理由（依命中形態客製）。 */
export function printDisguiseDenyReason(kind: PrintDisguiseKind): string {
  const head: Record<PrintDisguiseKind, string> = {
    "shell-print": "整條指令每段都只是 echo/printf/cat 把靜態文字印到 stdout",
    "interp-inline": "你正用直譯器（-e/-c/-p inline 或 heredoc 餵 stdin）跑一段每行都只是 console.log/print 印死字串的程式",
    "write-exec": "你先把寫死文字寫進暫存檔、再用直譯器執行同檔把它印出來",
    "cat-readback": "你先把寫死文字寫進暫存檔、再 cat 讀回印出——與直接 echo 無異",
    "pipe": "你把寫死文字 pipe 給直譯器印出來",
  };
  return `已禁止：${head[kind]}。內容完全寫死、沒讀檔沒計算——偽裝成跑出來的驗證結果。` +
    `若你已有結論，請直接寫在回覆文字中；若需查證，請實際讀原始碼、跑會真正計算/讀檔的程式或真實測試。`;
}

/** 名稱重定義（函式定義 / alias 類）的 deny 理由。 */
export function nameRedefinitionDenyReason(kind: "function" | "alias"): string {
  if (kind === "function") {
    return `已禁止：這個指令定義了 shell 函式（name(){…}）。函式可重定義任何指令名（如 grep(){ rm -rf; }）、` +
      `使本工具的指令名安全分析失真，屬危險構造；在單次 Bash 呼叫內定義函式無正當常見理由。` +
      `若需複用邏輯，請直接展開為具體指令、或拆成多次呼叫。`;
  }
  return `已禁止：這個指令用 alias/unalias/shopt -s expand_aliases 改變指令名的解析，可讓後續 grep/cat 等` +
    `執行成別的東西、繞過本工具的指令名安全分析。請勿在 Bash 呼叫內設定 alias；直接用真實指令名。`;
}
