// ESM shim
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  build: {
    outDir: resolve(__dirname, "dist-embed"),
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: false,
    target: "chrome109",
    lib: {
      entry: resolve(__dirname, "extension/embed.js"),
      name: "GHSocialEmbed",
      fileName: "embed",
      formats: ["es", "iife"],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: ["../src/social-widget.js"],
      },
    },
  },
});
