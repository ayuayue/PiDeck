/**
 * build.mjs — inline fonts + assets into a single self-contained HTML for the
 * seek renderer (no external refs; see animation-pitfalls "single file").
 *
 *   node build.mjs            -> film.html
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const R = (p) => resolve(here, p);
const font = (p) => `data:font/woff2;base64,${readFileSync(R(p)).toString("base64")}`;

let html = readFileSync(R("film.src.html"), "utf8");
const map = {
  __FONT_BRAND__: font(resolve(repo, "src/renderer/src/assets/fonts/PlantinNowVariable-Upright.woff2")),
  __FONT_MONO__: font(resolve(repo, "src/renderer/src/assets/fonts/DepartureMono-Regular.woff2")),
};
for (const [k, v] of Object.entries(map)) {
  if (!html.includes(k)) throw new Error(`token ${k} not found in film.src.html`);
  html = html.split(k).join(v);
}
const out = R("film.html");
writeFileSync(out, html);
console.log(`film.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
