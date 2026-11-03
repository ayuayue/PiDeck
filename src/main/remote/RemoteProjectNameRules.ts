import { REMOTE_PROJECT_TRASH_DIR } from "./RemoteProjectEntryCommands";
import { REMOTE_UPLOAD_TEMP_NAME } from "./RemoteProjectUploadNames";

/**
 * 「用户可见的远端条目」判据（新增只读面共用）。
 *
 * 两类条目不属于用户数据：PiDeck 自己的回收站命名空间（只在根层隐藏）与本通道自己的上传临时文件。
 * 既有列表/搜索过滤点各自保留原实现（守卫测试按文件计数那两处），新增的内容搜索命中过滤走这里，
 * 避免第三份复制；判据本身与两处既有实现逐字一致：
 * - 回收站：首段等于 REMOTE_PROJECT_TRASH_DIR；
 * - 上传临时名：末段匹配 REMOTE_UPLOAD_TEMP_NAME（(\.<32 hex>\.pideck-put$)，用户自己的同后缀文件不算）。
 */
export function isUserVisibleRemoteEntry(relativePath: string): boolean {
	const segments = relativePath.split("/");
	if (segments[0] === REMOTE_PROJECT_TRASH_DIR) return false;
	const name = segments[segments.length - 1] ?? "";
	return !REMOTE_UPLOAD_TEMP_NAME.test(name);
}
