import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, ImageContent, SessionRecord } from "../../../../../shared/types";
import { findImageGenProvider } from "../../../../../shared/imageGenConfig";
import { findVideoGenProvider } from "../../../../../shared/videoGenConfig";
import type { ImageGenMeta } from "../../../../../shared/types/imagegen";
import type { VideoGenMeta } from "../../../../../shared/types/videogen";
import { cacheSessionMessagesAtom, imageGenConfigAtom, sessionMessagesCacheAtom, setSessionAttachmentsAtom, videoGenConfigAtom } from "../../../atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";

/** 生图错误码 → 用户可见文案。http/鉴权类错误尽量附上厂商 detail（已脱敏）。 */
function mapImageGenError(error: string, detail?: string): string {
	const extra = detail?.trim() ?? "";
	switch (error) {
		case "notConfigured":
			return t("imagegen.error.notConfigured");
		case "invalidKey":
			return extra ? t("imagegen.error.invalidKeyDetail", { detail: extra }) : t("imagegen.error.invalidKey");
		case "badBaseUrl":
			return extra ? t("imagegen.error.badBaseUrlDetail", { detail: extra }) : t("imagegen.error.badBaseUrl");
		case "empty":
			return t("imagegen.error.empty");
		case "http":
			return extra ? t("imagegen.error.http", { detail: extra }) : t("imagegen.status.error");
		case "responseTooLarge":
			return t("imagegen.error.responseTooLarge");
		default:
			return t("imagegen.error.network");
	}
}

/** 生视频错误码 → 用户可见文案（与 mapImageGenError 同构，多出轮询/下载/取消三段）。 */
function mapVideoGenError(error: string, detail?: string): string {
	const extra = detail?.trim() ?? "";
	switch (error) {
		case "notConfigured":
			return t("videogen.error.notConfigured");
		case "invalidKey":
			return extra ? t("videogen.error.invalidKeyDetail", { detail: extra }) : t("videogen.error.invalidKey");
		case "badBaseUrl":
			return extra ? t("videogen.error.badBaseUrlDetail", { detail: extra }) : t("videogen.error.badBaseUrl");
		case "empty":
			return t("videogen.error.empty");
		case "timeout":
			return t("videogen.error.timeout");
		case "downloadFailed":
			return t("videogen.error.downloadFailed");
		case "generationFailed":
			return extra ? t("videogen.error.generationFailedDetail", { detail: extra }) : t("videogen.error.generationFailed");
		case "cancelled":
			return t("videogen.error.cancelled");
		case "http":
			return extra ? t("videogen.error.http", { detail: extra }) : t("videogen.status.error");
		default:
			return t("videogen.error.network");
	}
}

/**
 * 生图 / 生视频提交域：占位消息上屏、门禁提示、结果原地回填与附件恢复。
 *
 * 从 `useSessionComposerController` 拆出，因为它是两个独立后端的完整发送链路，
 * 与草稿/补全/队列无关；注入面只有草稿与附件（其余 atom 本域自读，避免主 hook 转手）。
 */
export interface ComposerGenerationOptions {
	sessionId: string;
	draft: string;
	attachments: ImageContent[];
	record: SessionRecord | undefined;
	imageGenSize: string;
	imageGenWatermark: boolean;
	imageGenOutputFormat: string;
	setDraft: (value: string) => void;
	setAttachments: (value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => void;
}

export function useComposerGeneration(options: ComposerGenerationOptions) {
	const { sessionId, draft, attachments, record, imageGenSize, imageGenWatermark, imageGenOutputFormat, setDraft, setAttachments } = options;
	const store = useStore();
	const imageGenConfig = useAtomValue(imageGenConfigAtom);
	const setImageGenConfig = useSetAtom(imageGenConfigAtom);
	// 生视频配置独立落盘（videogen.json），与生图同构：composer 只读这份，不碰会话 LLM 模型。
	const videoGenConfig = useAtomValue(videoGenConfigAtom);
	const setAttachmentsAtom = useSetAtom(setSessionAttachmentsAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
	// 生图进行中：置 true 时发送按钮禁用（避免并发多次生图），完成后图片进附件栏
	const [generatingImage, setGeneratingImage] = useState(false);
	// 生视频「提交中」门禁：submit 受理即复位（异步任务终态由 videogen:event 事件驱动，不占用发送按钮）。
	const [submittingVideo, setSubmittingVideo] = useState(false);
	// 成本确认闸（默认开）：首次提交只完起待确认态，ComposerArea 渲染确认弹层，确认后才真正发请求。
	// 放在 controller 而不是按钮里：Enter/发送按钮/追问入口全部经 submitVideo，只有这里能统一拦住。
	const [videoConfirmPending, setVideoConfirmPending] = useState(false);
	const activeImageGenProviderId = imageGenConfig.activeProviderId;
	const activeImageGenModelId = imageGenConfig.activeModel;

	// 单栏会话复用同一 Composer 实例：切会话必须清生成态门禁，否则新会话的发送按钮
	// 会继承上一会话的「生图中」禁用态。
	useEffect(() => {
		setGeneratingImage(false);
	}, [sessionId]);

	// 结果按「消息」语义上屏（与 useSessionSend 乐观提交同一约定：写时间线缓存、source=runtime）：
	// 提示词作为 user 消息立即上屏；随后追加一条 assistant「生图占位」消息（meta.imageGen=generating），
	// 生成期间由 FinalAnswer 渲染 beUI ImageGeneration 点阵动画，完成后原地更新为 complete（图片清晰过渡），
	// 失败原地更新为 error。不调用 send、不进附件栏（无运行中 Agent 也能用）。
	const persistImageGenSelection = useCallback(
		(providerId: string, modelId: string) => {
			const next = {
				...imageGenConfig,
				activeProviderId: providerId,
				activeModel: modelId,
			};
			setImageGenConfig(next);
			void desktopApi.imagegen.saveConfig(next).catch(() => undefined);
		},
		[imageGenConfig, setImageGenConfig],
	);

	const generateImage = useCallback(async () => {
		const prompt = draft.trim();
		if (!prompt || generatingImage) return;
		const provider = findImageGenProvider(imageGenConfig, activeImageGenProviderId);
		const modelId = provider?.models.includes(activeImageGenModelId) ? activeImageGenModelId : "";
		if (!provider?.id || !modelId || !provider.baseUrl.trim() || !provider.apiKey.trim()) {
			showNotice(t("imagegen.error.notConfigured"), 5000);
			return;
		}
		// 参考图前置门禁：供应商未声明带图输入时直接提示，不发无效请求（主进程也会拦截兑底）
		if (attachments.length > 0 && (provider.referenceMode ?? "none") === "none") {
			showNotice(t("imagegen.error.referenceUnsupported"), 5000);
			return;
		}
		// 仅「启动即匿名」的会话提示（noSession=true，经匿名开聊创建，pi 以 --no-session 启动）：
		// 生图不落盘、重启即失。普通新建 draft 会话 filePath 同样为空（生图不启动 agent），
		// 但用户视角它是正式会话，不弹匿名提示打扰（2026 反馈）。
		if (record?.noSession === true) {
			showNotice(t("imagegen.transientHint"), 6000);
		}
		setGeneratingImage(true);

		// 把本地生图消息追加进时间线缓存（整体替换 messages 数组，source=runtime 沿用乐观提交约定）。
		const appendTimelineMessage = (message: ChatMessage) => {
			const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
			setCacheMessages({ sessionId, messages: [...previous, message], source: "runtime" });
		};
		// 按 id 原地更新已上屏消息（生图占位 → complete/error 复用同一条，避免时间线多出一条）。
		const updateTimelineMessage = (id: string, patch: (m: ChatMessage) => ChatMessage) => {
			const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
			setCacheMessages({
				sessionId,
				messages: previous.map((m) => (m.id === id ? patch(m) : m)),
				source: "runtime",
			});
		};

		appendTimelineMessage({
			id: crypto.randomUUID(),
			agentId: "",
			role: "user",
			text: prompt,
			timestamp: Date.now(),
			// 参考图随 user 消息上屏：发送后附件栏清空，图片要留在时间线气泡里回显
			images: attachments.length > 0 ? attachments : undefined,
		});
		const imageMessageId = crypto.randomUUID();
		appendTimelineMessage({
			id: imageMessageId,
			agentId: "",
			role: "assistant",
			text: "",
			stopReason: "stop",
			timestamp: Date.now(),
			meta: {
				imageGen: { status: "generating", prompt, size: imageGenSize } satisfies ImageGenMeta,
			},
		});
		setDraft("");
		// 乐观清空附件栏：参考图已随 user 消息上屏回显，输入框不再占用
		// （与普通消息发送同惯例 useSessionSend.clearSnapshot）；
		// 生成失败时下方失败分支会把附件前插恢复，支持改词重试。
		if (attachments.length > 0) {
			setAttachmentsAtom({ sessionId, value: [] });
		}

		try {
			const result = await desktopApi.imagegen.generate({
				provider: provider.id,
				model: modelId,
				prompt,
				size: imageGenSize,
				watermark: imageGenWatermark,
				outputFormat: imageGenOutputFormat,
				// 参考图：附件栏图片作为参考图传给主进程；是否可用由供应商 referenceMode 决定
				referenceImages: attachments.length > 0 ? attachments : undefined,
				// 生图记录落盘：主进程成功后把 user+assistant 消息写入当前会话的 pi 文件
				sessionId,
			});
			if (result.ok) {
				// 参考图发送时已乐观清空，此处只原地更新结果消息
				updateTimelineMessage(imageMessageId, (m) => ({
					...m,
					images: [result.image],
					meta: {
						imageGen: { status: "complete", prompt, size: imageGenSize } satisfies ImageGenMeta,
					},
				}));
				showNotice(t("imagegen.done"), 4000);
			} else {
				// 失败恢复附件：参考图放回输入框便于改词重试；前插不覆盖期间新粘贴的图
				if (attachments.length > 0) {
					setAttachmentsAtom({ sessionId, value: (current) => [...attachments, ...current] });
				}
				updateTimelineMessage(imageMessageId, (m) => ({
					...m,
					meta: {
						imageGen: {
							status: "error",
							prompt,
							size: imageGenSize,
							errorDetail: mapImageGenError(result.error, result.detail),
						} satisfies ImageGenMeta,
					},
				}));
			}
		} catch {
			// 网络/超时类失败同样恢复附件，便于原地重试
			if (attachments.length > 0) {
				setAttachmentsAtom({ sessionId, value: (current) => [...attachments, ...current] });
			}
			updateTimelineMessage(imageMessageId, (m) => ({
				...m,
				meta: {
					imageGen: {
						status: "error",
						prompt,
						errorDetail: t("imagegen.error.network"),
					} satisfies ImageGenMeta,
				},
			}));
		} finally {
			setGeneratingImage(false);
		}
	}, [activeImageGenModelId, activeImageGenProviderId, attachments, draft, generatingImage, imageGenConfig, imageGenOutputFormat, imageGenSize, imageGenWatermark, record?.noSession, sessionId, setAttachmentsAtom, setCacheMessages, setDraft, store]);

	// 生视频提交：与生图的同步等待不同，submit 受理即返回，占位消息由 videogen:event
	// 事件原地推进（useVideoGenEvents 按 messageId 命中）；本地只负责门禁、上屏与受理回填。
	const submitVideo = useCallback(
		async (confirmed = false) => {
			const prompt = draft.trim();
			if (!prompt || submittingVideo) return;
			const provider = findVideoGenProvider(videoGenConfig, videoGenConfig.activeProviderId);
			const modelId = provider?.models.includes(videoGenConfig.activeModel) ? videoGenConfig.activeModel : "";
			if (!provider?.id || !modelId || !provider.baseUrl.trim() || !provider.apiKey.trim()) {
				showNotice(t("videogen.error.notConfigured"), 5000);
				return;
			}
			// 一期纯文生视频：附件不支持作为参考素材，显式拦下而不是静默丢弃用户已贴的内容。
			if (attachments.length > 0) {
				showNotice(t("videogen.error.attachmentsUnsupported"), 5000);
				return;
			}
			// 成本确认闸：未确认且开关开启时只完起弹层，不发请求；确认后走同一条函数提交。
			if (videoGenConfig.costConfirm && !confirmed) {
				setVideoConfirmPending(true);
				return;
			}
			setVideoConfirmPending(false);
			if (record?.noSession === true) {
				showNotice(t("videogen.transientHint"), 6000);
			}
			setSubmittingVideo(true);
			const appendTimelineMessage = (message: ChatMessage) => {
				const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
				setCacheMessages({ sessionId, messages: [...previous, message], source: "runtime" });
			};
			const updateTimelineMessage = (id: string, patch: (m: ChatMessage) => ChatMessage) => {
				const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
				setCacheMessages({ sessionId, messages: previous.map((m) => (m.id === id ? patch(m) : m)), source: "runtime" });
			};
			const params = videoGenConfig.activeParams;
			// 参数回退链：用户改过的 activeParams → 供应商 defaults（切供应商时底栏预填）
			const resolution = params.resolution ?? provider.defaults?.resolution;
			const duration = params.duration ?? provider.defaults?.duration;
			const ratio = params.ratio ?? provider.defaults?.ratio;
			appendTimelineMessage({
				id: crypto.randomUUID(),
				agentId: "",
				role: "user",
				text: prompt,
				timestamp: Date.now(),
			});
			// 占位 messageId 由本地生成并随请求带给主进程：事件快照沿用同一 id 才能原地命中本条。
			const videoMessageId = crypto.randomUUID();
			const placeholderMeta: VideoGenMeta = { status: "queued", prompt, resolution, duration, ratio };
			appendTimelineMessage({
				id: videoMessageId,
				agentId: "",
				role: "assistant",
				text: "",
				stopReason: "stop",
				timestamp: Date.now(),
				meta: { videoGen: placeholderMeta },
			});
			setDraft("");
			try {
				const result = await desktopApi.videogen.submit({
					provider: provider.id,
					model: modelId,
					prompt,
					sessionId,
					messageId: videoMessageId,
					resolution,
					duration,
					ratio,
				});
				if (result.ok) {
					// 受理回填 jobId：事件到达前取消入口/按钮态即可用；后续状态由事件原地推进。
					updateTimelineMessage(videoMessageId, (m) => ({
						...m,
						meta: { ...m.meta, videoGen: { ...placeholderMeta, jobId: result.jobId } },
					}));
					showNotice(t("videogen.submitted"), 4000);
				} else {
					updateTimelineMessage(videoMessageId, (m) => ({
						...m,
						meta: { ...m.meta, videoGen: { ...placeholderMeta, status: "error", errorDetail: mapVideoGenError(result.error, result.detail) } },
					}));
				}
			} catch {
				updateTimelineMessage(videoMessageId, (m) => ({
					...m,
					meta: { ...m.meta, videoGen: { ...placeholderMeta, status: "error", errorDetail: t("videogen.error.network") } },
				}));
			} finally {
				setSubmittingVideo(false);
			}
		},
		[attachments.length, draft, record?.noSession, sessionId, setCacheMessages, setDraft, store, submittingVideo, videoGenConfig],
	);
	// 确认/取消成本弹层：确认后携 confirmed 直发（绕过闸门）；取消只清待确认态，草稿不动。
	const confirmVideoGen = useCallback(() => {
		void submitVideo(true);
	}, [submitVideo]);
	const cancelVideoGen = useCallback(() => setVideoConfirmPending(false), []);

	return { persistImageGenSelection, generateImage, submitVideo, confirmVideoGen, cancelVideoGen, generatingImage, submittingVideo, videoConfirmPending };
}
