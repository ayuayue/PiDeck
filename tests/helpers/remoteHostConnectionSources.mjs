import { readFileSync } from "node:fs";

/**
 * RemoteHostConnectionService 拆分后的源码聚合面：契约测试断言的「实现形态」分散在宿主与各域协作者里，
 * 统一从这里按文件名顺序读取，避免每搬一刀就改一遍 `readFileSync` 目标。
 *
 * 顺序：宿主在前（连接状态机、池编排、公开方法体），其后是已落地的域协作者（新增协作者追加到末尾）。
 */
const entryPath = "src/main/remote/RemoteHostConnectionService.ts";
const collaboratorPaths = ["src/main/remote/remoteHostConnectionGuards.ts", "src/main/remote/RemoteHostSecrets.ts", "src/main/remote/RemoteHostConnectionFacts.ts", "src/main/remote/RemotePiSessionFacts.ts", "src/main/remote/RemoteSecurityPolicySnapshot.ts", "src/main/remote/RemoteProjectSessionBinding.ts"];

export const remoteHostConnectionSources = [entryPath, ...collaboratorPaths].map((path) => ({ path, source: readFileSync(path, "utf8") }));

export const remoteHostConnectionSource = remoteHostConnectionSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
