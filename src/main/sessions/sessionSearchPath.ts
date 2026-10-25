import { isUnambiguousAbsoluteSessionPath } from "../../shared/sessionIdentity";

/** 会话内查找路径的长度上界：正常会话绝对路径远小于此，超长一律拒绝。 */
const MAX_SESSION_SEARCH_PATH_LENGTH = 4096;

/**
 * 会话内查找（sessions:search-in-session）的 IPC 边界校验。
 *
 * 口径：只放行「无歧义绝对路径 + .jsonl」。绝对路径判定复用 catalog 身份用的
 * isUnambiguousAbsoluteSessionPath（盘符 / UNC / 正斜杠根），所以 Windows 反斜杠路径
 * 与 POSIX 正斜杠路径都放行；历史实现手写 `/[\/]/` 只认正斜杠，Windows 上
 * record.filePath 是反斜杠，所有查找请求都在边界被判 null（回归：
 * tests/sessionSearchPath.test.mjs）。
 *
 * 为什么拒绝相对路径：sidecar 只匹配已索引的真实会话文件，相对路径无法定位是哪份文件；
 * 为什么必须限长：渲染层数据不可信，避免把任意超长串透传给子进程。
 */
export function isSessionSearchFilePath(value: string): boolean {
	if (!value || value.length > MAX_SESSION_SEARCH_PATH_LENGTH) return false;
	if (!/\.jsonl$/i.test(value)) return false;
	return isUnambiguousAbsoluteSessionPath(value);
}
