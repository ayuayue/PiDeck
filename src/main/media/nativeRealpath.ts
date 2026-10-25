import { realpathSync } from "node:fs";

/**
 * realpath 的 **native** 变体。
 *
 * 为什么不用 `fs/promises.realpath`：Windows 上普通实现只做词法/大小写归一，
 * **不展开路径中间段的 8.3 短名**——`C:\Users\ADMINI~1\AppData\Local\Temp\x`
 * 原样返回短名，而同一个文件用长名 `C:\Users\Administrator\…` 访问时返回长名。
 * 两侧拿同一份路径判定边界就会永远不相等（`pideck-file://` 白名单因此把临时目录
 * 里的图全判 403，2026-10-19 真机 smoke 实测）。
 *
 * `realpath.native` 走 `GetFinalPathNameByHandle`，返回真正的长名，是这里唯一正确的原语。
 * 调用量级是「每个请求几个短路径」，同步开销可忽略（不读文件内容）。
 */
export function nativeRealpath(path: string): string {
	return realpathSync.native(path);
}
