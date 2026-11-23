import esbuild from "esbuild";
import { builtinModules } from "node:module";

// 命令行第三个参数是 "production" 时：压缩代码、不带 source map；否则是开发构建。
const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // 这些模块由 Obsidian 自己提供，不能打进 main.js
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
});
