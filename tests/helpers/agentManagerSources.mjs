import { readFileSync } from "node:fs";

/**
 * AgentManager 拆分后的源码聚合面：契约测试断言的「实现形态」分散在宿主与各域协作者里，
 * 统一从这里按文件名顺序读取，避免每搬一刀就改一遍 `readFileSync` 目标。
 *
 * 顺序：宿主在前（编排/生命周期/agents map），其后是已落地的域协作者（新增协作者追加到末尾）。
 */
const entryPath = "src/main/pi/AgentManager.ts";
const collaboratorPaths = ["src/main/pi/toolMessageAssembler.ts", "src/main/pi/runtimeHistoryLoader.ts", "src/main/pi/compactionRunner.ts", "src/main/pi/runtimeStateReader.ts"];

export const agentManagerSources = [entryPath, ...collaboratorPaths].map((path) => ({ path, source: readFileSync(path, "utf8") }));

export const agentManagerSource = agentManagerSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
