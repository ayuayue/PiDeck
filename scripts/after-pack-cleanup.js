/**
 * afterPack 钩子：打包后执行多项清理，缩减安装包体积。
 *
 * 1. Locale 精简 —— 只保留中英文，删除 Electron 其余 52 个语言包（节省 ~42MB）
 * 2. 保留第三方包的运行时入口，清理文档、许可证、测试等非运行时文件
 *
 * 参考: https://www.electron.build/configuration/configuration#afterpack
 */

const fs = require("node:fs");
const { finished } = require("node:stream");
const path = require("node:path");
const asar = require("@electron/asar");
const { patchSharpIndexCjs } = require("./patch-sharp-index");

/** 要保留的语言包列表（小写，无 .pak 后缀） */
const KEEP_LOCALES = new Set(["en-us", "zh-cn", "zh-tw"]);

// asar extract/repack 均使用 @electron/asar API，避免依赖 Windows CLI。

/**
 * 从 asar header 收集 originally unpacked 的相对路径。
 * electron-builder 会把 .node 等原生文件标 unpacked，并镜像到 app.asar.unpacked；
 * 裸 `asar pack` 会丢掉这些标记，Electron 就不再把 require 映射到磁盘，
 * 表现为打包版 terminal:ensure 找不到 pty.node（#154）。
 */
function collectUnpackedPatterns(headerNode, prefix = "", acc = { files: [], dirs: [] }) {
  const children = headerNode && headerNode.files;
  if (!children || typeof children !== "object") return acc;
  for (const [name, child] of Object.entries(children)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (!child || typeof child !== "object") continue;
    if (child.files) {
      if (child.unpacked) acc.dirs.push(rel);
      collectUnpackedPatterns(child, rel, acc);
    } else if (child.unpacked) {
      acc.files.push(rel);
    }
  }
  return acc;
}

function readUnpackedPatterns(asarPath) {
  const raw = asar.getRawHeader(asarPath);
  return collectUnpackedPatterns(raw.header);
}

/**
 * asar 的 unpack 选项对「文件绝对路径」做 minimatch（matchBase: true），
 * 相对路径列表匹配不上 Windows 绝对路径。
 *
 * 禁止按「原 header 里出现过的任意后缀」展开：asarUnpack 含 hostEntry.js 时
 * 会得到 `*.js`，repack 把整包 JS 标成 unpacked，并在 resources/ 留下
 * `app.asar.tmp.unpacked`（上万文件）。便携 NSIS 启动先解压这堆，表现为
 * 「后台有进程、没有窗口」。
 *
 * 只保留原生后缀 + utilityProcess 入口文件名。
 */
// ELF 共享库经常使用带 ABI 版本的文件名，例如 libvips-cpp.so.8.18.3。
// 仅匹配 `.so` 会让 afterPack 重打包时把它们重新塞回 app.asar。
const NATIVE_UNPACK_SUFFIXES = new Set([".node", ".dll", ".exe", ".wasm", ".dylib"]);
const ELF_SHARED_LIBRARY_PATTERN = /\.so(?:\.\d+)*$/i;
const ALWAYS_UNPACK_BASENAMES = new Set(["hostentry.js"]);

function unpackGlobFromFiles(files) {
  const patterns = new Set();
  for (const file of files ?? []) {
    const base = String(file).split("/").pop() ?? "";
    if (ALWAYS_UNPACK_BASENAMES.has(base.toLowerCase())) {
      patterns.add(base);
      continue;
    }
    if (ELF_SHARED_LIBRARY_PATTERN.test(base)) {
      // `.so*` 同时覆盖未版本化和带 ABI 版本号的 ELF 动态库。
      patterns.add("*.so*");
      continue;
    }
    const match = /\.([A-Za-z0-9]+)$/.exec(base);
    if (!match) continue;
    const suffix = `.${match[1].toLowerCase()}`;
    if (NATIVE_UNPACK_SUFFIXES.has(suffix)) patterns.add(`*${suffix}`);
  }
  if (patterns.size === 0) return undefined;
  const list = [...patterns];
  return list.length === 1 ? list[0] : `{${list.join(",")}}`;
}

async function removeAsarRepackArtifacts(asarPath) {
  const tmpAsar = `${asarPath}.tmp`;
  const tmpUnpacked = `${asarPath}.tmp.unpacked`;
  await rmDir(tmpUnpacked);
  try {
    await fs.promises.unlink(tmpAsar);
  } catch {
    // 正常路径里 tmp asar 已被 rename 成 app.asar
  }
}

function unpackDirGlobFromDirs(dirs) {
  if (!dirs || dirs.length === 0) return undefined;
  // unpackDir 匹配相对 src 的目录路径；用末级目录名覆盖常见 native 目录。
  const names = [...new Set(dirs.map((dir) => dir.split("/").pop()).filter(Boolean))];
  return names.length === 1 ? names[0] : `{${names.join(",")}}`;
}

/** 重打包 asar，保留原 header 里的 unpacked 文件/目录。 */
async function packAsarPreservingUnpacked(srcDir, destAsar, unpacked) {
  const options = {
    unpack: unpackGlobFromFiles(unpacked.files),
    unpackDir: unpackDirGlobFromDirs(unpacked.dirs),
  };
  const output = await asar.createPackageWithOptions(srcDir, destAsar, options);
  // @electron/asar 返回已创建但尚未写完的 WritableStream；必须等待 close，
  // 否则调用方会提前 rename 临时 archive，留下空/截断的 app.asar。
  await new Promise((resolve, reject) => {
    finished(output, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * 打包**目标**平台标识，如 win32-x64 / linux-arm64。
 *
 * 必须从 electron-builder 的 context 推导，不能用 `process.platform/arch`：
 * 交叉打包（如在 x64 runner 上 `electron-builder --linux --arm64`）时，
 * process.arch 反映的是**构建机**架构，会误判成 linux-x64，
 * 导致把 arm64 的 node-pty prebuild 删掉、留下 x64 的，产物终端直接不可用。
 */
function resolveTargetPlatform(context) {
  const platform = context?.electronPlatformName || process.platform;
  const arch = context?.arch ?? process.arch;
  const archName = typeof arch === "number" ? ARCH_NAMES[arch] ?? process.arch : arch;
  return `${platform}-${archName}`;
}

/** electron-builder Arch 枚举值 → 目录名（node-pty prebuild 用 arm64/x64 命名）。 */
const ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

/** 递归删除目录 */
async function rmDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 递归获取目录总大小 */
async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        total += (await fs.promises.stat(full)).size;
      }
    }
  } catch { /* 忽略 */ }
  return total;
}

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
exports.collectUnpackedPatterns = collectUnpackedPatterns;
exports.readUnpackedPatterns = readUnpackedPatterns;
exports.packAsarPreservingUnpacked = packAsarPreservingUnpacked;
exports.unpackGlobFromFiles = unpackGlobFromFiles;

exports.default = async function (context) {
  const { appOutDir } = context;

  // 本次打包的目标平台（交叉打包下与构建机不同），供 node-pty prebuild 过滤使用。
  const CURRENT_PLATFORM = resolveTargetPlatform(context);

  // ====================================
  // 1. Locale 精简
  // ====================================
  const localesDir = path.join(appOutDir, "locales");
  try {
    const entries = await fs.promises.readdir(localesDir);
    let removed = 0;
    let kept = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.endsWith(".pak")) continue;
      const localeKey = entry.replace(/\.pak$/i, "").toLowerCase();
      if (!KEEP_LOCALES.has(localeKey)) {
        const fullPath = path.join(localesDir, entry);
        try {
          const stat = await fs.promises.stat(fullPath);
          totalBytes += stat.size;
          await fs.promises.unlink(fullPath);
          removed++;
        } catch { /* 忽略 */ }
      } else {
        kept++;
      }
    }

    if (removed > 0) {
      console.log(
        `[afterPack] 语言包: 已删除 ${removed} 个 (${(totalBytes / 1024 / 1024).toFixed(1)} MB)，保留 ${kept} 个: ${[...KEEP_LOCALES].join(", ")}`,
      );
    }
  } catch {
    // 没有 locales 目录（Linux 等），跳过
  }

  // ====================================
  // 2. 根目录 Electron 基础设施清理
  //    LICENSES.chromium.html 是 Chromium 全部开源协议文本，
  //    对最终用户无实际用途（15MB）。chrome_*.pak 是 Chrome 的 UI 资源，
  //    Electron 桌面应用不使用浏览器 UI，可安全删除。
  // ====================================
  const rootCleanups = [
    { path: "LICENSES.chromium.html", desc: "Chromium 开源许可证大全" },
    { path: "chrome_100_percent.pak", desc: "Chrome 常规 DPI UI 资源" },
    { path: "chrome_200_percent.pak", desc: "Chrome 高DPI UI 资源" },
  ];

  for (const { path: filename, desc } of rootCleanups) {
    const fullPath = path.join(appOutDir, filename);
    try {
      const stat = await fs.promises.stat(fullPath);
      await fs.promises.unlink(fullPath);
      console.log(`[afterPack] 已删除根目录 ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)：${desc}`);
    } catch {
      // 文件不存在则跳过
    }
  }

  // ====================================
  // 3. asar 内 node_modules 冗余清理
  //    一次提取 → 集中清理 → 一次打包，避免反复 extract/repack。
  //
  //    PI_FAST_PACK=1（dist:fast）时整体跳过：这一步只省 ~4MB 体积，
  //    但 243MB asar 的 extract + repack 是打包耗时大头（实测可达数分钟）。
  //    跳过是安全的：asarUnpack 命中的文件（.node/wasm/hostEntry.js/sharp 目录）
  //    在原始 asar 中只存 unpacked 标记、不存内容，运行时透明读取磁盘镜像，
  //    所以第 4/5/6 节对镜像的清理与 sharp 补丁仍然生效。
  //    发布正式版必须走完整流程（不设该变量）。
  // ====================================
  const asarPath = path.join(appOutDir, "resources", "app.asar");

  if (process.env.PI_FAST_PACK === "1") {
    console.log("[afterPack] PI_FAST_PACK=1：跳过 asar 解包清理/重打包（仅快速验证用，勿对外发布）");
  } else {
  if (!fs.existsSync(asarPath)) {
    console.log("[afterPack] 未找到 app.asar，跳过 node_modules 清理");
    return;
  }

  const extractDir = path.join(appOutDir, ".asar-extract");
  // 必须在 extract 前读 header：repack 后才知道哪些路径原本是 unpacked。
  const unpackedPatterns = readUnpackedPatterns(asarPath);
  console.log(`[afterPack] 正在提取 asar 进行清理...`);
  // 直接使用 API，避免通过 Windows cmd.exe 启动 CLI 导致固定超时。
  // 失败重试时先清掉上一次中断留下的临时目录，避免混入残留文件。
  await rmDir(extractDir);
  // extractAll 返回 Promise；必须等待解包完成后再扫描 node_modules，否则清理阶段
  // 会看到空目录并把空的临时目录重新打包，最终丢失整个 app.asar 内容。
  await asar.extractAll(asarPath, extractDir);

  let totalRemoved = 0;

  // --- 3a. 保留 @larksuiteoapi 的 CJS 运行时入口 ---
  // node-sdk 的 package.json 将 main 指向 ./lib/index.js，且未声明 exports。
  // Node.js 的动态 import() 仍会按 main 解析，所以不能删除 lib/；否则打包版会找不到 SDK。

  // --- 3b. 删除所有 node_modules 中的 source map、文档、测试文件 ---
  const nmExtractDir = path.join(extractDir, "node_modules");
  if (fs.existsSync(nmExtractDir)) {
    async function cleanNodeModules(dir) {
      let removedInDir = 0;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (!entry.isDirectory()) {
            const lowerName = entry.name.toLowerCase();
            // 删除：source map、README、CHANGELOG、AUTHORS、Markdown 文档
            if (
              entry.name.endsWith(".js.map") ||
              entry.name.endsWith(".map") ||
              entry.name.endsWith(".d.ts") ||
              lowerName === "readme.md" ||
              lowerName === "changelog.md" ||
              lowerName === "contributing.md" ||
              lowerName === "authors" ||
              lowerName === "authors.md" ||
              entry.name === "LICENSE" ||
              lowerName === "license.md" ||
              lowerName === "license.txt"
            ) {
              const stat = await fs.promises.stat(full);
              if (stat.size > 0) {
                await fs.promises.unlink(full);
                removedInDir += stat.size;
              }
            }
          } else if (
            ["test", "tests", "spec", "__tests__", "__snapshots__", "__mocks__"].includes(entry.name)
          ) {
            // 只删除明确的测试目录。嵌套 node_modules 仍可能承载版本无法提升的生产依赖
            // （例如 DSH attachment-local 的 sharp），删除它会让重打包后的 asar 缺模块。
            try {
              const testDirSize = await dirSize(full);
              await rmDir(full);
              removedInDir += testDirSize;
            } catch { /* 忽略 */ }
          } else {
            // 递归进入普通目录
            removedInDir += await cleanNodeModules(full);
          }
        }
      } catch { /* 无权限则跳过 */ }
      return removedInDir;
    }

    const docBytes = await cleanNodeModules(nmExtractDir);
    if (docBytes > 0) {
      totalRemoved += docBytes;
      console.log(`  [afterPack] 已删除 node_modules 中文档/SourceMap (${(docBytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  // --- 3b2. 删除 asar 内 node-pty 非当前平台的 prebuild（.node 文件被 electron-builder 自动解包到 asar.unpacked，
  //    但 asar 内仍保留了所有平台的副本，平台过滤只在 afterPack 上一步做了 asar.unpacked 的清理）---
  const nodePtyPrebuildDir = path.join(extractDir, "node_modules", "node-pty", "prebuilds");
  if (fs.existsSync(nodePtyPrebuildDir)) {
    try {
      const entries = await fs.promises.readdir(nodePtyPrebuildDir, { withFileTypes: true });
      const keepPrefix = CURRENT_PLATFORM;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === keepPrefix) continue;
        const fullPath = path.join(nodePtyPrebuildDir, entry.name);
        const size = await dirSize(fullPath);
        await rmDir(fullPath);
        totalRemoved += size;
        console.log(`  [afterPack] asar 内已删除 prebuild: ${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch { /* 目录不存在则跳过 */ }
  }

  // --- 3b3. sharp 原生绑定 realpath 补丁（asar 内副本）---
  // electron-builder 的 asarUnpack 是影子目录机制：asar 内保留完整副本，asar.unpacked 为镜像。
  // require('@img/sharp-win32-x64/sharp.node') 解析命中 asar 内副本（虚拟路径），
  // Electron dlopen 补丁会把 .node 复制到 %TEMP% 再加载，同目录 libvips DLL 不跟随 →
  // ERR_DLOPEN_FAILED（DSH host 启动即退）。补丁改为 realpath 到 asar.unpacked 真实路径后再 require。
  let sharpIndexPatched = false;
  const extractSharpIndex = path.join(extractDir, "node_modules", "@img", "sharp-win32-x64", "index.cjs");
  if (fs.existsSync(extractSharpIndex)) {
    const original = fs.readFileSync(extractSharpIndex, "utf8");
    const patched = patchSharpIndexCjs(original);
    if (patched !== original) {
      fs.writeFileSync(extractSharpIndex, patched);
      sharpIndexPatched = true;
      console.log(`[afterPack] sharp index.cjs（asar 内）: 已打 resourcesPath 补丁`);
    }
  }

  // --- 3c. 重新打包 asar（保留 electron-builder 的 unpacked 标记）---
  if (totalRemoved > 0 || sharpIndexPatched) {
    const tmpAsar = asarPath + ".tmp";
    await packAsarPreservingUnpacked(extractDir, tmpAsar, unpackedPatterns);
    const oldSize = fs.statSync(asarPath).size;
    fs.renameSync(tmpAsar, asarPath);
    // @electron/asar 会按路径缓存 header；重命名新归档后必须失效旧缓存，
    // 否则同一 afterPack 进程后续读取仍会看到被删除的文档和旧 unpack 标记。
    asar.uncache(asarPath);
    await removeAsarRepackArtifacts(asarPath);
    const newSize = fs.statSync(asarPath).size;
    console.log(`[afterPack] asar: 节省 ${(totalRemoved / 1024 / 1024).toFixed(1)} MB (${(oldSize / 1024 / 1024).toFixed(0)} → ${(newSize / 1024 / 1024).toFixed(0)} MB)`);
  } else {
    console.log(`[afterPack] asar: 无冗余可清理`);
  }

  // 清理临时目录，以及 createPackageWithOptions 写 dest=app.asar.tmp 时留下的影子目录。
  await rmDir(extractDir);
  await removeAsarRepackArtifacts(asarPath);
  } // end of 非 PI_FAST_PACK 分支

  // ====================================
  // 4. node-pty 跨平台 prebuild 清理（asar.unpacked）
  // 在 Windows 打包时只保留 win32-x64，删除其余 3 个平台的预编译二进制。
  // ====================================
  const nodePtyDir = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");
  if (fs.existsSync(nodePtyDir)) {
    try {
      const entries = await fs.promises.readdir(nodePtyDir, { withFileTypes: true });
      const keepPrefix = CURRENT_PLATFORM;

      let removed = 0;
      let totalPrebuildBytes = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === keepPrefix) {
          console.log(`  [afterPack] 已保留 prebuild: ${entry.name}`);
          continue;
        }
        const fullPath = path.join(nodePtyDir, entry.name);
        const size = await dirSize(fullPath);
        await rmDir(fullPath);
        totalPrebuildBytes += size;
        removed++;
        console.log(`  [afterPack] 已删除 prebuild: ${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }

      if (removed > 0) {
        console.log(`[afterPack] node-pty prebuilds: 已删除 ${removed} 个 (${(totalPrebuildBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch { /* 目录不存在则跳过 */ }
  }

  // ====================================
  // 5. node-pty 内 source map 清理（asar.unpacked）
  // ====================================
  const nodePtyUnpacked = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty");
  if (fs.existsSync(nodePtyUnpacked)) {
    let mapFiles = 0;
    let mapBytes = 0;

    async function walk(dir) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.name.endsWith(".map")) {
            const stat = await fs.promises.stat(full);
            mapBytes += stat.size;
            await fs.promises.unlink(full);
            mapFiles++;
          }
        }
      } catch { /* */ }
    }

    await walk(nodePtyUnpacked);
    if (mapFiles > 0) {
      console.log(`  [afterPack] node-pty source map: 已删除 ${mapFiles} 个 (${(mapBytes / 1024).toFixed(0)} KB)`);
    }
  }

  // ====================================
  // 6. sharp 原生绑定 realpath 补丁（asar.unpacked 镜像）
  //    与 3b3 同理（asar 内副本在 repack 前已打补丁）；这里对 unpacked 镜像也打一份，
  //    保证无论 require 解析命中哪份都走真实磁盘路径（幂等，重复打包安全）。
  // ====================================
  const sharpImgDir = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@img",
    "sharp-win32-x64",
  );
  const sharpIndexCjs = path.join(sharpImgDir, "index.cjs");
  if (fs.existsSync(sharpIndexCjs)) {
    const original = fs.readFileSync(sharpIndexCjs, "utf8");
    const patched = patchSharpIndexCjs(original);
    if (patched !== original) {
      fs.writeFileSync(sharpIndexCjs, patched);
      console.log(`[afterPack] sharp index.cjs: 已打 resourcesPath 补丁`);
    }
  }
};
