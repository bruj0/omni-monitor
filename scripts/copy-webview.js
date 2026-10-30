/**
 * Assemble the dashboard webview bundle.
 *
 * The webview must be an IIFE, because a webview cannot resolve bare module
 * specifiers. The extension host is CommonJS, which VS Code requires. So the
 * webview ships as its own esbuild bundle rather than as a tsc output, and
 * chart.js is inlined for the same reason.
 *
 * Pass `--watch` to rebuild on every save. This is the half of the build the
 * TypeScript watcher cannot cover: `media/dashboard.js` is an esbuild artifact,
 * so a window reload after a webview edit picks up nothing new unless this runs.
 */
const esbuild = require("esbuild");
const path = require("path");

const root = path.resolve(__dirname, "..");
const watching = process.argv.includes("--watch");

/** One definition, shared by the one-shot build and the watcher. */
const options = {
  // Bundle from the TypeScript source directly: charts.js is plain JS
  // beside the TS, and tsc never emits it.
  entryPoints: [path.join(root, "src/webview/app.ts")],
  bundle: true,
  outfile: path.join(root, "media/dashboard.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
};

async function main() {
  if (watching) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log("watching src/webview/app.ts -> media/dashboard.js");
    return;
  }

  await esbuild.build(options);
  console.log("webview bundle written to media/dashboard.js");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
