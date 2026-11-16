import { readFileSync } from "node:fs";

/**
 * PiLocator 拆分后的源码聚合面：契约测试断言的「实现形态」分散在宿主与各域模块里，
 * 统一从这里按文件名顺序读取，避免每搬一刀就改一遍 `readFileSync` 目标。
 *
 * 顺序：宿主在前（定位编排 / 启动形态 / 安装列表），其后是已落地的域模块（新增域追加到末尾）。
 */
const entryPath = "src/main/pi/PiLocator.ts";
const domainPaths = ["src/main/pi/piLocator/piWindowsShim.ts", "src/main/pi/piLocator/piCustomPath.ts", "src/main/pi/piLocator/piLaunchEnv.ts", "src/main/pi/piLocator/piSearchDirs.ts", "src/main/pi/piLocator/piVersionCheck.ts"];

export const piLocatorSources = [entryPath, ...domainPaths].map((path) => ({ path, source: readFileSync(path, "utf8") }));

export const piLocatorSource = piLocatorSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
