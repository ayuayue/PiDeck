import { useStore } from "jotai";
import { useCallback, useRef } from "react";
import type { ComposerAgentMode } from "../../../../../shared/types";
import { resolveBusySendDelivery } from "../../../../../shared/busySendDelivery";
import { isRendererVirtualSessionId } from "../../../../../shared/rendererVirtualSessionId";
import { busySendDeliveryAtom, type PastedTextFile } from "../../../atoms";
import { applySuggestion, clearSuggestionTrigger, detectTrigger, type SuggestionItem } from "../../../components/app/AppUtils";
import { formatFilePathRef } from "../../../components/session/composer/chips";
import type { ComposerCaretRequest } from "../../../components/session/composer/types";
import { getComposerCaretBlockEdge, getComposerCaretOffset, getComposerSelectionRange, isComposerAtVisualEdge } from "../../../components/session/composer/caretCoords";
import { getComposerEnterIntent, isComposingKeyboardEvent, isPlanModeSendKey, resolveComposerHistoryIntent } from "../../../composerBehavior";
import { desktopApi } from "../../../desktopApi";
import type { useSessionSend } from "../../useSessionSend";

/** 粘贴文件折叠进草稿时的单文件读取上限：主进程 stat 预检拦截超大文件，
 * 避免全量读入主进程再经 IPC 传输压垮两侧内存（超限/读失败走既有 catch → 内容不并入）。 */
const PASTE_FILE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;

type ComposerLiveDraftRef = { current: { sessionId: string; value: string } };

/**
 * 发送与键盘交互域：统一发送入口（晋升预览 Tab、粘贴文件折叠、生图/生视频转投）、
 * 补全菜单采纳/关闭、改稿同步（onChange）、@ 补全与历史回溯的键位接管（onKeyDown）。
 *
 * 这块是「谁能触发发送、按键归谁」的唯一判定点，所以整域一起搬：发送入口与键盘
 * 接管分居两文件会让「忙碌投递语义」变成两处判定。
 */
export interface ComposerSendInteractionOptions {
	sessionId: string;
	draft: string;
	setDraft: (value: string) => void;
	cursor: number;
	setCursor: (value: number) => void;
	editorRef: { current: HTMLDivElement | null };
	liveDomDraftRef: ComposerLiveDraftRef;
	caretRef: { current: ComposerCaretRequest | null };
	validSessionRefs: Set<string>;
	suggestionItems: SuggestionItem[];
	suggestionsOpen: boolean;
	setSuggestionsOpen: (open: boolean) => void;
	selectedSuggestionIndex: number;
	setSelectedSuggestionIndex: (value: number | ((index: number) => number)) => void;
	historyIndex: number;
	setHistoryIndex: (index: number) => void;
	savedDraft: string;
	setSavedDraft: (value: string) => void;
	getPromptHistory: () => string[];
	mode: ComposerAgentMode;
	isBusy: boolean;
	isAcpBackend: boolean;
	sendShortcut: "enter-send" | "ctrl-enter-send" | "shift-enter-send";
	pasteFiles: PastedTextFile[];
	setPasteFiles: (value: PastedTextFile[] | ((current: PastedTextFile[]) => PastedTextFile[])) => void;
	send: ReturnType<typeof useSessionSend>;
	onPromoteSession: ((sessionId: string) => void) | undefined;
	generateImage: () => void;
	submitVideo: () => void;
}

export function useComposerSendInteraction(options: ComposerSendInteractionOptions) {
	const {
		sessionId,
		draft,
		setDraft,
		cursor,
		setCursor,
		editorRef,
		liveDomDraftRef,
		caretRef,
		validSessionRefs,
		suggestionItems,
		suggestionsOpen,
		setSuggestionsOpen,
		selectedSuggestionIndex,
		setSelectedSuggestionIndex,
		historyIndex,
		setHistoryIndex,
		savedDraft,
		setSavedDraft,
		getPromptHistory,
		mode,
		isBusy,
		isAcpBackend,
		sendShortcut,
		pasteFiles,
		setPasteFiles,
		send,
		onPromoteSession,
		generateImage,
		submitVideo,
	} = options;
	const store = useStore();

	// 统一发送入口：先晋升预览 Tab 再投递（幂等，非预览无副作用）。
	// 发送按钮 / 追问按钮 / Enter 键 / 无 Agent 时的 /compact 直发都会走这里，
	// 避免新增发送路径时漏掉 promote 导致预览 Tab 不常驻（曾因此回归）。
	// 生图模式：所有发送入口统一转生图（不晋升预览 Tab、不发消息），避免各入口分支不一致。
	const promoteAndSend = useCallback(
		async (behavior?: "steer" | "followUp", overrideText?: string) => {
			// ACP 初始化中不再拦发送：冷启动发送本来就允许（useSessionSend 先发布 activating 状态，
			// 再由 ensureRuntime 等同一条 pending activation）。旧实现除了置灰按钮，还在这里静默 return，
			// 用户敲完回车毫无反馈，只像「输入框坏了」。
			if (mode === "imagegen") {
				void generateImage();
				return;
			}
			// 生视频模式：所有发送入口统一转生视频提交（不晋升预览 Tab、不发普通消息）。
			if (mode === "videogen") {
				void submitVideo();
				return;
			}
			// 粘贴文件折叠：把 chip 里的文件引用/内容并进草稿再发送。
			// 新写入一律在 userData（inProject=false）：折叠原样文本内联，pi 读不到 userData；
			// 遗留项目内 chip（inProject=true）仍走 @"path" 引用——pi 展开读取。
			// 快捷消息直发（overrideText 有值）不走这段：那条路径发送的是清单原文，
			// 把用户的粘贴内容并进去既违背「直发」语义，也会连带清掉他手里的 chip。
			if (overrideText === undefined && pasteFiles.length) {
				const refs: string[] = [];
				for (const file of pasteFiles) {
					if (file.inProject) {
						refs.push(formatFilePathRef(file.path));
					} else {
						const content = await desktopApi.files.readContent(file.path, PASTE_FILE_CONTENT_MAX_BYTES).catch(() => "");
						if (content) refs.push(content);
					}
				}
				const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
				const joined = [liveDraft.trim(), refs.join("\n\n")].filter(Boolean).join("\n\n");
				liveDomDraftRef.current = { sessionId, value: joined };
				setDraft(joined);
				// 已折叠进草稿：立即移除 chip（发送成功/失败都会在 clearSnapshot 兜底清空）
				setPasteFiles([]);
			}
			if (!isRendererVirtualSessionId(sessionId)) options.onPromoteSession?.(sessionId);
			return send(behavior, overrideText);
		},
		[draft, mode, generateImage, submitVideo, onPromoteSession, pasteFiles, send, sessionId, setDraft, setPasteFiles],
	);

	const selectSuggestion = useCallback(
		(item: SuggestionItem) => {
			const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
			const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
			// 目录引用（isDirectory）不带尾随空格：@src/ 之后继续敲路径段时建议框会
			// 随按键重新打开（onChange → detectTrigger），实现连续的目录下钻引用；
			// 带空格会让建议框立刻关闭，用户必须回删空格才能继续，容易误以为只能选一层。
			const result = applySuggestion(liveDraft, liveCursor, item.value, validSessionRefs, {
				noTrailingSpace: item.isDirectory === true,
			});
			liveDomDraftRef.current = { sessionId, value: result.text };
			setDraft(result.text);
			setCursor(result.cursor);
			caretRef.current = { pos: result.cursor, forValue: result.text };
			setSuggestionsOpen(false);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[cursor, draft, sessionId, setDraft, validSessionRefs],
	);

	const closeSuggestions = useCallback(() => {
		const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
		const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
		const result = clearSuggestionTrigger(liveDraft, liveCursor, validSessionRefs);
		liveDomDraftRef.current = { sessionId, value: result.text };
		setDraft(result.text);
		setCursor(result.cursor);
		caretRef.current = { pos: result.cursor, forValue: result.text };
		setSuggestionsOpen(false);
		requestAnimationFrame(() => editorRef.current?.focus());
	}, [cursor, draft, sessionId, setDraft, validSessionRefs]);

	const onChange = useCallback(
		(value: string, nextCursor: number) => {
			liveDomDraftRef.current = { sessionId, value };
			setDraft(value);
			setCursor(nextCursor);
			setSuggestionsOpen(detectTrigger(value, nextCursor, validSessionRefs) !== null);
			if (historyIndex >= 0) {
				const history = getPromptHistory();
				if (value !== history[historyIndex]) {
					setHistoryIndex(-1);
					setSavedDraft("");
				}
			}
		},
		[getPromptHistory, historyIndex, sessionId, setDraft, validSessionRefs],
	);

	// 输入预测的当前快照（声明在 onKeyDown 之前，但在下方预测 hook 之后赋值）：
	// keydown 只读 ref，避免把「钩子返回值」塞进 useCallback 依赖造成每次渲染重建回调。
	const suggestionRef = useRef<{ visible: boolean; accept: () => void; dismiss: () => void; acceptKey: (event: React.KeyboardEvent<HTMLDivElement>) => boolean } | null>(null);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			// IME 合成中一律不抢键：↑/↓ 是输入法选词、Esc 是取消合成、Enter 是确认候选。
			// 放在候选菜单之前，保证菜单分支也走同一判定（TipTap 的 DOM 事件桥接没有
			// nativeEvent，必须用共享判定口，不能只看 event.nativeEvent?.isComposing）。
			if (isComposingKeyboardEvent(event)) return;

			// 输入预测（ghost 文案）：Tab / → 采纳，Esc 忽略。只在空草稿可见，因此不会
			// 与历史回溯、补全菜单、发送键冲突；先于其它分支拦截，避免 Tab 被默认焦点切换吃掉。
			const ghost = suggestionRef.current;
			if (ghost?.visible) {
				if (ghost.acceptKey(event)) {
					event.preventDefault();
					ghost.accept();
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					ghost.dismiss();
					return;
				}
			}

			if (suggestionsOpen && suggestionItems.length > 0) {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					setSelectedSuggestionIndex((index) => Math.min(index + 1, suggestionItems.length - 1));
					return;
				}
				if (event.key === "ArrowUp") {
					event.preventDefault();
					setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
					return;
				}
				// Tab 与 Enter 同义：采纳菜单高亮项（补全习惯对齐 zcode/codex 等终端交互）。
				// 修饰键组合不拦：Shift+Tab 等仍走默认焦点切换。
				if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
					// IME 合成中的回车属于输入法确认候选，不能拿去选建议项
					if (isComposingKeyboardEvent(event)) return;
					event.preventDefault();
					const selected = suggestionItems[Math.min(selectedSuggestionIndex, suggestionItems.length - 1)];
					if (selected) selectSuggestion(selected);
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					closeSuggestions();
					return;
				}
			}

			const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
			// 一次取选区：from 即光标偏移（折叠时 from === to），同时回答「是否选中了文本」。
			const liveSelection = editorRef.current ? getComposerSelectionRange(editorRef.current) : { from: cursor, to: cursor };
			// 块边界取自 ProseMirror state（权威）：不用草稿字符串判「是不是首/末块」，
			// 因为草稿 atom 在 IME 合成结束后的一帧内可能还没同步上。
			const blockEdge = getComposerCaretBlockEdge(editorRef.current);
			const history = getPromptHistory();
			// 只在方向键上量视觉行盒：endOfTextblock 要遍历段落内的行盒，
			// 不能让普通输入（每次 keydown 都会走这里）也付这个成本。
			// 两个方向必须都量：PM 的 endOfTextblock 按 (state, dir) 缓存上一次结果，
			// 若只量当前方向，窗口缩放/重新换行后同一 state 可能拿到过期的布局结论。
			const measureEdge = event.key === "ArrowUp" || event.key === "ArrowDown";
			const atVisualTop = measureEdge && isComposerAtVisualEdge(editorRef.current, "up");
			const atVisualBottom = measureEdge && isComposerAtVisualEdge(editorRef.current, "down");
			// 接管判定（含修饰键/选区守卫）全在纯函数里，便于单测。
			const navIntent = resolveComposerHistoryIntent({
				key: event.key,
				atFirstBlock: blockEdge.atFirstBlock,
				atLastBlock: blockEdge.atLastBlock,
				atVisualTop,
				atVisualBottom,
				historyIndex,
				historyLength: history.length,
				modifier: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
				hasSelection: liveSelection.from !== liveSelection.to,
			});

			if (navIntent === "recall-older") {
				event.preventDefault();
				const nextIndex = historyIndex < 0 ? 0 : Math.min(historyIndex + 1, history.length - 1);
				if (historyIndex < 0) setSavedDraft(liveDraft);
				setHistoryIndex(nextIndex);
				liveDomDraftRef.current = { sessionId, value: history[nextIndex] };
				setDraft(history[nextIndex]);
				caretRef.current = { pos: history[nextIndex].length, forValue: history[nextIndex] };
				return;
			}
			if (navIntent === "recall-newer") {
				event.preventDefault();
				const nextIndex = historyIndex - 1;
				const nextDraft = nextIndex >= 0 ? history[nextIndex] : savedDraft;
				setHistoryIndex(nextIndex);
				if (nextIndex < 0) setSavedDraft("");
				liveDomDraftRef.current = { sessionId, value: nextDraft };
				setDraft(nextDraft);
				caretRef.current = { pos: nextDraft.length, forValue: nextDraft };
				return;
			}
			if (navIntent === "restore-draft") {
				liveDomDraftRef.current = { sessionId, value: savedDraft };
				setDraft(savedDraft);
				setHistoryIndex(-1);
				setSavedDraft("");
				return;
			}

			const intent = mode === "plan" && isPlanModeSendKey(event) ? "send" : getComposerEnterIntent(event, sendShortcut);
			if (intent === "send") {
				event.preventDefault();
				// Enter 发送也晋升预览 Tab（promoteAndSend 内部统一处理）。
				// 忙碌时按「忙碌时投递行为」设置决定语义；ACP 后端恒收敛 followUp（协议无 steer）。
				// 空闲直发（undefined）。设置在常用设置→会话，改后即时生效（App 同步 atom）。
				void promoteAndSend(resolveBusySendDelivery(isBusy, store.get(busySendDeliveryAtom), isAcpBackend ? "acp" : undefined));
			}
		},
		[closeSuggestions, cursor, draft, getPromptHistory, historyIndex, isBusy, mode, promoteAndSend, savedDraft, selectedSuggestionIndex, selectSuggestion, sendShortcut, sessionId, setDraft, store, suggestionItems, suggestionsOpen],
	);

	return { promoteAndSend, selectSuggestion, closeSuggestions, onChange, suggestionRef, onKeyDown };
}
