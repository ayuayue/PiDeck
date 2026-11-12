import { readFileSync } from "node:fs";

/**
 * session 域 IPC 源码聚合口。
 *
 * `sessionIpc.ts` 已按通道域拆成多个平面文件（dsh / dshRuntime / 导入器 / 归档 / 历史读取 / 入参守卫）；
 * 契约测试断言的是「这条通道在主进程注册成什么样」，不是「它在哪个文件里」，所以统一读这里的
 * 聚合结果。**显式列文件名、不递归目录**：新拆出的文件必须在这里登记，否则契约测试会悄悄
 * 看不到它的 handler（漏登记 = 断言假绿）。
 */
export const sessionIpcSourcePaths = [
	"src/main/ipc/sessionIpc.ts",
	"src/main/ipc/sessionListIpc.ts",
	"src/main/ipc/sessionCatalogWriteIpc.ts",
	"src/main/ipc/sessionMessageReadIpc.ts",
	"src/main/ipc/sessionMessageMutationIpc.ts",
	"src/main/ipc/sessionRunIpc.ts",
	"src/main/ipc/sessionDshIpc.ts",
	"src/main/ipc/sessionDshRuntimeIpc.ts",
	"src/main/ipc/sessionImportersIpc.ts",
	"src/main/ipc/sessionCatalogArchiveIpc.ts",
	"src/main/ipc/sessionHistoryReadIpc.ts",
	"src/main/ipc/sessionIpcInputGuards.ts",
];

/** 按「文件 → 源码」列出（路径随行，方便定位断言失败来自哪个文件）。 */
export const sessionIpcSources = sessionIpcSourcePaths.map((path) => ({ path, source: readFileSync(path, "utf8") }));

/** 拼接串：断言用，带文件头注释便于定位。 */
export const sessionIpcSource = sessionIpcSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
