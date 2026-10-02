import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // Desktop MyGo loads the bundle from its local webview root. GitHub Pages
  // needs the repository path prefix, so opt into that only in the Pages job.
  base: process.env.VITE_DEPLOY_TARGET === "pages" ? "/DeepStudent-Go/" : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
