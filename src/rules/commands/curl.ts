import type { CommandRule, RuleContext, RuleVerdict } from "../types.ts";
import { allow, ask } from "../types.ts";
import { staticValue } from "../../engine/word.ts";

// 安全集合採 allowlist：未列入的旗標一律 ask（誤 ask 可接受、誤 allow 不可接受）。
// 寫檔（-o/-O/--output*）、非 GET（-X/-d/-F/-T）、憑證（-u/--netrc/-K）、路由
// （-x/--resolve/--connect-to）等皆不在集合內，自然 ask。
const SAFE_LONG_NOVAL = new Set([
  "--silent",
  "--show-error",
  "--fail",
  "--fail-with-body",
  "--location",
  "--head",
  "--include",
  "--get",
  "--verbose",
  "--ipv4",
  "--ipv6",
  "--compressed",
  "--globoff", // 僅相容性：不放寬 resolveUrl 的 {}[] 攔截
  "--no-progress-meter",
  "--http1.1",
  "--http2",
]);
const SAFE_SHORT_NOVAL = new Set(["s", "S", "f", "L", "I", "i", "G", "v", "4", "6", "g"]);
const SAFE_LONG_VAL = new Set([
  "--max-time",
  "--connect-timeout",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--max-redirs",
  "--user-agent",
  "--referer",
]);
const SAFE_SHORT_VAL = new Set(["m", "A", "e"]);

/** -H/--header 值檢查：靜態字串安全；@- 安全；@file 走讀取範圍；其餘 ask。 */
function checkHeaderValue(ctx: RuleContext, value: string): RuleVerdict | null {
  if (!value.startsWith("@")) return null;
  if (value === "@-") return null; // 讀 stdin，無檔案存取
  const scope = ctx.resolvePathValue(value.slice(1));
  if (scope !== "in-project") {
    return ask("curl：-H @file 路徑超出允許範圍或無法解析");
  }
  return null;
}

export const curlRule: CommandRule = {
  names: ["curl"],
  evaluate(ctx: RuleContext): RuleVerdict {
    const argv = ctx.argv;
    const urls: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const t = staticValue(argv[i]);
      if (t === null) return ask("curl：動態參數無法判定");

      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        const name = eq === -1 ? t : t.slice(0, eq);
        const inline = eq === -1 ? null : t.slice(eq + 1);
        if (SAFE_LONG_NOVAL.has(name)) {
          if (inline !== null) return ask(`curl：旗標 ${name} 不應帶值`);
          continue;
        }
        if (SAFE_LONG_VAL.has(name) || name === "--header" || name === "--url") {
          let value: string;
          if (inline !== null) {
            value = inline;
          } else {
            i++;
            if (i >= argv.length) return ask(`curl：${name} 缺少值`);
            const v = staticValue(argv[i]);
            if (v === null) return ask(`curl：${name} 的值為動態`);
            value = v;
          }
          if (name === "--header") {
            const verdict = checkHeaderValue(ctx, value);
            if (verdict) return verdict;
          } else if (name === "--url") {
            urls.push(value);
          }
          continue;
        }
        return ask(`curl：未列入安全集合的旗標 ${name}`);
      }

      if (t.startsWith("-") && t !== "-") {
        // 聚合短旗標逐字母掃描（區分大小寫）；吃值字母後同 token 剩餘字元為值，
        // 剩餘為空則下一個 argv token 為值（並從 URL 候選排除）。
        let handled = false;
        for (let j = 1; j < t.length; j++) {
          const c = t[j];
          if (SAFE_SHORT_NOVAL.has(c)) continue;
          if (SAFE_SHORT_VAL.has(c) || c === "H") {
            const rest = t.slice(j + 1);
            let value: string;
            if (rest !== "") {
              value = rest;
            } else {
              i++;
              if (i >= argv.length) return ask(`curl：-${c} 缺少值`);
              const v = staticValue(argv[i]);
              if (v === null) return ask(`curl：-${c} 的值為動態`);
              value = v;
            }
            if (c === "H") {
              const verdict = checkHeaderValue(ctx, value);
              if (verdict) return verdict;
            }
            handled = true;
            break; // 值吃掉剩餘字元，掃描即止
          }
          return ask(`curl：未列入安全集合的旗標 -${c}`);
        }
        void handled;
        continue;
      }

      // 位置參數 = URL（`-` 會解析失敗 → invalid → ask，符合保守方向）
      urls.push(t);
    }

    if (urls.length === 0) return ask("curl：未發現 URL");
    for (const u of urls) {
      if (ctx.resolveUrl(u) !== "allowed") {
        return ask(`curl：URL 不在允許網域或形式不安全（${u}）`);
      }
    }
    return allow();
  },
};
