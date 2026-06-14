import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask, deny, recursiveRootDenyReason } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

const ACTION_FLAGS = new Set<string>([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

export const findRule: CommandRule = {
  names: ["find"],
  evaluate(ctx: RuleContext): RuleVerdict {
    // 起始路徑 = 第一個以 - 開頭的 token 之前的所有非 flag 位置參數
    const starts = [];
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t !== null && t.startsWith("-")) break;
      starts.push(w);
    }
    // 偵測寫檔 / 執行 action
    for (const w of ctx.argv) {
      const t = staticValue(w);
      if (t !== null && ACTION_FLAGS.has(t)) {
        return ask(`find：${t} 會寫檔或執行外部指令`);
      }
    }
    // 遞迴遍歷磁碟根 / 家目錄根（find 預設遞迴）→ deny
    for (const s of starts) {
      if (ctx.isDangerousRoot(s)) {
        return deny(recursiveRootDenyReason("find", s.value));
      }
    }
    for (const s of starts) {
      if (ctx.resolvePath(s) !== "in-project") {
        return ask(`find：起始路徑超出專案範圍或無法解析（${s.value}）`);
      }
    }
    return allow();
  },
};
