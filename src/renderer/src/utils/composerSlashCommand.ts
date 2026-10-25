/**
 * 输入框斜杠命令分类（纯函数，可单测）。
 *
 * 为什么要单独一层：`/new`、`/compact` 早就是「桌面接管、不发给模型」的命令，
 * pi 通过 RPC 上报的命令表里也包含 `/login`（所以 `/` 菜单里能看到它），
 * 但输入框之前只拦了前两个，导致 `/login` 被当普通文本发给模型——用户看到的是
 * 「命令被模型回答了」。这里把「哪些命令由桌面接管」收敛成一处判定，
 * 新增接管命令时只改这一个文件 + 对应处理分支。
 *
 * `/hotkeys` 同类：pi 的 builtin 斜杠命令（`dist/core/slash-commands.js` 的
 * BUILTIN_SLASH_COMMANDS）只在交互式 TUI 里被处理（只被 modes/interactive 引用），
 * RPC 的 prompt 路径只尝试 extension 命令与模板/技能展开（docs/rpc-commands.md 也
 * 明说 builtin 命令「would not execute if sent via prompt」），所以它必须桌面接管，
 * 否则同样落到「命令被模型回答」。其余同类 builtin（copy/export/share/session/
 * settings/clone）桌面已有等价入口，直接在 AppUtils 的隐藏表里不列（见
 * HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES）。
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
	/** `/hotkeys`：打开设置里的快捷键页（pi 的 builtin 在 RPC 模式下不执行）。 */
	| { kind: "hotkeys" }
	/** `/reload`：热重载 pi 扩展/技能/提示词/主题/上下文文件（不发给模型）。 */
	| { kind: "reload" }
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
	if (/^\/hotkeys\s*$/.test(trimmed)) return { kind: "hotkeys" };
	// `/reload` 不接受参数，但 `pi` 的扩展命令会忽略多余参数；这里同样把 `/reload ...`
	// 归到 reload，避免带参数时掉回普通 prompt 而写出一条乐观用户气泡。`/reloadx`
	// 这类名字相近的正文仍按普通文本处理。
	if (/^\/reload(?:\s|$)/.test(trimmed)) return { kind: "reload" };
	return { kind: "text" };
}
