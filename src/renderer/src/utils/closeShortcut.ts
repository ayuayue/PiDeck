/** Ignore successive presses while focus is transferring to the next close target. */
export function createCloseShortcutGate() {
	let lastPress = -Infinity;
	return (now: number) => {
		const accepted = now - lastPress >= 350;
		lastPress = now;
		return accepted;
	};
}

export const localCloseActions = new WeakMap<Element, (id?: string) => void | Promise<void>>();

export const CLOSE_SCOPE = "[data-close-scope]";
export const CLOSE_LAYER = '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';
export const CLOSE_CONFIRMATION = '[role="alertdialog"][data-state="open"], [data-close-confirmation][data-state="open"]';

/** A normal click on an unfocusable pane gives Chromium's focus back to body. */
export function resolveCloseScope(active: Element | null, pointed: Element | null, body: Element): Element | null {
	const target = active && active !== body ? active : pointed;
	return target?.isConnected ? target.closest(CLOSE_SCOPE) : null;
}
