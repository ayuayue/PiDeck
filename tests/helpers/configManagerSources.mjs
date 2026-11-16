import { readFileSync } from "node:fs";

/**
 * ConfigManager 拆分后的源码聚合面：契约测试断言的「实现形态」分散在宿主与各域协作者里，
 * 统一从这里按文件名顺序读取，避免每搬一刀就改一遍 `readFileSync` 目标。
 *
 * 顺序：宿主在前（文件 IO / 校验 / 模型列表拉取），其后是已落地的域协作者（新增协作者追加到末尾）。
 */
const entryPath = "src/main/config/ConfigManager.ts";
const collaboratorPaths = ["src/main/config/configModelTypes.ts", "src/main/config/providerUsageHost.ts", "src/main/config/providerUsageEndpoint.ts", "src/main/config/providerUsageProbes.ts", "src/main/config/providerUsageQueries.ts"];

export const configManagerSources = [entryPath, ...collaboratorPaths].map((path) => ({ path, source: readFileSync(path, "utf8") }));

export const configManagerSource = configManagerSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
