// ESM shim: Vite ships its own tsx loader but doesn't expose __dirname.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, cpSync } from "node:fs";
import { defineConfig } from "vite";

const EXT_DIR = resolve(__dirname, "extension");
const OUT_DIR = resolve(__dirname, "dist-ext");

// Vite plugin: inject DOMPurify into content.js and replace safeHtml/raw.
// The DOMPurify import is added at the top of the source so Vite bundles it
// inline into the IIFE output. Source files remain unchanged.
function dompurifyPlugin() {
  return {
    name: "ghsocial-dompurify",
    transform(code, id) {
      if (!id.includes("content.js")) return;

      code = `import DOMPurify from "dompurify";\n${code}`;

      const oldSafeHtml =
        `function safeHtml(strings, ...values) {\n` +
        `    let out = "";\n` +
        `    for (let i = 0; i < strings.length; i++) {\n` +
        `      out += strings[i];\n` +
        `      if (i < values.length) {\n` +
        `        const v = values[i];\n` +
        `        if (v && v.__raw === true && typeof v.html === "string") {\n` +
        `          out += v.html;\n` +
        `        } else {\n` +
        `          out += escapeHtml(v);\n` +
        `        }\n` +
        `      }\n` +
        `    }\n` +
        `    return out;\n` +
        `  }`;

      const SAFE_HTML_TAGS = ["div", "span", "button", "a", "input"];
      const SAFE_HTML_ATTR = [
        "class", "id", "type", "min", "max", "step", "value",
        "href", "title", "style",
      ];
      const newSafeHtml =
        `function safeHtml(strings, ...values) {\n` +
        `    let out = "";\n` +
        `    for (let i = 0; i < strings.length; i++) {\n` +
        `      out += strings[i];\n` +
        `      if (i < values.length) out += values[i];\n` +
        `    }\n` +
        `    return DOMPurify.sanitize(out,\n` +
        `      { ALLOWED_TAGS: ["${SAFE_HTML_TAGS.join('", "')}"],\n` +
        `        ALLOWED_ATTR: ["${SAFE_HTML_ATTR.join('", "')}"] });\n` +
        `  }`;

      const oldRaw =
        `function raw(html) {\n` +
        `    return { __raw: true, html: String(html == null ? "" : html) };\n` +
        `  }`;

      const newRaw =
        `function raw(html) {\n` +
        `    const s = html == null ? "" : String(html);\n` +
        `    return DOMPurify.sanitize(s, { ALLOWED_TAGS: ["*"], ALLOWED_ATTR: ["*"] });\n` +
        `  }`;

      if (code.includes(oldSafeHtml)) code = code.replace(oldSafeHtml, newSafeHtml);
      if (code.includes(oldRaw)) code = code.replace(oldRaw, newRaw);

      return { code, map: null };
    },
  };
}

export default defineConfig({
  clearScreen: false,
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: false,
    target: "chrome109",
      rollupOptions: {
        input: {
          background: resolve(EXT_DIR, "background.js"),
          content:    resolve(EXT_DIR, "content.js"),
          popup:      resolve(EXT_DIR, "popup.js"),
          options:    resolve(EXT_DIR, "options.js"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
  },
  plugins: [
    dompurifyPlugin(),
    {
      name: "ghsocial-ext-packager",
      closeBundle() {
        mkdirSync(OUT_DIR, { recursive: true });
        for (const file of ["manifest.json", "popup.html", "options.html", "options.css", "styles.css"]) {
          const src = resolve(EXT_DIR, file);
          if (existsSync(src)) copyFileSync(src, resolve(OUT_DIR, file));
        }
        const iconsSrc = resolve(EXT_DIR, "icons");
        const iconsDst = resolve(OUT_DIR, "icons");
        if (existsSync(iconsSrc)) {
          mkdirSync(iconsDst, { recursive: true });
          cpSync(iconsSrc, iconsDst, { recursive: true });
        }
        const manifestPath = resolve(OUT_DIR, "manifest.json");
        if (existsSync(manifestPath)) {
          const m = JSON.parse(readFileSync(manifestPath, "utf8"));
          writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        }
      },
    },
  ],
});
