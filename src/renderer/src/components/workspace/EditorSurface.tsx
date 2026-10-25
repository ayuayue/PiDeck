import { useCallback, useEffect, useMemo, useRef } from "react";
import { FileDiffViewer } from "../app/FileDiffViewer";
import type { WorkspaceEditorTab, WorkspaceEditorMode } from "../../hooks/useWorkspacePanels";

export type EditorSurfaceProps = {
	tab: WorkspaceEditorTab;
	tabs: WorkspaceEditorTab[];
	displayMode?: "drawer" | "modal" | "split" | "maximize";
	theme?: "light" | "dark";
	maxFileSizeMB?: number;
	onToggleMode?: () => void;
	onBack?: () => void;
	onClose: () => void;
	onSelectTab: (id: string) => void;
	onCloseTab: (id: string) => void;
	readContent: (path: string) => Promise<string>;
	readOriginalContent?: (path: string) => Promise<string>;
	saveContent?: (path: string, content: string) => Promise<void>;
};

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T) {
	const callbackRef = useRef(callback);
	useEffect(() => {
		callbackRef.current = callback;
	}, [callback]);
	return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

/** FileDiffViewer stays a leaf; this surface only supplies stable IO and tab wiring. */
export function EditorSurface(props: EditorSurfaceProps) {
	const readContent = useStableCallback(props.readContent);
	const readOriginalContent = useStableCallback(props.readOriginalContent ?? (() => Promise.resolve("")));
	const saveContent = useStableCallback(props.saveContent ?? (() => Promise.resolve()));
	const onClose = useStableCallback(props.onClose);
	const onSelectTab = useStableCallback(props.onSelectTab);
	const onCloseTab = useStableCallback(props.onCloseTab);
	const onToggleModeCallback = useStableCallback(props.onToggleMode ?? (() => undefined));
	const onBackCallback = useStableCallback(props.onBack ?? (() => undefined));
	const onToggleMode = props.onToggleMode ? onToggleModeCallback : undefined;
	const onBack = props.onBack ? onBackCallback : undefined;
	const tabs = useMemo(() => props.tabs.map((tab) => ({ id: tab.id, filePath: tab.filePath, label: tab.label })), [props.tabs]);

	return (
		<FileDiffViewer
			displayMode={props.displayMode ?? "drawer"}
			filePath={props.tab.filePath}
			mode={props.tab.mode as WorkspaceEditorMode}
			onToggleMode={props.tab.preserveDrawer ? undefined : onToggleMode}
			onBack={onBack}
			originalContent={props.tab.mode === "diff" ? props.tab.originalContent : undefined}
			modifiedContent={props.tab.modifiedContent}
			tabs={tabs}
			activeTabId={props.tab.id}
			onSelectTab={onSelectTab}
			onCloseTab={onCloseTab}
			onClose={onClose}
			readContent={readContent}
			readOriginalContent={props.tab.mode === "diff" ? readOriginalContent : undefined}
			saveContent={props.tab.allowSave ? saveContent : undefined}
			theme={props.theme}
			maxFileSizeMB={props.maxFileSizeMB}
		/>
	);
}
