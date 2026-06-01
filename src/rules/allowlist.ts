import type { CommandRule } from "./types.ts";
import { cdRule, diffRule, fileReaderRule, pureUtilRule } from "./commands/coreutils.ts";
import { sedRule } from "./commands/sed.ts";
import { awkRule } from "./commands/awk.ts";
import { findRule } from "./commands/find.ts";
import { dateRule, fileCmdRule, sortRule, treeRule, yqRule } from "./commands/simple-flag.ts";
import { uniqRule, xxdRule } from "./commands/positional-output.ts";
import { grepRule } from "./commands/grep.ts";
import { gitRule } from "./commands/git.ts";
import { denoRule } from "./commands/deno.ts";
import { ghRule } from "./commands/gh.ts";

const RULES: CommandRule[] = [
  fileReaderRule,
  diffRule,
  pureUtilRule,
  cdRule,
  sedRule,
  awkRule,
  findRule,
  sortRule,
  yqRule,
  treeRule,
  fileCmdRule,
  dateRule,
  xxdRule,
  uniqRule,
  grepRule,
  gitRule,
  denoRule,
  ghRule,
];

const INDEX = new Map<string, CommandRule>();
for (const rule of RULES) {
  for (const name of rule.names) {
    if (INDEX.has(name)) throw new Error(`duplicate rule for command: ${name}`);
    INDEX.set(name, rule);
  }
}

/** 取得指令對應的規則；未列入 allowlist → undefined。 */
export function lookupRule(name: string): CommandRule | undefined {
  return INDEX.get(name);
}
