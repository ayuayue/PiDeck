import { createContext, forwardRef, useCallback, useContext, useMemo, type ComponentPropsWithoutRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { cn } from "@/lib/utils";

/**
 * Local layout contract for cards that live above the session composer.
 *
 * Collapse state lives here so a disclosure change re-renders the extras
 * wrapper and the footer can size to content in the same frame. Cards do not
 * own this state: the composer column is intrinsic, not a hug-measured panel.
 */
export type ComposerWidgetCollapsedByKey = Readonly<Record<string, boolean>>;

export function resolveComposerWidgetCollapsed(collapsedByKey: ComposerWidgetCollapsedByKey, key: string, defaultCollapsed: boolean): boolean {
	return collapsedByKey[key] ?? defaultCollapsed;
}

/**
 * Stores only deviations from a widget's default state. This keeps a long-lived
 * composer from retaining records after a user returns a card to its default.
 */
export function setComposerWidgetCollapsed(collapsedByKey: ComposerWidgetCollapsedByKey, key: string, collapsed: boolean, defaultCollapsed: boolean): ComposerWidgetCollapsedByKey {
	if (collapsed === defaultCollapsed) {
		return clearComposerWidgetCollapsed(collapsedByKey, key);
	}
	if (collapsedByKey[key] === collapsed) return collapsedByKey;
	return { ...collapsedByKey, [key]: collapsed };
}

/** Removes one disclosure record when its card no longer needs to retain it. */
export function clearComposerWidgetCollapsed(collapsedByKey: ComposerWidgetCollapsedByKey, key: string): ComposerWidgetCollapsedByKey {
	if (!Object.prototype.hasOwnProperty.call(collapsedByKey, key)) {
		return collapsedByKey;
	}
	const next = { ...collapsedByKey };
	delete next[key];
	return next;
}

/** Removes a retired family of records, such as Diff disclosures from an old run. */
export function clearComposerWidgetCollapsedByPrefix(collapsedByKey: ComposerWidgetCollapsedByKey, prefix: string): ComposerWidgetCollapsedByKey {
	const keysToClear = Object.keys(collapsedByKey).filter((key) => key.startsWith(prefix));
	if (keysToClear.length === 0) return collapsedByKey;

	const next = { ...collapsedByKey };
	for (const key of keysToClear) delete next[key];
	return next;
}

export function toggleComposerWidgetCollapsed(collapsedByKey: ComposerWidgetCollapsedByKey, key: string, defaultCollapsed: boolean): ComposerWidgetCollapsedByKey {
	return setComposerWidgetCollapsed(collapsedByKey, key, !resolveComposerWidgetCollapsed(collapsedByKey, key, defaultCollapsed), defaultCollapsed);
}

type ComposerWidgetLayoutValue = {
	collapsedByKey: ComposerWidgetCollapsedByKey;
	setCollapsed: (key: string, collapsed: boolean, defaultCollapsed: boolean) => void;
	toggleCollapsed: (key: string, defaultCollapsed: boolean) => void;
	clearCollapsed: (key: string) => void;
	clearCollapsedByPrefix: (prefix: string) => void;
};

const ComposerWidgetLayoutContext = createContext<ComposerWidgetLayoutValue | null>(null);

export function ComposerWidgetLayoutProvider(props: { value: ComposerWidgetLayoutValue; children: ReactNode }) {
	return <ComposerWidgetLayoutContext.Provider value={props.value}>{props.children}</ComposerWidgetLayoutContext.Provider>;
}

/** Returns the controlled collapse state for a session-scoped widget identity. */
export function useComposerWidgetCollapsed(key: string, defaultCollapsed = true) {
	const layout = useContext(ComposerWidgetLayoutContext);
	if (!layout) {
		throw new Error("useComposerWidgetCollapsed must be used under ComposerWidgetLayoutProvider");
	}

	const collapsed = resolveComposerWidgetCollapsed(layout.collapsedByKey, key, defaultCollapsed);
	const setCollapsed = useCallback((next: boolean) => layout.setCollapsed(key, next, defaultCollapsed), [defaultCollapsed, key, layout]);
	const toggleCollapsed = useCallback(() => layout.toggleCollapsed(key, defaultCollapsed), [defaultCollapsed, key, layout]);

	return {
		collapsed,
		setCollapsed,
		toggleCollapsed,
		clearCollapsed: layout.clearCollapsed,
		clearCollapsedByPrefix: layout.clearCollapsedByPrefix,
	};
}

/** Shared visual frame for all cards placed in the composer widget scrollport. */
export const ComposerWidgetFrame = forwardRef<HTMLElement, ComponentPropsWithoutRef<"section">>(function ComposerWidgetFrame({ className, ...props }, ref) {
	return <section ref={ref} {...props} className={cn("w-full shrink-0 overflow-hidden rounded-xl border border-border bg-card", className)} />;
});

/** Builds the stable context value owned by ComposerMeasuredExtras. */
export function useComposerWidgetLayoutValue(collapsedByKey: ComposerWidgetCollapsedByKey, setCollapsedByKey: Dispatch<SetStateAction<ComposerWidgetCollapsedByKey>>): ComposerWidgetLayoutValue {
	const setCollapsed = useCallback(
		(key: string, collapsed: boolean, defaultCollapsed: boolean) => {
			setCollapsedByKey((current) => setComposerWidgetCollapsed(current, key, collapsed, defaultCollapsed));
		},
		[setCollapsedByKey],
	);
	const toggleCollapsed = useCallback(
		(key: string, defaultCollapsed: boolean) => {
			setCollapsedByKey((current) => toggleComposerWidgetCollapsed(current, key, defaultCollapsed));
		},
		[setCollapsedByKey],
	);
	const clearCollapsed = useCallback(
		(key: string) => {
			setCollapsedByKey((current) => clearComposerWidgetCollapsed(current, key));
		},
		[setCollapsedByKey],
	);
	const clearCollapsedByPrefix = useCallback(
		(prefix: string) => {
			setCollapsedByKey((current) => clearComposerWidgetCollapsedByPrefix(current, prefix));
		},
		[setCollapsedByKey],
	);

	return useMemo(
		() => ({
			collapsedByKey,
			setCollapsed,
			toggleCollapsed,
			clearCollapsed,
			clearCollapsedByPrefix,
		}),
		[collapsedByKey, setCollapsed, toggleCollapsed, clearCollapsed, clearCollapsedByPrefix],
	);
}
