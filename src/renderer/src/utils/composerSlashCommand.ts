/**
 * 输入框斜杠命令分类（纯函数，可单测）。
 *
 * 为什么要单独一层：`/new`、`/compact` 早就是「桌面接管、不发给模型」的命令，
 * pi 通过 RPC 上报的命令表里也包含 `/login`（所以 `/` 菜单里能看到它），
 * 但输入框之前只拦了前两个，导致 `/login` 被当普通文本发给模型——用户看到的是
 * 「命令被模型回答了」。这里把「哪些命令由桌面接管」收敛成一处判定，
 * 新增接管命令时只改这一个文件 + 对应处理分支。
 *
 * 注意：不在这里判定 `/logout` 这类需要更多上下文的命令；未列出的命令一律
 * 归类为 `text`（照旧发给 pi）。
 */

/** 桌面接管的斜杠命令。 */
export type ComposerSlashCommand =
	/** `/new`：新建 Agent 会话（桌面 chrome）。 */
	| { kind: "new" }
	/** `/compact [prompt]`：走运行时压缩命令，prompt 为可选自定义提示词。 */
	| { kind: "compact"; prompt: string }
	/** `/login [providerId]`：打开凭证登录弹框；带参数时预选该供应商。 */
	| { kind: "login"; providerId?: string }
	/** 普通消息：照旧发给 pi（含 pi 自己实现的其他斜杠命令）。 */
	| { kind: "text" };

/** 供应商 id 形态与主进程校验保持一致（小写连字符标识符）。 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 分类一条待发送文本。
 *
 * 只认「命令 + 参数」的完整形态：`/loginx` 或 `/login-foo bar` 不匹配（避免
 * 把名字相近的普通文本误吞），`/compact` 后面的内容按 pi 的语义作为提示词。
 */
export function classifyComposerSlashCommand(message: string): ComposerSlashCommand {
	const trimmed = message.trim();
	if (/^\/new\s*$/.test(trimmed)) return { kind: "new" };
	if (/^\/compact(?:\s|$)/.test(trimmed)) {
		return { kind: "compact", prompt: trimmed.replace(/^\/compact\s*/, "").trim() };
	}
	if (/^\/login(?:\s|$)/.test(trimmed)) {
		// 只取第一个词作为供应商预选；不合法就当没带参数（弹框自己在列表里选）。
		const argument =
			trimmed
				.replace(/^\/login\s*/, "")
				.trim()
				.split(/\s+/)[0] ?? "";
		return PROVIDER_ID_PATTERN.test(argument) ? { kind: "login", providerId: argument } : { kind: "login" };
	}
	return { kind: "text" };
}
