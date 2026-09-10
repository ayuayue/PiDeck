import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const menuSource = readFileSync(
  "src/renderer/src/components/session/ComposerOverlayComponents.tsx",
  "utf8",
);
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const appUtils = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");
const chips = loadTsCommonJs("src/renderer/src/components/session/composer/chips.ts");

test("FileContextMenu：文件与目录都能「加入对话引用」和「默认方式打开」", () => {
  // 引用项不能再按 isFile 禁用——拖拽落点与 @ 建议列表都允许目录。
  assert.match(
    menuSource,
    /<DropdownMenuItem onSelect=\{props\.onAttach\}>\s*\{t\("menu\.attachFile"\)\}/,
  );
  // 「默认方式打开」对目录同样开放：目录的默认处理器就是文件管理器。
  assert.match(
    menuSource,
    /<DropdownMenuItem onSelect=\{props\.onOpen\}>\s*\{t\("menu\.defaultOpen"\)\}/,
  );
  assert.doesNotMatch(menuSource, /disabled=\{!isFile\}/);
});

test("App：文件树右键引用复用 fileNodeDragPayloadToRef 并经 composer-attach-refs 插入", () => {
  const start = appSource.indexOf("onAttach={() =>");
  const end = appSource.indexOf("onCopyPath={() =>");
  assert.ok(start !== -1 && end > start, "应能在 FileContextMenu 用法中找到 onAttach 分支");
  const attachBlock = appSource.slice(start, end);
  assert.match(attachBlock, /fileNodeDragPayloadToRef\(/);
  assert.match(attachBlock, /composer-attach-refs/);
  // 旧写法直接拼 @relativePath：目录缺尾斜杠、含空格路径不加引号。
  assert.doesNotMatch(attachBlock, /@\$\{fileMenu\.node\.relativePath\}/);

  // 「默认方式打开」仍按节点自身路径交给系统默认处理器（目录 → 文件管理器）。
  const openBlock = appSource.slice(
    appSource.indexOf("onOpen={() =>"),
    appSource.indexOf("onReveal={() =>"),
  );
  assert.match(openBlock, /api\.files\.open\(fileMenu\.node\.path\)/);
});

test("目录节点引用带尾斜杠（raw）且可解析为 file chip", () => {
  const ref = appUtils.fileNodeDragPayloadToRef({
    path: "C:\\proj\\.tmp",
    relativePath: ".tmp",
    type: "directory",
  });
  assert.equal(ref, "@.tmp/");

  // 真实 App 的 validFilePaths 由 flattenFiles 生成，包含目录节点本身。
  const parsed = chips.parseRichInputChips(
    `看下 ${ref} 这个目录`,
    undefined,
    new Set([".tmp"]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "file");
  // 展示只给目录名（文件夹图标承担「目录」语义，对齐 Proma）
  assert.equal(parsed[0].label, ".tmp");
});

test("含空格的目录引用加引号、raw 保留尾斜杠", () => {
  const ref = appUtils.fileNodeDragPayloadToRef({
    path: "C:\\proj\\my docs",
    relativePath: "my docs",
    type: "directory",
  });
  assert.equal(ref, '@"my docs/"');

  const parsed = chips.parseRichInputChips(ref, undefined, new Set(["my docs"]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "file");
  assert.equal(parsed[0].label, "my docs");
});
