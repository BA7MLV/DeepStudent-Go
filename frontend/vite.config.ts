import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // MyGo serves the embedded bundle from mygo://localhost/ while Pages needs
  // the repository prefix. Keep both targets explicit so desktop builds never
  // inherit /DeepStudent-Go/ asset URLs and regress to a white screen.
  base: process.env.VITE_DEPLOY_TARGET === "pages" ? "/DeepStudent-Go/" : "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
