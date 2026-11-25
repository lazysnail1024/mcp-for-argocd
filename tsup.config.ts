import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  format: ["esm"],
  target: "node20",
  banner: {
    js: '#!/usr/bin/env node'
  }
})