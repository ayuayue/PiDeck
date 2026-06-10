export type SendShortcut =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type ComposerEnterIntent = "ignore" | "newline" | "send";

type ComposerKeyboardState = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
	which?: number;
	nativeEvent?: {
		isComposing?: boolean;
		keyCode?: number;
		which?: number;
	};
};

/**
 * 归一化输入框 Enter 键意图，避免 React 组件里散落快捷键判断。
 * IME 回车确认会先发出 composing 状态的 Enter，这时必须交给输入法处理，
 * 否则中文输入法里选择英文候选也会被误判为发送消息。
 */
export function getComposerEnterIntent(
	event: ComposerKeyboardState,
	sendShortcut: SendShortcut,
): ComposerEnterIntent {
	if (event.key !== "Enter") return "ignore";
	if (isComposingInput(event)) return "ignore";

	const shouldSend =
		sendShortcut === "enter-send"
			? !event.ctrlKey && !event.metaKey && !event.shiftKey
			: sendShortcut === "ctrl-enter-send"
				? event.ctrlKey || event.metaKey
				: event.shiftKey;

	if (shouldSend) return "send";
	return "newline";
}

function isComposingInput(event: ComposerKeyboardState) {
	// keyCode/which=229 是部分 Chromium/macOS 输入法在 composition 期间的兼容信号。
	return Boolean(
		event.isComposing ||
			event.nativeEvent?.isComposing ||
			event.key === "Process" ||
			event.keyCode === 229 ||
			event.which === 229 ||
			event.nativeEvent?.keyCode === 229 ||
			event.nativeEvent?.which === 229,
	);
}
