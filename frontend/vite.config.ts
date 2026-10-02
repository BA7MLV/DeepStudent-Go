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
});
