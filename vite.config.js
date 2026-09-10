import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// base: "./" makes the build use relative asset paths, so it works
// whether it's served at the repo root or under /<repo-name>/ on
// GitHub Pages — no need to hardcode the repo name here.
export default defineConfig({
  plugins: [
    react(),
    // Caches the app shell (HTML/JS/CSS/icons) via a service worker so
    // the page itself loads with zero connectivity, not just the data.
    // Firestore's own offline persistence (enabled in src/firebase.js)
    // handles the incident data side of "works offline, syncs later".
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: {
        name: "Command Board — ICS Incident Management",
        short_name: "Command Board",
        description: "Field incident command tool for structure, wildland, hazmat, and all-hazard incidents.",
        theme_color: "#14171A",
        background_color: "#14171A",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "apple-touch-icon.png", sizes: "180x180", type: "image/png" },
          { src: "favicon.png", sizes: "32x32", type: "image/png" },
        ],
      },
      workbox: {
        // Precache the built app shell; runtime Firestore calls are
        // handled by the Firestore SDK's own offline cache, not this
        // service worker, so no runtimeCaching rules are needed here.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
    }),
  ],
  base: "./",
});
