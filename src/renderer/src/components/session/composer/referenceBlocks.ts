/**
 * 兼容入口：自包含块解析已下沉到 `shared/expandedRefBlocks`（主进程与渲染进程共用一份实现）。
 * 保留此模块与既有导出名，避免改动调用方 import 路径。
 */
export * from "../../../../../shared/expandedRefBlocks";
