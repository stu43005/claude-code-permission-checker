// 直譯器 payload 述詞：判定一段 source 是否「整段只是一條以上的 print 敘述印死字串」。
// 手寫 fail-safe tokenizer + 文法比對；任何不確定一律回 false（不 deny）。

export type Lang = "js" | "py";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOKENS = 20000;

type TokKind = "STRING" | "NUMBER" | "NAME" | "PUNCT" | "SIGN" | "SEP" | "DYNAMIC" | "OTHER";
interface Tok {
  kind: TokKind;
  value: string;
}

const TEXT_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["console.log", "console.info", "console.warn", "console.error", "console.debug"]),
  py: new Set(["print"]),
};
const WRITE_PRINT_FNS: Record<Lang, Set<string>> = {
  js: new Set(["process.stdout.write", "process.stderr.write"]),
  py: new Set(["sys.stdout.write", "sys.stderr.write"]),
};

const NAME_START = /[A-Za-z_$]/;
const NAME_CONT = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

// UTF-8 位元組長度（DoS 上限用；有界，超標即回值 > 上限）。
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

function tokenize(src: string, lang: Lang): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (t: Tok) => { out.push(t); };
  while (i < n) {
    if (out.length > MAX_TOKENS) return null;
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") {                                    // 換行 = 敘述分隔符（去重）
      if (out.length > 0 && out[out.length - 1].kind !== "SEP") push({ kind: "SEP", value: "\n" });
      i++;
      continue;
    }
    if (c === "#" && src[i + 1] === "!" && (i === 0 || src[i - 1] === "\n")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (lang === "py" && c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (lang === "js" && c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= n) return null;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && lang === "js")) {   // 反引號模板僅 js
      const r = readString(src, i, lang);
      if (r === null) return null;
      push({ kind: r.dynamic ? "DYNAMIC" : "STRING", value: "" });
      i = r.next;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i;
      if (src[j] === "0" && /[xXoObB]/.test(src[j + 1] ?? "")) {
        const base = src[j + 1].toLowerCase();
        const cls = base === "x" ? /[0-9a-fA-F_]/ : base === "o" ? /[0-7_]/ : /[01_]/;  // 依基底限定數字
        j += 2;
        const s = j;
        while (j < n && cls.test(src[j])) j++;
        if (j === s) return null;                          // 基底前綴後無合法數字（0x_/0b2/0o9）→ 非法
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;         // 整數部
        if (src[j] === ".") { j++; while (j < n && /[0-9_]/.test(src[j])) j++; } // 小數
        if (src[j] === "e" || src[j] === "E") {             // 指數（可帶號）
          let k = j + 1;
          if (src[k] === "+" || src[k] === "-") k++;
          if (DIGIT.test(src[k] ?? "")) { j = k; while (j < n && /[0-9_]/.test(src[j])) j++; }
        }
      }
      if (lang === "js" && src[j] === "n") j++;             // BigInt 僅 js
      push({ kind: "NUMBER", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && (NAME_CONT.test(src[j]) || (src[j] === "." && NAME_CONT.test(src[j + 1] ?? "")))) j++;
      const nameVal = src.slice(i, j);
      // py 字串前綴：**必須緊鄰引號、無空白**（`f"…"` / `r'…'`）。f → DYNAMIC；r/b → STRING。
      if (lang === "py" && /^(f|F|r|b|rb|br|R|B)$/.test(nameVal) && (src[j] === '"' || src[j] === "'")) {
        const rr = readString(src, j, lang);
        if (rr === null) return null;
        push({ kind: /^[fF]$/.test(nameVal) ? "DYNAMIC" : "STRING", value: "" });
        i = rr.next;
        continue;
      }
      push({ kind: "NAME", value: nameVal });
      i = j;
      continue;
    }
    if (c === "+" || c === "-") { push({ kind: "SIGN", value: c }); i++; continue; }
    if (c === "(" || c === ")" || c === "," || c === ";") { push({ kind: "PUNCT", value: c }); i++; continue; }
    push({ kind: "OTHER", value: c });
    i++;
  }
  return out;
}

function readString(src: string, start: number, lang: Lang): { next: number; dynamic: boolean } | null {
  const n = src.length;
  const quote = src[start];
  if (quote === "`" && lang === "js") {
    let i = start + 1;
    let dynamic = false;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") return { next: i + 1, dynamic };
      if (src[i] === "$" && src[i + 1] === "{") dynamic = true;
      i++;
    }
    return null;
  }
  if (lang === "py" && (quote === '"' || quote === "'") && src[start + 1] === quote && src[start + 2] === quote) {
    const triple = quote.repeat(3);
    let i = start + 3;
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src.startsWith(triple, i)) return { next: i + 3, dynamic: false };
      i++;
    }
    return null;
  }
  let i = start + 1;
  while (i < n) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return { next: i + 1, dynamic: false };
    if (src[i] === "\n") return null;   // 一般（非三引號）字串不可跨行（js/py 皆然）
    i++;
  }
  return null;
}

// 消費一個 ARG：STRING，或（僅文字輸出 API）選擇性 SIGN + NUMBER。回下一個索引或 -1（不合法）。
// SIGN 只對 NUMBER 合法（不允許 -"x" 這種帶號字串）。
function consumeArg(toks: Tok[], i: number, textApi: boolean): number {
  if (toks[i]?.kind === "SIGN") {
    if (textApi && toks[i + 1]?.kind === "NUMBER") return i + 2;
    return -1;
  }
  const k = toks[i]?.kind;
  if (k === "STRING") return i + 1;
  if (k === "NUMBER" && textApi) return i + 1;
  return -1;
}

export function payloadIsAllStaticPrint(source: string, lang: Lang): boolean {
  if (byteLen(source) > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = raw;   // 前綴/模板動態性已於 tokenize 處理
  const textFns = TEXT_PRINT_FNS[lang];
  const writeFns = WRITE_PRINT_FNS[lang];

  let i = 0;
  let stmts = 0;
  const n = toks.length;
  while (toks[i]?.kind === "SEP") i++;               // 跳過前導分隔
  while (i < n) {
    const fn = toks[i];
    if (fn.kind !== "NAME") return false;
    const isText = textFns.has(fn.value);
    const isWrite = writeFns.has(fn.value);
    if (!isText && !isWrite) return false;
    i++;
    if (toks[i]?.value !== "(") return false;
    i++;
    if (toks[i]?.value === ")") return false;        // 無引數
    let j = consumeArg(toks, i, isText);
    if (j < 0) return false;
    i = j;
    while (toks[i]?.value === ",") {
      i++;
      j = consumeArg(toks, i, isText);
      if (j < 0) return false;
      i = j;
    }
    if (toks[i]?.value !== ")") return false;
    i++;
    stmts++;
    // 敘述間必須有分隔符（`;` 或換行 SEP）；消費之
    let sep = false;
    while (toks[i]?.value === ";" || toks[i]?.kind === "SEP") { sep = true; i++; }
    if (i < n && !sep) return false;                 // 兩敘述緊貼、無分隔 → 非法
  }
  return stmts >= 1;
}

export function printExprIsStaticString(source: string, lang: Lang): boolean {
  if (byteLen(source) > MAX_PAYLOAD_BYTES) return false;
  const raw = tokenize(source, lang);
  if (raw === null) return false;
  const toks = raw;   // 前綴/模板動態性已於 tokenize 處理
  if (toks.length === 0) return false;
  let i = 0;
  if (toks[i]?.kind !== "STRING") return false;
  i++;
  while (i < toks.length) {
    if (toks[i]?.kind !== "SIGN" || toks[i]?.value !== "+") return false;  // `+` 詞法為 SIGN
    i++;
    if (toks[i]?.kind !== "STRING") return false;
    i++;
  }
  return true;
}
