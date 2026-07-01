import { useCallback, useEffect, useRef, useState } from "react";
import type { ScratchPadData } from "../../../shared/types";

const AUTOSAVE_DELAY = 1500;

type UseScratchPadMode = "edit" | "preview";

type UseScratchPadResult = {
	isOpen: boolean;
	isClosing: boolean;
	content: string;
	mode: UseScratchPadMode;
	isSaving: boolean;
	hasError: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	setContent: (value: string) => void;
	setMode: (mode: UseScratchPadMode) => void;
	toggleTaskCheckbox: (lineIndex: number) => void;
	saveNow: () => Promise<void>;
	exportFile: () => Promise<void>;
};

export function useScratchPad(): UseScratchPadResult {
	const [isOpen, setIsOpen] = useState(false);
	const [isClosing, setIsClosing] = useState(false);
	const [content, setContentState] = useState("");
	const [mode, setMode] = useState<UseScratchPadMode>("edit");
	const [isSaving, setIsSaving] = useState(false);
	const [hasError, setHasError] = useState(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isFirstLoadRef = useRef(true);

	// 启动时加载
	useEffect(() => {
		if (!window.piDesktop?.scratchPad) return;
		window.piDesktop.scratchPad.load().then((data: ScratchPadData) => {
			setContentState(data.content ?? "");
		});
	}, []);

	const flushSave = useCallback(async (value: string) => {
		if (!window.piDesktop?.scratchPad) return;
		setIsSaving(true);
		setHasError(false);
		try {
			await window.piDesktop.scratchPad.save(value, 0);
		} catch {
			setHasError(true);
		} finally {
			setIsSaving(false);
		}
	}, []);

	const setContent = useCallback(
		(value: string) => {
			setContentState(value);
			setHasError(false);
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void flushSave(value);
			}, AUTOSAVE_DELAY);
		},
		[flushSave],
	);

	const close = useCallback(() => {
		if (isClosing) return;
		setIsClosing(true);
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		void flushSave(content);
		setTimeout(() => {
			setIsOpen(false);
			setIsClosing(false);
		}, 200);
	}, [content, flushSave, isClosing]);

	const open = useCallback(() => {
		setIsClosing(false);
		setIsOpen(true);
		isFirstLoadRef.current = false;
	}, []);

	const toggle = useCallback(() => {
		if (isOpen) {
			close();
		} else {
			open();
		}
	}, [isOpen, open, close]);

	const saveNow = useCallback(() => {
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		return flushSave(content);
	}, [content, flushSave]);

	const exportFile = useCallback(async () => {
		await saveNow();
		await window.piDesktop?.scratchPad?.export();
	}, [saveNow]);

	// 应用退出前保存
	useEffect(() => {
		const handler = () => {
			if (content && window.piDesktop?.scratchPad) {
				void window.piDesktop.scratchPad.save(content, 0);
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [content]);

	const setModeValue = useCallback((m: UseScratchPadMode) => setMode(m), []);

	/* 切换指定行（task list 项）的选中状态：直接根据源 markdown 行号反转 */
	const toggleTaskCheckbox = useCallback((lineIndex: number) => {
		const lines = content.split('\n');
		if (lineIndex < 0 || lineIndex >= lines.length) return;
		lines[lineIndex] = lines[lineIndex].replace(/\[([ xX])\]/, (_, mark) => (mark.trim() === '' ? '[x]' : '[ ]'));
		setContent(lines.join('\n'));
	}, [content, setContent]);

	return {
		isOpen,
		isClosing,
		content,
		mode,
		isSaving,
		hasError,
		open,
		close,
		toggle,
		setContent,
		setMode: setModeValue,
		toggleTaskCheckbox,
		saveNow,
		exportFile,
	};
}
