/**
 * Render the Marketplace icon from the Activity Bar SVG.
 *
 * Why a script: `assets/icon.svg` uses `currentColor`, which inherits from the
 * Activity Bar theme, and `assets/icon.png` is the flat, branded version the
 * Marketplace renders. Keeping the PNG as a generated artifact means the two
 * never drift apart and the PNG can be re-cut at any size.
 *
 * The Marketplace wants at least 128x128 and asks for 256x256 for Retina.
 * This renders 256x256, which satisfies both.
 *
 * Run: node scripts/build-icon.mjs
 */
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SVG_PATH = path.join(root, "assets", "icon.svg");
const PNG_PATH = path.join(root, "assets", "icon.png");

/** The stroke colour of the existing PNG, sampled from the rendered pixels. */
const STROKE = "#4e8cff";
/** The background the existing PNG sits on. */
const BACKGROUND = "#1e1e1e";
const SIZE = 256;

/**
 * `currentColor` has no meaning in a standalone SVG, so it has to become a
 * literal before rasterizing. Left as-is it renders black.
 */
function resolveCurrentColor(svg) {
  return svg.replace(/currentColor/g, STROKE);
}

function main() {
  const svg = fs.readFileSync(SVG_PATH, "utf8");
  const renderer = new Resvg(resolveCurrentColor(svg), {
    fitTo: { mode: "width", value: SIZE },
    background: BACKGROUND,
  });
  fs.writeFileSync(PNG_PATH, renderer.render().asPng());
  console.log(`icon written to assets/icon.png (${SIZE}x${SIZE})`);
}

main();
