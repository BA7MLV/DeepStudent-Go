import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "DeepStudent Go",
  identifier: "cn.deepstudent.go",
  version: "0.1.0",
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "frontend/dist",
  bindings: "frontend/src/mygo.ts",
  main: "./cmd/deepstudent",
  out: "build",
  macos: {
    minimumSystemVersion: "12.0",
    signingIdentity: "-",
  },
  linux: {
    maintainer: "DeepStudent",
    comment: "Go-primary runtime migration shell",
  },
});
