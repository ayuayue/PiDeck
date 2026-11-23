/**
 * 远端 Git 的失败信封：闭集稳定码 + 可选的 helper 原文（已由 helper 截断到 4 KiB）。
 *
 * 原文只给用户看；分类、重放与 unknown 判定仍然只看 `code`。没有原文时字段缺席，界面回落到词典文案。
 */
import { getAppLogger } from "../logging/sharedLogger";
import { remoteGitFailureCode } from "../git/RemoteGitService";

export type RemoteGitFailureEnvelope = { ok: false; code: string; message?: string };

export function failureEnvelope(error: unknown): RemoteGitFailureEnvelope {
	const code = remoteGitFailureCode(error);
	audit(code);
	const detail = (error as { detail?: unknown } | null)?.detail;
	return typeof detail === "string" && detail.length > 0 ? { ok: false, code, message: detail.slice(0, 4096) } : { ok: false, code };
}

/**
 * 失败审计：面板把未入词典的码折成一句通用文案（“未能读取远端 Git。未获得有效快照”），
 * 没有这条日志就再也查不到到底是哪个码失败了——2026-11-22 的图谱空白排查就卡在这里
 * （真实原因是冷启动时 SSH 主机未就绪：`SSH_HOST_NOT_READY`，4 秒后才 ready）。
 *
 * 只记稳定码，不带路径、不带 helper 原文；审计本身是观察者，它抛错不能改变调用方看到的失败。
 */
function audit(code: string): void {
	try {
		void getAppLogger()?.warn("git", "remote git request failed", { code });
	} catch {
		// 观察者不是事务的一部分。
	}
}
