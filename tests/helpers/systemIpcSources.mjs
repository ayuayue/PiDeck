import { readFileSync } from "node:fs";

/**
 * 「system 域」IPC 源码聚合：拆成多文件后，源码契约测试仍按原单文件口径断言。
 *
 * 只聚合明确列出的文件（不递归目录）：systemIpc.ts 的 handler 已按域拆到下面这些
 * 兄弟文件，顺序按拆分前的文档顺序排列，保证基于 indexOf/slice 的契约断言语义不变。
 */
export const systemIpcSourcePaths = ["src/main/ipc/systemIpc.ts", "src/main/ipc/systemPiIpc.ts", "src/main/ipc/systemPiRuntimeIpc.ts", "src/main/ipc/systemAppIpc.ts", "src/main/ipc/systemLogsIpc.ts", "src/main/ipc/systemConfigIpc.ts", "src/main/ipc/systemConfigProviderIpc.ts", "src/main/ipc/systemConfigTokensIpc.ts"];

export const systemIpcSource = systemIpcSourcePaths.map((path) => readFileSync(path, "utf8")).join("\n");
