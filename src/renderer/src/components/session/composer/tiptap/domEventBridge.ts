/**
 * 把 ProseMirror 原生 KeyboardEvent 收成 Composer/React 处理层可用的形状。
 * 原生事件没有 React 的 nativeEvent 包装；直接读 .nativeEvent 会抛错并中断发送。
 */

export type ComposerDomKeyboardEvent = KeyboardEvent & {
	nativeEvent: KeyboardEvent;
};

export function toComposerDomKeyboardEvent(event: KeyboardEvent): ComposerDomKeyboardEvent {
	const patched = event as ComposerDomKeyboardEvent;
	if (!patched.nativeEvent) {
		Object.defineProperty(patched, "nativeEvent", {
			value: event,
			configurable: true,
			enumerable: false,
			writable: false,
		});
	}
	return patched;
}
