import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const isPWA = !!process.env.PWA_BASE;
const isTauri = !!process.env.TAURI_PLATFORM;

export default defineConfig({
  clearScreen: false,
  root: "src",
  base: process.env.PWA_BASE || "/github-social/",
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM == "windows" ? "chrome105" : "safari13",
    outDir: isPWA ? "../dist-pwa" : isTauri ? "../dist" : "dist",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    emptyOutDir: true,
  },
  plugins: isPWA
    ? [
        VitePWA({
          registerType: "autoUpdate",
          includeAssets: ["favicon.ico", "robots.txt", "icon.svg", "icon-512.svg"],
          manifest: {
            name: "GitHub Social",
            short_name: "GH Social",
            description: "The decentralized, immersive GitHub social layer",
            theme_color: "#0d1117",
            background_color: "#0d1117",
            display: "standalone",
            orientation: "portrait",
            scope: "/github-social/",
            start_url: "/github-social/",
            icons: [
              { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
              { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
            ],
          },
          workbox: {
            globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
            runtimeCaching: [
              {
                urlPattern: /^https:\/\/api\.github\.com\//,
                handler: "NetworkFirst",
                options: { cacheName: "github-api", expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
              },
              {
                urlPattern: /^https:\/\/avatars\.githubusercontent\.com\//,
                handler: "CacheFirst",
                options: { cacheName: "avatars", expiration: { maxEntries: 100, maxAgeSeconds: 86400 } },
              },
              {
                urlPattern: /^https:\/\/raw\.githubusercontent\.com\//,
                handler: "NetworkFirst",
                options: { cacheName: "github-raw", expiration: { maxEntries: 100, maxAgeSeconds: 3600 } },
              },
            ],
          },
        }),
      ]
    : [],
});
