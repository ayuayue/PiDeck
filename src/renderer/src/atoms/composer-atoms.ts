import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import { registerSessionFamilyForDisposal } from "./session-family-registry";
import type { ComposerAgentMode, ImageContent } from "../../../shared/types";
import type { EnhanceModelSelection } from "../../../shared/enhanceModelPreference";
import type { ModelPending } from "../utils/modelPendingDisplay";
import type { QuoteSnippet } from "../components/session/composer/quoteChip";
import { currentSessionIdAtom } from "./session-atoms";

/**
 * 提示词增强的固定模型（settings.enhanceModel 镜像）：null = 跟随会话模型。
 * App 首拉 settings 时水合；设置页保存后写穿，composer 点击增强时读取。
 */
export const enhanceModelAtom = atom<EnhanceModelSelection | null>(null);

/** 显式选择后才发送会话正文，旧设置与引导页均默认为关闭。 */
export const enhanceIncludeContextAtom = atom(false);

/**
 * 输入预测开关镜像（settings.promptSuggestionEnabled）：默认开启，显式关掉才停发请求。
 * App 首拉 settings 时水合；设置页保存后写穿（composer 读 atom 决定是否发起预测）。
 */
export const promptSuggestionEnabledAtom = atom(true);

/**
 * 输入预测的固定模型（settings.promptSuggestionModel 镜像）：null = 跟随会话模型。
 * 与 enhanceModelAtom 互不影响——预测是后台调用，用户常想用便宜小模型，而增强要长表单改写能力。
 */
export const promptSuggestionModelAtom = atom<EnhanceModelSelection | null>(null);

/**
 * 粘贴大文本 → 落盘文件 chip 的元数据（内容只在主进程受管目录，此处仅存指针）。
 * 新写入一律 inProject=false（userData/paste-files）：发送时折叠为原样文本内联；
 * 遗留项目内 chip（inProject=true）仍走 @"path" 引用。
 */
export type PastedTextFile = {
	id: string;
	path: string;
	fileName: string;
	bytes: number;
	inProject: boolean;
};

export type SessionComposerMode = ComposerAgentMode;
export type { ModelPending };

/** 会话内「引用追问」快照仓：id → 划选文本快照（chip 是指针，全文在这里）。 */
export type SessionQuoteMap = Record<string, QuoteSnippet>;

export type SessionSendState = {
	status: "idle" | "activating" | "sending" | "error" | "unknown";
	requestId?: string;
	error?: string;
	/** Snapshot kept visible when the transport result cannot prove delivery. */
	unknownSnapshot?: {
		message: string;
		images?: ImageContent[];
	};
};

export const sessionDraftByIdAtom = atom<Record<string, string>>({});
export const sessionAttachmentsByIdAtom = atom<Record<string, ImageContent[]>>({});
export const sessionPasteFilesByIdAtom = atom<Record<string, PastedTextFile[]>>({});
export const sessionQuotesByIdAtom = atom<Record<string, SessionQuoteMap>>({});

export const sessionComposerModeByIdAtom = atom<Record<string, SessionComposerMode>>({});
export const sessionSendStateByIdAtom = atom<Record<string, SessionSendState>>({});
/** 「停止响应」后排队消息抑制自动投递的会话集合（useQueuedPrompt 的 UI 投影：
 *  逻辑真值在该 hook 的 ref 里，这里只供队列面板显示「已暂停自动发送」提示，避免 toast 瞬时易逝后无从得知队列不会自动发）。 */
export const queueDrainSuppressedByIdAtom = atom<Record<string, true>>({});

/**
 * 生成进行中切换模型：pi 不支持运行中 set_model，只写入会话记录；
 * 本轮结束后再套到 Agent。新加、不在启动快照里的模型不走这里，走重启确认。
 */
export const modelPendingByIdAtom = atom<Record<string, ModelPending | undefined>>({});

// —— 按 sessionId 隔离的订阅族（H6）——
// 分屏每栏 Composer 只订本栏会话的切片：写别的会话不再重建本栏的 Map 订阅。
// 默认值必须是模块级稳定常量——字面量 [] 每次重算都是新数组，Object.is 恒
// 不等，隔离失效。与 session-atoms.ts 的 sessionMessageCacheBySessionIdAtomFamily
// 同构（timeline 域 2026-10 同类修复的既有模式）。
const EMPTY_ATTACHMENTS: ImageContent[] = [];
const EMPTY_PASTE_FILES: PastedTextFile[] = [];
export const idleSessionSendState: SessionSendState = { status: "idle" };

export const sessionDraftBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionDraftByIdAtom, (byId) => byId[sessionId] ?? "", Object.is)));
export const sessionAttachmentsBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionAttachmentsByIdAtom, (byId) => byId[sessionId] ?? EMPTY_ATTACHMENTS, Object.is)));
export const sessionPasteFilesBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionPasteFilesByIdAtom, (byId) => byId[sessionId] ?? EMPTY_PASTE_FILES, Object.is)));
export const sessionQuotesBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionQuotesByIdAtom, (byId) => byId[sessionId], Object.is)));
export const sessionComposerModeBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionComposerModeByIdAtom, (byId) => byId[sessionId], Object.is)));
export const sessionSendStateBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionSendStateByIdAtom, (byId) => byId[sessionId] ?? idleSessionSendState, Object.is)));

export const currentSessionDraftAtom = atom(
	(get) => {
		const sessionId = get(currentSessionIdAtom);
		return sessionId ? (get(sessionDraftByIdAtom)[sessionId] ?? "") : "";
	},
	(get, set, value: string | ((current: string) => string)) => {
		const sessionId = get(currentSessionIdAtom);
		if (!sessionId) return;
		set(setSessionDraftAtom, { sessionId, value });
	},
);

export const currentSessionAttachmentsAtom = atom(
	(get) => {
		const sessionId = get(currentSessionIdAtom);
		return sessionId ? (get(sessionAttachmentsByIdAtom)[sessionId] ?? []) : [];
	},
	(get, set, value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => {
		const sessionId = get(currentSessionIdAtom);
		if (!sessionId) return;
		set(setSessionAttachmentsAtom, { sessionId, value });
	},
);

export const currentSessionComposerModeAtom = atom(
	(get) => {
		const sessionId = get(currentSessionIdAtom);
		return sessionId ? (get(sessionComposerModeByIdAtom)[sessionId] ?? "normal") : "normal";
	},
	(get, set, mode: SessionComposerMode) => {
		const sessionId = get(currentSessionIdAtom);
		if (!sessionId) return;
		set(setSessionComposerModeAtom, { sessionId, mode });
	},
);

export const currentSessionSendStateAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? (get(sessionSendStateByIdAtom)[sessionId] ?? { status: "idle" as const }) : { status: "idle" as const };
});

export const setSessionDraftAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			value: string | ((current: string) => string);
		},
	) => {
		const drafts = get(sessionDraftByIdAtom);
		const current = drafts[input.sessionId] ?? "";
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		const next = { ...drafts };
		if (nextValue) next[input.sessionId] = nextValue;
		else delete next[input.sessionId];
		set(sessionDraftByIdAtom, next);
	},
);

export const setSessionAttachmentsAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]);
		},
	) => {
		const attachments = get(sessionAttachmentsByIdAtom);
		const current = attachments[input.sessionId] ?? [];
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		const next = { ...attachments };
		if (nextValue.length) next[input.sessionId] = nextValue;
		else delete next[input.sessionId];
		set(sessionAttachmentsByIdAtom, next);
	},
);

/** 会话内粘贴文件 chip 的写入/清理（与附件同生命周期：运行时态，不落盘）。 */
export const setSessionPasteFilesAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			value: PastedTextFile[] | ((current: PastedTextFile[]) => PastedTextFile[]);
		},
	) => {
		const files = get(sessionPasteFilesByIdAtom);
		const current = files[input.sessionId] ?? [];
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		const next = { ...files };
		if (nextValue.length) next[input.sessionId] = nextValue;
		else delete next[input.sessionId];
		set(sessionPasteFilesByIdAtom, next);
	},
);

/** 写入/清理会话引用快照仓；与草稿同生命周期（运行时态，不落盘）。 */
export const setSessionQuotesAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			value: SessionQuoteMap | ((current: SessionQuoteMap) => SessionQuoteMap);
		},
	) => {
		const quotes = get(sessionQuotesByIdAtom);
		const current = quotes[input.sessionId] ?? {};
		const nextValue = typeof input.value === "function" ? input.value(current) : input.value;
		const next = { ...quotes };
		if (Object.keys(nextValue).length > 0) next[input.sessionId] = nextValue;
		else delete next[input.sessionId];
		set(sessionQuotesByIdAtom, next);
	},
);

export const setSessionComposerModeAtom = atom(null, (get, set, input: { sessionId: string; mode: SessionComposerMode }) => {
	const modes = { ...get(sessionComposerModeByIdAtom) };
	// 显式记下 normal：DSH 进行中的 goal 不能把「用户刚切回普通」再推导回目标模式。
	modes[input.sessionId] = input.mode;
	set(sessionComposerModeByIdAtom, modes);
});

export const setSessionSendStateAtom = atom(null, (get, set, input: { sessionId: string; state: SessionSendState }) => {
	const states = { ...get(sessionSendStateByIdAtom) };
	if (input.state.status === "idle") delete states[input.sessionId];
	else states[input.sessionId] = input.state;
	set(sessionSendStateByIdAtom, states);
});

export const clearSessionComposerSnapshotAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			draft: string;
			attachments: ImageContent[];
		},
	) => {
		const currentDraft = get(sessionDraftByIdAtom)[input.sessionId] ?? "";
		if (currentDraft === input.draft) {
			set(setSessionDraftAtom, { sessionId: input.sessionId, value: "" });
		}
		const currentAttachments = get(sessionAttachmentsByIdAtom)[input.sessionId] ?? [];
		if (currentAttachments.length === input.attachments.length && currentAttachments.every((attachment, index) => attachment === input.attachments[index])) {
			set(setSessionAttachmentsAtom, { sessionId: input.sessionId, value: [] });
		}
	},
);

/**
 * 把 renderer-only 虚拟会话（引导页空白输入框）的 composer 状态整体搬到真实
 * 会话：首次发送时才创建 Catalog 会话，发送后需在同一输入框继续——把草稿/附件/
 * 模式/发送态一起移动可避免切换 sessionId 导致重挂载丢内容。
 */
export const promoteSessionComposerStateAtom = atom(null, (get, set, input: { fromSessionId: string; toSessionId: string }) => {
	if (input.fromSessionId === input.toSessionId) return;
	const move = <T>(source: Record<string, T>) => {
		if (!(input.fromSessionId in source)) return source;
		const next = { ...source, [input.toSessionId]: source[input.fromSessionId] };
		delete next[input.fromSessionId];
		return next;
	};
	set(sessionDraftByIdAtom, move(get(sessionDraftByIdAtom)));
	set(sessionAttachmentsByIdAtom, move(get(sessionAttachmentsByIdAtom)));
	// 草稿中的引用 token 只是指针；首次提升与失败回退都必须携带全文快照。
	set(sessionQuotesByIdAtom, move(get(sessionQuotesByIdAtom)));
	set(sessionPasteFilesByIdAtom, move(get(sessionPasteFilesByIdAtom)));
	set(sessionComposerModeByIdAtom, move(get(sessionComposerModeByIdAtom)));
	set(sessionSendStateByIdAtom, move(get(sessionSendStateByIdAtom)));
});

export const removeSessionComposerStateAtom = atom(null, (get, set, sessionId: string) => {
	const drafts = { ...get(sessionDraftByIdAtom) };
	delete drafts[sessionId];
	set(sessionDraftByIdAtom, drafts);
	const attachments = { ...get(sessionAttachmentsByIdAtom) };
	delete attachments[sessionId];
	set(sessionAttachmentsByIdAtom, attachments);
	const pasteFiles = { ...get(sessionPasteFilesByIdAtom) };
	delete pasteFiles[sessionId];
	set(sessionPasteFilesByIdAtom, pasteFiles);
	const modes = { ...get(sessionComposerModeByIdAtom) };
	delete modes[sessionId];
	set(sessionComposerModeByIdAtom, modes);
	const sendStates = { ...get(sessionSendStateByIdAtom) };
	delete sendStates[sessionId];
	set(sessionSendStateByIdAtom, sendStates);
	const quotes = { ...get(sessionQuotesByIdAtom) };
	delete quotes[sessionId];
	// 引用快照可能含大段全文（引用仓拷贝），漏清会让旧会话的全文永久驻留内存
	set(sessionQuotesByIdAtom, quotes);
	const modelPending = { ...get(modelPendingByIdAtom) };
	delete modelPending[sessionId];
	set(modelPendingByIdAtom, modelPending);
});

/**
 * 语音配置版本号：设置页保存/安装/删除模型后自增，供 useVoiceTranscription 的
 * 配置探测 effect 依赖。语音配置由主进程独立 store 持有（不在 AppSettings 里），
 * 渲染层没有现成的「设置已变」信号；用这个轻量计数器把弹框里的改动即时推给
 * 已挂载的输入框，避免「开了开关但要切会话/重启才出现按钮」。
 */
export const voiceConfigRevisionAtom = atom(0);
