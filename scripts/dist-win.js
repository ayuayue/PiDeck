/**
 * dist:win 包装脚本，支持按需指定打包格式。
 *
 * 用法：
 *   npm run dist:win              → 全格式：nsis + portable + zip
 *   npm run dist:win -- nsis      → 仅 NSIS 安装包
 *   npm run dist:win -- portable  → 仅便携 exe
 *   npm run dist:win -- zip       → 仅 zip
 *   npm run dist:win -- nsis portable  → 多个指定格式
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");

// npm run 会把 -- 后面的参数放到 process.argv 的 2..n
const args = process.argv.slice(2);
const formats = args.length > 0
  ? args.join(" ")
  : "nsis portable zip";

console.log(`[1/2] 打包代码…`);
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[2/2] electron-builder --win ${formats} …`);
execSync(`npx electron-builder --win ${formats}`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

// Windows 自动更新由 electron-updater 的 NSIS provider 执行。每次发布必须让同一
// GitHub Release 同时包含 `latest.yml`、当前版本 setup.exe 和对应 .blockmap；后两
// 项缺失时客户端无法安全下载或进行差分更新。portable / zip 仅供用户手动下载。
console.log(`\n✅ 打包完成！产物在 release/ 目录下`);
const releaseDir = path.join(root, "release");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productName = packageJson.build?.productName ?? packageJson.name;
const artifactPrefix = `${productName}-${packageJson.version}-`;
const setupAsset = `${artifactPrefix}setup.exe`;
const setupBlockmap = `${setupAsset}.blockmap`;
const requiredUpdaterAssets = ["latest.yml", setupAsset, setupBlockmap];
const expectedReleaseAssets = [
  ...requiredUpdaterAssets,
  `${artifactPrefix}portable.exe`,
  `${artifactPrefix}win.zip`,
];

if (fs.existsSync(releaseDir)) {
  // release/ can contain stale artifacts from earlier manual builds. Listing only exact
  // configured names prevents accidentally attaching a prior or prerelease installer.
  const releaseAssets = expectedReleaseAssets.filter((name) => fs.existsSync(path.join(releaseDir, name)));
  console.log(`\n发布 GitHub Release 时需上传以下当前版本 assets：`);
  for (const name of releaseAssets) console.log(`  - ${name}`);

  const missingUpdaterAssets = requiredUpdaterAssets.filter(
    (name) => !fs.existsSync(path.join(releaseDir, name)),
  );
  if (missingUpdaterAssets.length > 0) {
    console.warn(`\n⚠ Windows 自动更新缺少：${missingUpdaterAssets.join("、")}`);
    console.warn("  请至少打包 nsis 目标，并将该三项上传到同一个 GitHub Release。");
  } else {
    console.log(`\n✓ Windows 自动更新 assets 齐全：latest.yml + ${setupAsset} + .blockmap`);
    console.log("  portable / zip 是手动下载资产，不会被 electron-updater 作为更新包安装。");
  }
}

