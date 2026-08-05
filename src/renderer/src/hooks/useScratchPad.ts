import { useCallback, useEffect, useRef, useState } from "react";
import { toggleTaskCheckbox as toggleTaskLine } from "../components/scratchPad/scratchPadLists";
import type { DraftMeta, ScratchPadData } from "../../../shared/types";

const AUTOSAVE_DELAY = 1500;

type UseScratchPadMode = "edit" | "preview";

type UseScratchPadResult = {
	isOpen: boolean;
	isClosing: boolean;
	drafts: DraftMeta[];
	currentDraftPath: string | null;
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
	/** 切换当前草稿，同时保存当前草稿 */
	selectDraft: (draftPath: string) => Promise<void>;
	/** 创建新草稿 */
	createDraft: () => Promise<void>;
	/** 删除指定草稿，如果删除的是当前草稿则自动切换到第一个可用草稿 */
	deleteDraft: (draftPath: string) => Promise<void>;
};

export function useScratchPad(): UseScratchPadResult {
	const [isOpen, setIsOpen] = useState(false);
	const [isClosing, setIsClosing] = useState(false);
	const [drafts, setDrafts] = useState<DraftMeta[]>([]);
	const [currentDraftPath, setCurrentDraftPath] = useState<string | null>(null);
	const [content, setContentState] = useState("");
	const [mode, setMode] = useState<UseScratchPadMode>("edit");
	const [isSaving, setIsSaving] = useState(false);
	const [hasError, setHasError] = useState(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 用于回调中获取最新 content/currentDraftPath，避免闭包过期
	const contentRef = useRef(content);
	contentRef.current = content;
	const currentDraftPathRef = useRef(currentDraftPath);
	currentDraftPathRef.current = currentDraftPath;

	/** 加载草稿列表 */
	const loadDrafts = useCallback(async (): Promise<DraftMeta | null> => {
		if (!window.piDesktop?.scratchPad) return null;
		try {
			const list = await window.piDesktop.scratchPad.list();
			setDrafts(list);
			// 如果当前没有选中草稿，自动选中第一个
			if (list.length > 0 && !currentDraftPathRef.current) {
				const first = list[0];
				setCurrentDraftPath(first.path);
				return first;
			}
			// 如果当前选中的草稿不存在了（已被删除），切换到第一个
			if (list.length > 0 && currentDraftPathRef.current) {
				const stillExists = list.some(d => d.path === currentDraftPathRef.current);
				if (!stillExists) {
					const first = list[0];
					setCurrentDraftPath(first.path);
					return first;
				}
			}
			return null;
		} catch {
			return null;
		}
	}, []);

	/** 加载指定草稿的内容 */
	const loadContent = useCallback(async (draftPath: string) => {
		if (!window.piDesktop?.scratchPad) return;
		try {
			const data = await window.piDesktop.scratchPad.load(draftPath);
			setContentState(data.content ?? "");
		} catch {
			setContentState("");
		}
	}, []);

	// 启动时加载草稿列表并选中第一个
	useEffect(() => {
		if (!window.piDesktop?.scratchPad) return;
		void loadDrafts().then((firstDraft) => {
			if (firstDraft) {
				void loadContent(firstDraft.path);
			}
		});
	}, [loadDrafts, loadContent]);

	/** 立即保存指定草稿 */
	const flushSave = useCallback(async (draftPath: string, value: string) => {
		if (!window.piDesktop?.scratchPad || !draftPath) return;
		setIsSaving(true);
		setHasError(false);
		try {
			await window.piDesktop.scratchPad.save(draftPath, value, 0);
			// 保存后刷新列表以更新 updatedAt 时间
			void loadDrafts();
		} catch {
			setHasError(true);
		} finally {
			setIsSaving(false);
		}
	}, [loadDrafts]);

	const setContent = useCallback(
		(value: string) => {
			setContentState(value);
			setHasError(false);
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const path = currentDraftPathRef.current;
			if (!path) return;
			saveTimerRef.current = setTimeout(() => {
				void flushSave(path, value);
			}, AUTOSAVE_DELAY);
		},
		[flushSave],
	);

	const close = useCallback(() => {
		if (isClosing) return;
		setIsClosing(true);
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		const path = currentDraftPathRef.current;
		const value = contentRef.current;
		if (path) {
			void flushSave(path, value);
		}
		setTimeout(() => {
			setIsOpen(false);
			setIsClosing(false);
		}, 200);
	}, [contentRef, flushSave, isClosing]);

	const open = useCallback(() => {
		setIsClosing(false);
		setIsOpen(true);
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
		const path = currentDraftPathRef.current;
		if (!path) return Promise.resolve();
		return flushSave(path, contentRef.current);
	}, [flushSave]);

	const exportFile = useCallback(async () => {
		await saveNow();
		const path = currentDraftPathRef.current;
		if (path) {
			await window.piDesktop?.scratchPad?.export(path);
		}
	}, [saveNow]);

	/** 切换草稿：先保存当前，再加载新草稿 */
	const selectDraft = useCallback(async (draftPath: string) => {
		if (draftPath === currentDraftPathRef.current) return;
		// 先保存当前草稿
		const currentPath = currentDraftPathRef.current;
		const currentValue = contentRef.current;
		if (currentPath && currentValue) {
			await flushSave(currentPath, currentValue);
		}
		setCurrentDraftPath(draftPath);
		await loadContent(draftPath);
	}, [flushSave, loadContent]);

	/** 创建新草稿 */
	const createDraft = useCallback(async () => {
		if (!window.piDesktop?.scratchPad) return;
		// 先保存当前草稿
		const currentPath = currentDraftPathRef.current;
		const currentValue = contentRef.current;
		if (currentPath && currentValue) {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			await flushSave(currentPath, currentValue);
		}
		const newDraft = await window.piDesktop.scratchPad.create();
		setDrafts(prev => [newDraft, ...prev]);
		setCurrentDraftPath(newDraft.path);
		setContentState("");
	}, [flushSave]);

	/** 删除草稿 */
	const deleteDraft = useCallback(async (draftPath: string) => {
		if (!window.piDesktop?.scratchPad) return;
		await window.piDesktop.scratchPad.delete(draftPath);
		// 本地更新列表
		setDrafts(prev => prev.filter(d => d.path !== draftPath));
		// 如果删除的是当前草稿，切换到第一个可用草稿
		if (draftPath === currentDraftPathRef.current) {
			// 读取最新状态中的列表
			const updatedList = drafts.filter(d => d.path !== draftPath);
			if (updatedList.length > 0) {
				const first = updatedList[0];
				setCurrentDraftPath(first.path);
				await loadContent(first.path);
			} else {
				setCurrentDraftPath(null);
				setContentState("");
			}
		}
	}, [drafts, loadContent]);

	// 应用退出前保存
	useEffect(() => {
		const handler = () => {
			const path = currentDraftPathRef.current;
			const value = contentRef.current;
			if (path && window.piDesktop?.scratchPad) {
				void window.piDesktop.scratchPad.save(path, value, 0);
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, []);

	const setModeValue = useCallback((m: UseScratchPadMode) => setMode(m), []);

	/* 切换指定行（task list 项）的选中状态：直接根据源 markdown 行号反转 */
	const toggleTaskCheckbox = useCallback((lineIndex: number) => {
		setContent(toggleTaskLine(content, lineIndex));
	}, [content, setContent]);

	return {
		isOpen,
		isClosing,
		drafts,
		currentDraftPath,
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
		selectDraft,
		createDraft,
		deleteDraft,
	};
}
