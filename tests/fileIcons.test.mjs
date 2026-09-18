import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const definitions = JSON.parse(
  readFileSync("src/renderer/src/vendor/seti-icons/definitions.json", "utf8"),
);
const icons = JSON.parse(
  readFileSync("src/renderer/src/vendor/seti-icons/icons.json", "utf8"),
);
const workspaceSurface = readFileSync(
  "src/renderer/src/components/session/WorkspaceSurface.tsx",
  "utf8",
);
const surfaceFacade = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);
const gitResourceTree = readFileSync(
  "src/renderer/src/components/app/git/GitResourceTree.tsx",
  "utf8",
);

function iconFor(fileName) {
  const details =
    definitions.files[fileName] ??
    definitions.extensions[fileName.slice(fileName.lastIndexOf("."))] ??
    definitions.default;
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
    assert.match(
      readFileSync("src/renderer/src/vendor/seti-icons/NOTICE.md", "utf8"),
      /Seti-UI/,
    );
    assert.match(
      readFileSync("src/renderer/src/vendor/seti-icons/LICENSE.md", "utf8"),
      /Copyright \(c\) 2014 Jesse Weed/,
    );
  });

  test("renderer loads file icons via styles.css vendor layer", () => {
    const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
    assert.match(
      stylesEntry,
      /@import\s+"\.\/file-icons\.css"\s+layer\(vendor\)/,
    );
    assert.doesNotMatch(
      readFileSync("src/renderer/src/main.tsx", "utf8"),
      /import "\.\/file-icons\.css"/,
    );
  });

  test("file tree renders trusted Seti SVG and file type labels", () => {
    const source = workspaceSurface;
    assert.match(source, /getFileIconSeti\(name\)/);
    assert.match(source, /dangerouslySetInnerHTML=\{\{ __html: svg \}\}/);
    assert.match(source, /aria-hidden="true"/);
    assert.match(source, /file-node-type-label/);
    assert.match(source, /file-node-seti-icon/);
    assert.match(source, /function fileIconElement/);
  });

  test("Git panel and file tree share the same vendored Seti lookup and color mapping", () => {
    const fileTree = workspaceSurface;
    const gitPanel = gitResourceTree;
    const sharedLookup = readFileSync("src/renderer/src/fileIcons.ts", "utf8");

    assert.match(
      fileTree,
      /import \{ getFileIconSeti, getFileIconColor, getFileTypeLabel \} from "\.\.\/\.\.\/fileIcons"/,
    );
    assert.match(gitPanel, /from "\.\.\/\.\.\/\.\.\/fileIcons"/);
    assert.match(fileTree, /getFileIconSeti\(name\)/);
    assert.match(gitPanel, /getFileIconSeti\(name\)/);
    assert.match(sharedLookup, /from "\.\/vendor\/seti-icons"/);
    assert.match(sharedLookup, /SETI_COLOR_TO_CSS/);
  });

  test("workspace drawer symbols retain the SurfaceComponents compatibility export", () => {
    assert.match(
      surfaceFacade,
      /export \{ DrawerContent, SessionFileSummary, SessionHistoryModal \} from "\.\/WorkspaceSurface";/,
    );
  });

  test("Git status and history parsers preserve rename paths", () => {
    const source = readFileSync("src/main/git/GitService.ts", "utf8");
    assert.match(source, /"--name-status", "-z"/);
    assert.match(
      source,
      /statusChar === "R" \|\| statusChar === "C"\s*\?\s*"renamed"/,
    );
    assert.match(
      source,
      /const currentPath = isRenameOrCopy\s*\?\s*\(?fields\[index\+\+\]/,
    );
    assert.match(
      source,
      /porcelain -z 的 rename\/copy 顺序是“当前路径\\0原路径\\0”/,
    );
    assert.match(source, /includeOldPath && oldPath/);
  });

  test("stylesheet sizes and colors Seti SVG icons", () => {
    const source = readFileSync("src/renderer/src/file-icons.css", "utf8");
    assert.match(source, /\.file-node-seti-icon svg/);
    assert.match(source, /--file-type-icon-size:\s*24px/);
    assert.match(source, /--file-icon-folder:\s*var\(--file-icon-grey\)/);
    assert.match(source, /fill:\s*currentColor/);
    assert.match(source, /--file-icon-blue:/);
    assert.match(source, /:root\[data-theme="dark"\]/);
    assert.match(source, /@container \(max-width: 340px\)/);
  });

  test("files drawer drops title chrome and keeps a denser tree", () => {
    // 文件抽屉：无顶栏；工具行压矮；缩进 8px/层；树行原生 button（不套 shadcn Button 抢 SVG 尺寸）
    assert.match(workspaceSurface, /props\.panel !== "files" && title/);
    assert.match(workspaceSurface, /panel-action-row flex h-7/);
    assert.match(workspaceSurface, /depth \* 8/);
    assert.match(workspaceSurface, /树行用原生 button/);
    assert.doesNotMatch(workspaceSurface, /\[&_svg\]:!size-/);
    assert.match(workspaceSurface, /FolderOpen size=\{18\}/);
    // 滚动层上移到 DrawerSurface 的 LazyWrapper（overflow-y-auto）；files-panel 自身
    // 只保留 overflow-x-hidden，避免滚动条占位导致的宽度摆动（见 DrawerSurface 注释）
    assert.match(workspaceSurface, /files-panel[^"]*overflow-x-hidden/);
    assert.doesNotMatch(workspaceSurface, /files-panel[^"]*overflow-y-auto/);
    assert.doesNotMatch(workspaceSurface, /files-panel[^"]*overflow-hidden"/);
  });
});
