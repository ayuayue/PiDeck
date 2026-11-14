import { readFileSync } from "node:fs";

/**
 * DshHost 拆分后的源码聚合面：契约测试断言的「实现形态」分散在宿主与各域协作者里，
 * 统一从这里按固定顺序读取，避免每搬一刀就改一遍 `readFileSync` 目标。
 *
 * 顺序：宿主在前（编排 / 生命周期 / fork 装配与顺序断言），其后是已落地的域协作者
 * （新增协作者追加到末尾；需要跨文件顺序断言的用例依赖这个顺序）。
 */
const entryPath = "src/main/dsh/DshHost.ts";
const collaboratorPaths = ["src/main/dsh/dshHostEnv.ts", "src/main/dsh/dshHostSettings.ts", "src/main/dsh/dshHostCatalog.ts", "src/main/dsh/dshHostArchive.ts", "src/main/dsh/dshHostPlugins.ts", "src/main/dsh/dshHostSessions.ts"];

export const dshHostSources = [entryPath, ...collaboratorPaths].map((path) => ({ path, source: readFileSync(path, "utf8") }));

export const dshHostSource = dshHostSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
