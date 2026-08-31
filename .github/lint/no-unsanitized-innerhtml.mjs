// .github/lint/no-unsanitized-innerhtml.mjs
//
// CI lint rule: flags any `el.innerHTML = `...${...}...\`` template-literal
// assignment that does NOT go through the `safeHtml` tagged-template helper.
//
// Rationale: a previous content.js XSS slipped through because `e.type` was
// interpolated into innerHTML without escaping. The pattern repeats across
// 6+ sites in content.js alone. This rule makes the next occurrence a build
// failure instead of a CVE.
//
// Usage:
//   node .github/lint/no-unsanitized-innerhtml.mjs <file1.js> [file2.js ...]
//
// Exits 0 on clean, 1 on any violation, 2 on usage error.

import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const VIOLATION = (line, file, snippet) =>
  `  ${file}:${line}  ${snippet}`;

function stripComments(src) {
  // Remove comments while preserving string literal content intact.
  // Handles: block comments /*...*/, line comments //...,
  // double-quoted strings, single-quoted strings, and template literals.
  // Without string state, `/*...*/` inside a string would be stripped and
  // `"https://x"` (a URL in a string) would be mangled to `"https:`.
  let out = "";
  let i = 0;
  const n = src.length;
  let inStr = false;    // "..." or '...'
  let inTemplate = false; // `...` (template literal)
  let templateDepth = 0;
  let strChar = "";

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Escape: skip next character unconditionally.
    if (c === "\\") { out += c + (src[i + 1] || ""); i += 2; continue; }

    // Enter/exit double-quoted string.
    if (!inTemplate && c === '"') { inStr = true; strChar = '"'; out += c; i++; continue; }
    if (!inTemplate && inStr && c === '"') { inStr = false; strChar = ""; out += c; i++; continue; }

    // Enter/exit single-quoted string.
    if (!inTemplate && !inStr && c === "'") { inStr = true; strChar = "'"; out += c; i++; continue; }
    if (!inTemplate && inStr && c === "'" && strChar === "'") { inStr = false; strChar = ""; out += c; i++; continue; }

    // Enter template literal.
    if (!inStr && c === "`") {
      if (!inTemplate) { inTemplate = true; templateDepth = 0; }
      else { templateDepth++; }
      out += c; i++; continue;
    }

    // Close template literal — but only if not inside ${...}.
    if (inTemplate && c === "`") {
      if (templateDepth === 0) { inTemplate = false; }
      else { templateDepth--; }
      out += c; i++; continue;
    }

    // Inside template: ${...} doesn't affect template depth tracking for the
    // outer backtick (we only count nested backticks). We pass through all
    // chars inside the template unchanged — no comment stripping needed there.
    if (inTemplate) { out += c; i++; continue; }

    // Inside a string literal: pass through (no comment processing).
    if (inStr) { out += c; i++; continue; }

    // Block comment.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Line comment.
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

function checkFile(path) {
  const src = readFileSync(path, "utf8");
  const violations = [];

  // Strip comments before analysis so JSDoc and line comments are invisible.
  const code = stripComments(src);

  // Match: .innerHTML = `...${...}...`
  // We flag template literals (backticks) that have interpolation.
  // Allowed patterns:
  //   - .innerHTML = safeHtml`...`     (tagged, auto-escaping)
  //   - .innerHTML = raw(...)`...`     (tagged, explicitly trusted)
  //   - .innerHTML = `...`             (no interpolation = static)
  //   - .innerHTML = "..."            (string literal, not our concern)
  // We flag: .innerHTML = `<...${dynamic}...>`
  const re = /\.innerHTML\s*=\s*`/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    // Find the matching closing backtick, respecting template literal nesting.
    // Template literals can contain ${...} which may contain backticks.
    let depth = 0;
    let j = m.index + m[0].length;
    while (j < code.length) {
      if (code[j] === "`" && (j === m.index + m[0].length || code[j - 1] !== "\\")) {
        if (depth === 0) break;
        depth--;
      }
      if (code[j] === "{" && j > 0 && code[j - 1] === "$") {
        depth++;
      }
      j++;
    }
    const template = code.slice(m.index, j + 1);
    if (!template.includes("${")) continue; // static template, OK

    // Check if the opening is a safe tag.
    const beforeBacktick = code.slice(Math.max(0, m.index - 30), m.index + m[0].length);
    if (/\.innerHTML\s*=\s*safeHtml\b/.test(beforeBacktick)) continue;
    if (/\.innerHTML\s*=\s*raw\b/.test(beforeBacktick)) continue;

    // Untagged template with interpolation — VIOLATION.
    const lineNumber = code.slice(0, m.index).split("\n").length;
    const snippet = template.slice(0, 80).replace(/\n/g, " ");
    violations.push(VIOLATION(lineNumber, basename(path), snippet));
  }
  return violations;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node no-unsanitized-innerhtml.mjs <file.js> [file2.js ...]");
  process.exit(2);
}

let total = 0;
for (const f of args) {
  const violations = checkFile(resolve(f));
  if (violations.length) {
    console.error(`\n${basename(f)} — ${violations.length} violation(s):`);
    for (const v of violations) console.error(v);
    total += violations.length;
  }
}

if (total > 0) {
  console.error(`\n${total} unsanitized innerHTML assignment(s) found.`);
  console.error("Use safeHtml`...` or raw(trustedHtml) instead. See:");
  console.error("  github-social/extension/content.js (safeHtml helper)");
  console.error("  github-social/src/app.js (safeHtml helper)");
  process.exit(1);
}
console.log("OK — no unsanitized innerHTML assignments detected.");
