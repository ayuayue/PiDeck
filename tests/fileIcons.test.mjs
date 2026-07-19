import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const definitions = JSON.parse(
  readFileSync("src/renderer/src/vendor/seti-icons/definitions.json", "utf8"),
);
const icons = JSON.parse(
  readFileSync("src/renderer/src/vendor/seti-icons/icons.json", "utf8"),
);

function iconFor(fileName) {
  const details = definitions.files[fileName]
    ?? definitions.extensions[fileName.slice(fileName.lastIndexOf("."))]
    ?? definitions.default;
  return { svg: icons[details[0]], color: details[1] };
}

describe("Seti file icon integration", () => {
  test("vendored Seti data returns distinct icons for common file types", () => {
    const ts = iconFor("App.tsx");
    const vue = iconFor("App.vue");
    const json = iconFor("package.json");

    for (const icon of [ts, vue, json]) {
      assert.match(icon.svg, /^<svg\b/);
      assert.match(icon.svg, /viewBox=/);
      assert.ok(icon.color);
    }
    assert.notEqual(ts.svg, vue.svg);
  });

  test("vendored lookup is attributed and does not require the obsolete npm package", () => {
    const source = readFileSync("src/renderer/src/fileIcons.ts", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.match(source, /from "\.\/vendor\/seti-icons"/);
    assert.equal(packageJson.dependencies["seti-icons"], undefined);
    assert.match(readFileSync("src/renderer/src/vendor/seti-icons/NOTICE.md", "utf8"), /Seti-UI/);
    assert.match(readFileSync("src/renderer/src/vendor/seti-icons/LICENSE.md", "utf8"), /Copyright \(c\) 2014 Jesse Weed/);
  });

  test("renderer imports the dedicated file icon stylesheet", () => {
    const source = readFileSync("src/renderer/src/main.tsx", "utf8");
    assert.match(source, /import "\.\/file-icons\.css";/);
  });

  test("file tree renders trusted Seti SVG and file type labels", () => {
    const source = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
    assert.match(source, /getFileIconSeti\(name\)/);
    assert.match(source, /dangerouslySetInnerHTML=\{\{ __html: svg \}\}/);
    assert.match(source, /aria-hidden="true"/);
    assert.match(source, /file-node-type-label/);
    assert.match(source, /file-node-git-badge/);
    assert.match(source, /status: f\.status/);
  });

  test("Git panel and file tree share the same vendored Seti lookup and color mapping", () => {
    const fileTree = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
    const gitPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
    const sharedLookup = readFileSync("src/renderer/src/fileIcons.ts", "utf8");

    assert.match(fileTree, /import \{ getFileIconSeti, getFileIconColor, getFileTypeLabel \} from "\.\.\/\.\.\/fileIcons"/);
    assert.match(gitPanel, /import \{ getFileIconColor, getFileIconSeti \} from "\.\.\/\.\.\/fileIcons"/);
    assert.match(fileTree, /getFileIconSeti\(name\)/);
    assert.match(gitPanel, /getFileIconSeti\(name\)/);
    assert.match(sharedLookup, /from "\.\/vendor\/seti-icons"/);
    assert.match(sharedLookup, /SETI_COLOR_TO_CSS/);
  });

  test("Git changed-file parser preserves paths and renamed status", () => {
    const source = readFileSync("src/main/git/GitService.ts", "utf8");
    assert.match(source, /"--name-status", "-z"/);
    assert.match(source, /statusChar === "R" \? "renamed"/);
    assert.match(source, /const currentPath = isRenameOrCopy \? fields\[index\+\+\]/);
  });

  test("stylesheet sizes and colors Seti SVG icons", () => {
    const source = readFileSync("src/renderer/src/file-icons.css", "utf8");
    assert.match(source, /\.file-node-seti-icon svg/);
    assert.match(source, /--file-type-icon-size:\s*20px/);
    assert.match(source, /fill:\s*currentColor/);
    assert.match(source, /--file-icon-blue:/);
    assert.match(source, /:root\[data-theme="dark"\]/);
    assert.match(source, /@container \(max-width: 340px\)/);
  });
});
