import type { CommandRule } from "../types.ts";
import type { FlagMatcher } from "../flags.ts";
import { exact, prefix } from "../flags.ts";
import { flagGatedReader } from "../factory.ts";
import type { CommandSpec, FlagSpec } from "../command_spec.ts";

/** 短旗標群集含 f / F（如 -fn、-Fq、-fn10），代表 follow 模式。允許群集尾端帶數字（-fn10 = -f -n 10）。 */
const shortClusterHasF: FlagMatcher = (t) =>
  /^-[A-Za-z0-9]+$/.test(t) && /[fF]/.test(t.slice(1));

/** follow 模式（-f / -F / --follow / --retry，含群集）一律不豁免。 */
const followFlags = [exact("-f", "-F", "--follow", "--retry"), prefix("--follow="), shortClusterHasF];

const TAIL_SPEC: CommandSpec = {
  flags: [
    ...["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated", "-f", "-F", "--follow", "--retry"]
      .map((name): FlagSpec => ({ name, value: "none" })),
    ...["-n", "--lines", "-c", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats"]
      .map((name): FlagSpec => ({ name, value: "required" })),
  ],
  positionals: "paths",
  numericShorthand: true, // tail -200
};

export const tailRule: CommandRule = flagGatedReader({
  names: ["tail"],
  spec: () => TAIL_SPEC,
  askFlags: followFlags,
  askReason: () => "tail：-f / --follow 會持續跟隨（無界等待 / 輪詢）",
  cwdIndependentWhenNoPaths: true,
  // 述詞的額外前置條件：從**同一份解析結果**讀 follow 旗標，不另外掃 argv
  cwdIndependentExtraGuard: (p) =>
    !["-f", "-F", "--follow", "--retry"].some((f) => p.seenFlags.has(f)),
});
