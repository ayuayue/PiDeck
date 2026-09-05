import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// FileSystemService 直接依赖 node:fs/promises；node:test 环境可真实读临时目录，
// 这里验证 listTree 是否附加排序所需的 stat 元数据（mtimeMs/ctimeMs/size）。
const { FileSystemService, isPathInsideProject } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

test("WSL project containment preserves Linux path case", () => {
  const root = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\Repo";
  assert.equal(
    isPathInsideProject(root, "//wsl$/ubuntu-24.04/root/Repo/src/a.ts"),
    true,
  );
  assert.equal(
    isPathInsideProject(root, "//wsl$/ubuntu-24.04/root/repo/src/a.ts"),
    false,
  );
  assert.equal(
    isPathInsideProject(root, "//wsl$/Debian/root/Repo/src/a.ts"),
    false,
  );
});

test("native filesystem roots contain their descendants without doubling separators", () => {
  const nativeRoot = parse(tmpdir()).root;
  assert.equal(isPathInsideProject(nativeRoot, join(nativeRoot, "pideck-root-child")), true);
  if (process.platform === "win32") {
    assert.equal(
      isPathInsideProject("\\\\server\\share\\", "\\\\server\\share\\dir\\file.txt"),
      true,
    );
  }
});

test("file tree nodes carry stat metadata for sorting", async () => {
  // 构造真实临时目录：两个文件（不同大小/时间）+ 一个子目录
  const root = mkdtempSync(join(tmpdir(), "pideck-tree-"));
  const fileA = join(root, "a.txt");
  const fileB = join(root, "b.txt");
  writeFileSync(fileA, "aaaa"); // 4 字节
  writeFileSync(fileB, "bbbbbbbbbb"); // 10 字节
  const sub = join(root, "sub");
  mkdirSync(sub);
  const now = Date.now();
  utimesSync(fileA, new Date(now - 60_000), new Date(now - 60_000));
  utimesSync(fileB, new Date(now - 30_000), new Date(now - 30_000));

  try {
    const service = new FileSystemService();
    const tree = await service.listTree(root, 1);

    const byName = new Map(tree.map((n) => [n.name, n]));
    const fileANode = byName.get("a.txt");
    const fileBNode = byName.get("b.txt");
    const subNode = byName.get("sub");

    // 文件：size 为实际字节数，时间戳存在
    assert.equal(fileANode.size, 4);
    assert.equal(fileBNode.size, 10);
    assert.equal(typeof fileANode.mtimeMs, "number");
    assert.equal(typeof fileANode.ctimeMs, "number");
    // 更新时间可排序（b 更新）
    assert.ok(fileBNode.mtimeMs > fileANode.mtimeMs);
    // 目录：size 恒 0，时间戳仍存在（支持按时间排序）
    assert.equal(subNode.size, 0);
    assert.equal(typeof subNode.mtimeMs, "number");
    // 目录排在文件前（默认名称排序的既有契约不变）
    assert.equal(tree[0].name, "sub");
    assert.equal(subNode.hasChildren, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignored names stay excluded from the tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-tree-ignore-"));
  writeFileSync(join(root, "keep.ts"), "x");
  mkdirSync(join(root, "node_modules"));
  try {
    const service = new FileSystemService();
    const tree = await service.listTree(root, 1);
    const names = tree.map((n) => n.name);
    assert.ok(names.includes("keep.ts"));
    assert.ok(!names.includes("node_modules"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shallow listing does not recurse and marks expandable directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-tree-shallow-"));
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "a.ts"), "x");
  try {
    const service = new FileSystemService();
    const tree = await service.listTree(root, 0);
    const src = tree.find((node) => node.name === "src");
    assert.equal(src.type, "directory");
    assert.equal(src.children, undefined);
    assert.equal(src.hasChildren, true);

    const children = await service.listTree(root, 0, src.path);
    assert.equal(children[0].name, "deep");
    assert.equal(children[0].hasChildren, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listTree rejects a directory with too many direct children", async () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-tree-huge-"));
  try {
    for (let index = 0; index < 2001; index += 1) {
      writeFileSync(join(root, `f-${index}.txt`), "x");
    }
    const service = new FileSystemService();
    await assert.rejects(
      () => service.listTree(root, 0),
      /FILE_TREE_DIRECTORY_TOO_LARGE/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listTree rejects a directory outside the project root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pideck-tree-escape-"));
  try {
    const service = new FileSystemService();
    await assert.rejects(
      () => service.listTree(root, 0, join(root, "..", "outside")),
      /escapes project directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
