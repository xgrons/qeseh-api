// Pure-JS decoder for the Dean Edwards "eval(function(p,a,c,k,e,d){...}(...))" packer.
// No eval(), no vm — safe to run on untrusted remote HTML.
//
// Packed form: a small "runner" function is called with 4 args:
//   p = packed payload string (tokens are base-`a` numbers, e.g. "1.2.k")
//   a = radix (the alphabet size the tokens are encoded in)
//   c = token count
//   k = '|'-separated dictionary, k.split('|')[i] is the replacement for token i
// The runner walks p and replaces every occurrence of each base-`a` number i
// (as a whole word) with k[i] (or leaves the literal token if k[i] is empty).
// We don't need to run the runner's exact source — we can reimplement the
// well-known algorithm directly against the 4 arguments we parse out.

function skipQuote(s, j) {
  const q = s[j];
  j++;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; } // skip escaped char without testing it against q
    if (s[j] === q) return j + 1;
    j++;
  }
  return j;
}

// Balanced scan for a matching closer, quote-aware. opener/closer are single chars.
function scanBalanced(s, start, opener, closer) {
  let depth = 0;
  for (let k = start; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'" || ch === '"') { k = skipQuote(s, k) - 1; continue; }
    else if (ch === opener) depth++;
    else if (ch === closer) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

// base-36-ish digit set used by the packer (0-9, a-z, A-Z, ...) — matches how
// browsers' Number.prototype.toString(radix) encodes for radix up to 62-ish.
// The packer itself only ever needs up to the JS toString(36) alphabet in
// practice (radix <= 36), so we decode with that; higher radixes fall back
// to parseInt/toString which both agree on 0-9a-z for radix <= 36.
function baseDecode(token, radix) {
  return parseInt(token, radix);
}

// Split "'a|b|c|...'.split('|')" (or a bare array literal) into the dictionary array
// without eval. We only need the string literal contents between the outer quotes,
// which is always what the packer emits.
function parseDictionaryLiteral(src) {
  const s = src.trim();
  const m = s.match(/^(['"])([\s\S]*)\1\s*\.split\(\s*(['"])\|\3\s*\)$/);
  if (m) return unescapeJsString(m[2]).split('|');
  // Fallback: bare quoted string without an explicit .split('|') wrapper.
  const m2 = s.match(/^(['"])([\s\S]*)\1$/);
  if (m2) return unescapeJsString(m2[2]).split('|');
  throw new Error('unrecognized packer dictionary literal');
}

function unescapeJsString(s) {
  return s.replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

// Parse the packer's call arguments "(p, a, c, k)" where p and k are string
// literals and a, c are integer literals (c may itself be an arithmetic
// expression like c || 3 in some variants, but the common packer emits a
// plain literal — we handle the plain literal case, which covers this site).
function parseCallArgs(callSrc) {
  const inner = callSrc.trim().replace(/^\(/, '').replace(/\)$/, '');
  // Split top-level commas (quote/paren aware).
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuote(inner, i);
      cur += inner.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  if (parts.length < 4) throw new Error('expected 4 packer args, got ' + parts.length);

  const pLit = parts[0].trim();
  const pm = pLit.match(/^(['"])([\s\S]*)\1$/);
  if (!pm) throw new Error('packer payload arg is not a string literal');
  const p = unescapeJsString(pm[2]);

  const a = parseInt(parts[1].trim(), 10);
  const c = parseInt(parts[2].trim(), 10);
  const k = parseDictionaryLiteral(parts[3]);

  return { p, a, c, k };
}

// Reimplementation of the packer's unpacking loop: replace every whole-word
// token in `p` with k[baseDecode(token, a)] when that dictionary slot is
// non-empty, else leave the token as-is. Tokens are matched longest-first
// isn't needed because the packer's own runner uses a word-boundary regex;
// we do the same via \b\w+\b.
function unpackWithArgs(p, a, c, k) {
  return p.replace(/\b\w+\b/g, (tok) => {
    const i = baseDecode(tok, a);
    if (Number.isNaN(i) || i < 0 || i >= c) return tok;
    const rep = k[i];
    return rep ? rep : tok;
  });
}

// Find every `eval(function(p,a,c,k,e,d){...}(...))` chunk in `html`, decode
// it without eval, and return the decoded bodies joined by newlines (mirrors
// the previous unpackEval() behavior/signature).
function unpackEval(html) {
  const MARK = 'eval(function(p,a,c,k,e,d)';
  const out = [];
  let pos = 0;
  for (;;) {
    const at = html.indexOf(MARK, pos);
    if (at < 0) break;
    pos = at + MARK.length;

    // Find the '(' that opens eval(...).
    let j = at + 4;
    while (j < html.length && html[j] !== '(') j++;
    const end = scanBalanced(html, j, '(', ')');
    if (end < 0) break;

    const inner = html.slice(j + 1, end); // function(p,a,c,k,e,d){body}(args)
    const fnEnd = scanBalanced(inner, inner.indexOf('{'), '{', '}');
    if (fnEnd < 0) continue;

    const callSrc = inner.slice(fnEnd + 1).trim(); // "(args)"
    try {
      const { p, a, c, k } = parseCallArgs(callSrc);
      out.push(unpackWithArgs(p, a, c, k));
    } catch {
      // skip broken/unrecognized chunk, same as the previous eval-based unpacker
    }
  }
  return out.join('\n');
}

module.exports = { unpackEval, unpackWithArgs, parseCallArgs };
