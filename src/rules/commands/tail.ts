import type { CommandRule } from "../types.ts";
import type { FlagMatcher } from "../flags.ts";
import { exact, prefix } from "../flags.ts";
import { flagGatedReader } from "../factory.ts";

/** 短旗標群集含 f / F（如 -fn、-Fq、-fn10），代表 follow 模式。允許群集尾端帶數字（-fn10 = -f -n 10）。 */
const shortClusterHasF: FlagMatcher = (t) =>
  /^-[A-Za-z0-9]+$/.test(t) && /[fF]/.test(t.slice(1));

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  askFlags: [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF],
  valueFlags: [exact("-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats")],
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
});
