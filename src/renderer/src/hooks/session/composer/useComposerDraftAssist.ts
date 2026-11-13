import { useAtomValue, useStore } from "jotai";
import { useCallback } from "react";
import type { ImageContent, ResolvedLaunchDefaults, SessionRecord } from "../../../../../shared/types";
import { formatBytes } from "../../../../../shared/formatBytes";
import { resolveEnhanceTargetModel } from "../../../../../shared/enhanceModelPreference";
import { enhanceIncludeContextAtom, enhanceModelAtom, promptSuggestionEnabledAtom, promptSuggestionModelAtom, sessionAttachmentsBySessionIdAtomFamily, sessionDraftByIdAtom, sessionMessageCacheBySessionIdAtomFamily } from "../../../atoms";
import type { ComposerCaretRequest } from "../../../components/session/composer/types";
import { getComposerCaretOffset, getComposerSelectionRange } from "../../../components/session/composer/caretCoords";
import { formatFilePathRef } from "../../../components/session/composer/chips";
import { t } from "../../../i18n";
import { COMPOSER_ATTACHMENT_BUDGET_BYTES, ComposerImageError, attachmentBytes, base64DataBytes, processComposerImageFile } from "../../../utils/composerImages";
import { readWelcomeDshModelPreference, readWelcomeModelPreference } from "../../../utils/chatSessionBootstrap";
import { collectPromptEnhanceContext } from "../../../utils/promptEnhanceContext";
import { showNotice } from "../../../utils/notice";
import { resolveVoiceTranscriptionInsertion, type VoiceTranscriptionTarget } from "../../../utils/voiceTranscriptionInsert";
import { usePromptEnhance, type PromptEnhanceRequest } from "../../usePromptEnhance";
import { usePromptSuggestion } from "../../usePromptSuggestion";
import { useVoiceTranscription } from "../../useVoiceTranscription";

type ComposerLiveDraftRef = { current: { sessionId: string; value: string } };
type ComposerSuggestionSnapshot = { visible: boolean; accept: () => void; dismiss: () => void; acceptKey: (event: React.KeyboardEvent<HTMLDivElement>) => boolean };

function composerImageNotice(error: unknown): string {
	if (error instanceof ComposerImageError) {
		if (error.code === "too-large") return t("app.imageTooLarge");
		if (error.code === "unsupported") return t("app.imageUnsupported");
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * 草稿写入与辅助生成域：光标处插入（@引用 / 纯文本）、图片附件入栏、语音转写、
 * 提示词增强（✦）、输入预测（ghost）。
 *
 * 四者共用同一份「草稿 + 光标 + 选区」同步协议（liveDomDraftRef / caretRef），
 * 分开放会让每个入口各写一遍 `liveDomDraftRef.current = { sessionId, value }`。
 */
export interface ComposerDraftAssistOptions {
	sessionId: string;
	draft: string;
	setDraft: (value: string) => void;
	cursor: number;
	setCursor: (value: number) => void;
	editorRef: { current: HTMLDivElement | null };
	liveDomDraftRef: ComposerLiveDraftRef;
	caretRef: { current: ComposerCaretRequest | null };
	suggestionRef: { current: ComposerSuggestionSnapshot | null };
	setAttachments: (value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => void;
	record: SessionRecord | undefined;
	isDshBackend: boolean;
	dshDefault: { provider: string; model: string; reasoningEffort?: string; defaultEffort?: string } | undefined;
	bootstrapDefaults: ResolvedLaunchDefaults | undefined;
	sessionTurnRunning: boolean;
	hasContent: boolean;
}

export function useComposerDraftAssist(options: ComposerDraftAssistOptions) {
	const { sessionId, draft, setDraft, cursor, setCursor, editorRef, liveDomDraftRef, caretRef, suggestionRef, setAttachments, record, isDshBackend, dshDefault, bootstrapDefaults, sessionTurnRunning, hasContent } = options;
	const store = useStore();
	const enhanceModelConfig = useAtomValue(enhanceModelAtom);
	const enhanceIncludeContext = useAtomValue(enhanceIncludeContextAtom);

	const addImageFiles = useCallback(
		async (imageFiles: File[]) => {
			// G2：DSH 图片附件已支持（经 host attachment 服务上传，sendPrompt 带 image 块），
			// 与 pi 共用附件流程，不再按 backend 拦截。
			for (const file of imageFiles) {
				try {
					const image = await processComposerImageFile(file);
					// 附件预算（内存优化 2026-12）：单会话 base64 总量封顶，拒绝发生在入口并提示，
					// 不静默截断；重发恢复/队列回填不经此处，不受影响。逐张判定：小图仍可补进。
					const currentBytes = attachmentBytes(store.get(sessionAttachmentsBySessionIdAtomFamily(sessionId)));
					if (currentBytes + base64DataBytes(image.data) > COMPOSER_ATTACHMENT_BUDGET_BYTES) {
						showNotice(t("app.imageBudgetExceeded", { size: formatBytes(COMPOSER_ATTACHMENT_BUDGET_BYTES) }), 3000);
						continue;
					}
					setAttachments((current) => [...current, image]);
				} catch (error) {
					showNotice(composerImageNotice(error), 3000);
				}
			}
		},
		[sessionId, setAttachments, store],
	);

	/**
	 * 把已格式化的引用文本（@path、@"a b/" 等）插入输入框当前光标处。
	 * 文件树拖拽、OS 文件拖入/粘贴、「加入对话引用」按钮共用同一插入规则：
	 * 只引用路径，不上传内容；与前字符之间按需补空格。
	 */
	const insertRefTexts = useCallback(
		(refTexts: string[]) => {
			if (refTexts.length === 0) return;
			const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
			const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
			const refText = refTexts.join(" ");
			const previous = liveDraft[liveCursor - 1];
			const spacer = liveCursor > 0 && previous !== " " && previous !== "\n" ? " " : "";
			const next = liveDraft.slice(0, liveCursor) + spacer + refText + liveDraft.slice(liveCursor);
			const nextCursor = liveCursor + spacer.length + refText.length;
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			setCursor(nextCursor);
			caretRef.current = { pos: nextCursor, forValue: next };
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[cursor, draft, sessionId, setDraft],
	);

	/** 本地路径以 @path 引用插入（OS 文件拖入/粘贴/文件选择器共用）；含空格路径自动加引号 */
	const insertFilePathRefs = useCallback(
		(paths: string[]) => {
			insertRefTexts(paths.map((path) => formatFilePathRef(path, { isDirectory: /[\\/]$/.test(path) })));
		},
		[insertRefTexts],
	);

	/**
	 * 把纯文本插入输入框当前光标处（不带 @ 引用包装）。
	 * 与 insertRefTexts 同一套光标/草稿同步协议；仅用于「转文件失败回退原样粘贴」
	 * 这类需要绕过 TipTap 默认粘贴路径的场景（onPaste 已同步 preventDefault）。
	 */
	const insertPlainTextAtCursor = useCallback(
		(text: string) => {
			if (!text) return;
			const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
			const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
			const next = liveDraft.slice(0, liveCursor) + text + liveDraft.slice(liveCursor);
			const nextCursor = liveCursor + text.length;
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			setCursor(nextCursor);
			caretRef.current = { pos: nextCursor, forValue: next };
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[cursor, draft, sessionId, setDraft],
	);

	const captureVoiceTarget = useCallback((): VoiceTranscriptionTarget => {
		const liveDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
		const selection = editorRef.current ? getComposerSelectionRange(editorRef.current) : { from: cursor, to: cursor };
		return { sessionId, draft: liveDraft, ...selection };
	}, [cursor, draft, sessionId]);

	const applyVoiceText = useCallback(
		(target: VoiceTranscriptionTarget, text: string) => {
			const currentDraft = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : (store.get(sessionDraftByIdAtom)[sessionId] ?? "");
			const result = resolveVoiceTranscriptionInsertion({
				target,
				currentSessionId: sessionId,
				currentDraft,
				text,
			});
			if (!result.ok) return false;
			liveDomDraftRef.current = { sessionId, value: result.value };
			setDraft(result.value);
			setCursor(result.caret);
			caretRef.current = { pos: result.caret, forValue: result.value };
			requestAnimationFrame(() => editorRef.current?.focus());
			return true;
		},
		[sessionId, setDraft, store],
	);

	const voice = useVoiceTranscription({
		scopeKey: sessionId,
		captureTarget: captureVoiceTarget,
		applyText: applyVoiceText,
	});

	// ===== 提示词增强（✦ 按钮）：当前模型 + 当前草稿 → 一次性改写 → 回填 =====
	// 目标模型优先级（resolveEnhanceTargetModel）：设置页指定的固定增强模型 >
	// 会话记录 > 引导页点选 > 部署/主进程默认；引导页的 welcomeModel 存 localStorage，
	// 这里不走 catalog 存在性校验——模型被删的边缘情况由主进程报 model-not-found，toast 可见。
	// 增强与输入预测共用同一条优先级链，但各自的「固定模型」是独立设置项（enhanceModel /
	// promptSuggestionModel）——预测每轮都发一次后台调用，常被单独指定成便宜的小模型。
	const targetModelChain = {
		recordModel: record?.model,
		welcomeModel: (isDshBackend ? readWelcomeDshModelPreference() : readWelcomeModelPreference())?.model,
		fallback: isDshBackend && dshDefault ? { provider: dshDefault.provider, modelId: dshDefault.model } : bootstrapDefaults?.model,
	};
	const enhanceTarget = resolveEnhanceTargetModel({ ...targetModelChain, configured: enhanceModelConfig });
	const captureEnhanceRequest = useCallback((): PromptEnhanceRequest | null => {
		if (!enhanceTarget) return null;
		const draftSnapshot = liveDomDraftRef.current.sessionId === sessionId ? liveDomDraftRef.current.value : draft;
		// 按发起会话读取已加载快照，既不跨分屏取 currentSession，也不为增强额外加载历史。
		const context = enhanceIncludeContext ? collectPromptEnhanceContext(store.get(sessionMessageCacheBySessionIdAtomFamily(sessionId))?.messages ?? []) : [];
		return { ...enhanceTarget, draft: draftSnapshot, ...(context.length ? { context } : {}) };
	}, [draft, enhanceTarget, enhanceIncludeContext, sessionId, store]);

	// 回填 = 整体替换草稿（与语音插入不同：增强是对全文的改写，没有「插入位置」语义）。
	const applyEnhancedText = useCallback(
		(text: string) => {
			liveDomDraftRef.current = { sessionId, value: text };
			setDraft(text);
			setCursor(text.length);
			caretRef.current = { pos: text.length, forValue: text };
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[sessionId, setDraft],
	);

	const enhance = usePromptEnhance({
		scopeKey: sessionId,
		modelLabel: enhanceTarget ? `${enhanceTarget.provider}/${enhanceTarget.modelId}` : undefined,
		captureRequest: captureEnhanceRequest,
		applyText: applyEnhancedText,
	});

	// ===== 输入预测（回合结束后预测下一句输入，空输入框 ghost 展示）=====
	// 与增强共用同一条优先级链（设置固定模型 > 会话模型 > 默认），但读的是独立的
	// promptSuggestionModel 设置，并走独立侧车实例；
	// 回合边界取 runtime 的权威 isTurnActive（agent_end），不用 isBusy（还含 compact 等中间态）。
	// 采纳回填与增强同一条路径（applyEnhancedText：整体替换草稿 + 光标置尾 + 聚焦）。
	const promptSuggestionEnabled = useAtomValue(promptSuggestionEnabledAtom);
	const promptSuggestionModelConfig = useAtomValue(promptSuggestionModelAtom);
	const suggestionTarget = resolveEnhanceTargetModel({ ...targetModelChain, configured: promptSuggestionModelConfig });
	const suggestion = usePromptSuggestion({
		scopeKey: sessionId,
		enabled: promptSuggestionEnabled,
		target: suggestionTarget,
		turnRunning: sessionTurnRunning,
		// 用 hasContent 而不是 draft.length：纯空白、附件/粘贴文件也属于「有内容」，
		// 否则预测会盖在已经放好附件的输入框上，Tab 还会把附件留下却把 ghost 当草稿采纳。
		draftEmpty: !hasContent,
		applyText: applyEnhancedText,
	});
	suggestionRef.current = suggestion;

	return { addImageFiles, insertRefTexts, insertFilePathRefs, insertPlainTextAtCursor, voice, enhance, suggestion };
}
