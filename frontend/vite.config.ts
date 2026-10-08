import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // MyGo serves the embedded bundle from mygo://localhost/ while Pages needs
  // the repository prefix. Keep both targets explicit so desktop builds never
  // inherit /DeepStudent-Go/ asset URLs and regress to a white screen.
  base: process.env.VITE_DEPLOY_TARGET === "pages" ? "/DeepStudent-Go/" : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // MyGo's development window loads the Vite dev URL while the Go runtime
  // listens on its own loopback port. Proxy API and SSE paths so the default
  // relative runtime URL works without requiring VITE_GO_RUNTIME_URL.
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
      "/readyz": "http://127.0.0.1:8080",
    },
  },
});
