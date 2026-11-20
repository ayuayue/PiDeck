import { useEffect, useEffectEvent, type RefObject } from "react";
import { localCloseActions } from "../utils/closeShortcut";

/** Register a stateful panel's close handler only while its DOM scope is available. */
export function useCloseShortcutAction(ref: RefObject<Element | null>, enabled: boolean, close: (id?: string) => void | Promise<void>) {
	const onClose = useEffectEvent(close);
	useEffect(() => {
		const scope = ref.current;
		if (!scope || !enabled) return;
		localCloseActions.set(scope, (id) => onClose(id));
		return () => {
			localCloseActions.delete(scope);
		};
	}, [ref, enabled]);
}
