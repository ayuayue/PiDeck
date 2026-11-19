/**
 * 远端 Git 的失败信封：闭集稳定码 + 可选的 helper 原文（已由 helper 截断到 4 KiB）。
 *
 * 原文只给用户看；分类、重放与 unknown 判定仍然只看 `code`。没有原文时字段缺席，界面回落到词典文案。
 */
import { remoteGitFailureCode } from "../git/RemoteGitService";

export type RemoteGitFailureEnvelope = { ok: false; code: string; message?: string };

export function failureEnvelope(error: unknown): RemoteGitFailureEnvelope {
	const code = remoteGitFailureCode(error);
	const detail = (error as { detail?: unknown } | null)?.detail;
	return typeof detail === "string" && detail.length > 0 ? { ok: false, code, message: detail.slice(0, 4096) } : { ok: false, code };
}
