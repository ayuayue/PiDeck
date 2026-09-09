import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mark = readFileSync("src/renderer/src/components/app/LogoMark.tsx", "utf8");
const lockup = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const boot = readFileSync("src/renderer/index.html", "utf8");
const webBrand = readFileSync("src/renderer/src/web/WebBrandLockup.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");

const PI_GLYPH = /M165\.29 165\.29H517\.36V400/;

test("in-app brand surfaces use the Pi glyph, not the spider mark", () => {
  assert.match(mark, /export function LogoMark/);
  assert.match(mark, PI_GLYPH);
  assert.doesNotMatch(mark, /brandMarkSrc/);
  assert.match(lockup, /<PiLogoCanvas size=\{18\}/);
  // beUI 两行字标（5fcca0b8）：wordmark 由 TextShimmer 承载，不再用 aria-hidden span
  assert.match(lockup, />\s*PiDeck\s*<\/TextShimmer>/);
  assert.match(app, PI_GLYPH);
  assert.match(boot, /id="boot-logo-silver"/);
  assert.match(boot, PI_GLYPH);
  assert.match(webBrand, /<PiLogoCanvas size=\{18\}/);
  assert.match(webBrand, />\s*PiDeck\s*</);
  assert.match(webTimeline, /<LogoMark size=\{66\} \/>/);
  for (const source of [mark, lockup, app, boot, webBrand, webTimeline]) {
    assert.doesNotMatch(source, /M7\.5 15\.5C3\.5 14/);
    assert.doesNotMatch(source, /<ellipse cx="60" cy="50"/);
  }
});
