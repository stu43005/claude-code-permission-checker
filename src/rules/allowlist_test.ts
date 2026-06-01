import { assertEquals } from "@std/assert";
import { lookupRule } from "./allowlist.ts";

Deno.test("known commands resolve to a rule", () => {
  for (const name of ["cat", "echo", "cd", "sed", "awk", "find", "sort", "yq", "tree", "file", "date", "xxd", "uniq", "grep", "rg", "git", "diff"]) {
    assertEquals(lookupRule(name) !== undefined, true, `expected rule for ${name}`);
  }
});

Deno.test("excluded / unknown commands resolve to undefined", () => {
  for (const name of ["rm", "mv", "mkdir", "less", "npm", "bash", "tee", "xargs"]) {
    assertEquals(lookupRule(name), undefined, `expected no rule for ${name}`);
  }
});
