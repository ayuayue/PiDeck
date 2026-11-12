import { app, safeStorage } from "electron";
import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isLocalProject } from "../../../shared/projectLocation";
import { ipcChannels } from "../../../shared/ipc";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ProjectStore } from "../../projects/ProjectStore";
import type { AgentManager } from "../../pi/AgentManager";
import { isDefaultAgentTitle } from "../../pi/agentUtils";
import { createNetDownloader } from "../../dsh/runtime/dshRuntimeIo";
import type { PiLocator } from "../../pi/PiLocator";
import type { SessionCatalog } from "../../sessions/SessionCatalog";
import type { ConfigManager } from "../../config/ConfigManager";
import { registerVisionIpc } from "../../ipc/visionIpc";
import { registerImageGenIpc } from "../../ipc/imagegenIpc";
import { ImageGenService } from "../../imagegen/ImageGenService";
import { ImageSessionStore } from "../../imagegen/ImageSessionStore";
import { ImageBlobStore } from "../../imagegen/ImageBlobStore";
import { registerImageGenImageProtocol } from "../../imagegen/ImageGenImageProtocol";
import { registerLocalImageProtocol } from "../../media/LocalImageProtocol";
import { registerLocalImageIpc } from "../../ipc/localImageIpc";
import { createCanonicalRootsProvider } from "../../media/localImageRoots";
import { ImageGenConfigStore } from "../../imagegen/ImageGenConfigStore";
import { registerVoiceTranscriptionIpc } from "../../ipc/voiceTranscriptionIpc";
import { VoiceTranscriptionConfigStore } from "../../voice/VoiceTranscriptionConfigStore";
import { VoiceTranscriptionService } from "../../voice/VoiceTranscriptionService";
import { createVolcStreamSocket } from "../../voice/volcStreamSocket";
import { WhisperRuntimeManager, fetchWhisperReleaseDigests } from "../../voice/WhisperRuntimeManager";
import { getWhisperModelDef } from "../../../shared/types/whisperRuntime";
import { WhisperTranscriber } from "../../voice/WhisperTranscriber";
import { WhisperServerPool } from "../../voice/WhisperServerPool";
import { VisionBridgeConfigManager } from "../../settings/visionBridgeConfig";
import type { AppLogger } from "../../logging/AppLogger";
import type { QuitCleanupRegistry } from "../../lifecycle/QuitCleanupRegistry";

/**
 * media 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface MediaStackContext {
	readonly getAcpImageBlobStore: () => ImageBlobStore | null;
	readonly setAcpImageBlobStore: (value: ImageBlobStore | null) => void;
	readonly agentManager: AgentManager;
	readonly appLogger: AppLogger;
	readonly configManager: ConfigManager;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly piLocator: PiLocator;
	readonly projectStore: ProjectStore;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly resolveImageGenStorageRoots: () => { sessions: string; blobs: string };
	readonly sessionCatalog: SessionCatalog;
}

export interface MediaStackResult {
	readonly imageSessionStore: ImageSessionStore;
}

export function registerMediaStack(ctx: MediaStackContext): MediaStackResult {
	const { agentManager, appLogger, configManager, mainCopy, piLocator, projectStore, quitCleanup, resolveImageGenStorageRoots, sessionCatalog } = ctx;

	registerVisionIpc({
		visionBridge: new VisionBridgeConfigManager(configManager),
		log: (message, ...args) => appLogger.info("vision", message, ...args),
	});

	const whisperRuntimeRoot = join(app.getPath("userData"), "voice-runtime");
	const whisperRuntimeManager = new WhisperRuntimeManager({
		platform: process.platform,
		arch: process.arch,
		layout: { runtimeRoot: whisperRuntimeRoot, modelsRoot: join(whisperRuntimeRoot, "models"), tempRoot: join(whisperRuntimeRoot, "tmp") },
		download: createNetDownloader((scope, message, detail) => void appLogger.warn(scope, message, detail)),
		fetchReleaseDigests: fetchWhisperReleaseDigests,
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	const whisperServerPool = new WhisperServerPool({
		resolveServerPath: (input) => whisperRuntimeManager.resolveServerPath(input),
		getEnv: () => (piLocator ? piLocator.createProcessEnv() : undefined),
		log: (message, details) => void appLogger.info("voice-whisper-server", message, details),
	});
	// C12：退出清理登记（before-quit 统一 runAll）——常驻推理进程必须随应用回收，
	// 否则残留的 whisper-server 会一直占着几百 MB 模型内存和监听端口。
	quitCleanup.register("whisper-server", async () => {
		whisperServerPool.abortAll();
		await whisperServerPool.shutdown("quit");
	});
	const whisperTranscriber = new WhisperTranscriber({
		manager: whisperRuntimeManager,
		server: whisperServerPool,
		getTempRoot: () => join(whisperRuntimeRoot, "tmp"),
		// piLocator 在启动装配后段才就绪（本注册在其之前），转写发生在运行期，闭包懒取即可。
		getEnv: () => (piLocator ? piLocator.createProcessEnv() : undefined),
		log: (message, details) => void appLogger.info("voice-whisper", message, details),
	});
	const voiceTranscriptionConfigStore = new VoiceTranscriptionConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "voice-transcription.json"),
		isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
		protect: (plainText) => safeStorage.encryptString(plainText),
		unprotect: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted)),
		log: (message, details) => void appLogger.info("voice-transcription", message, details),
		isLocalReady: (config) => {
			const status = whisperRuntimeManager.getStatus({ cliPath: config.cliPath, localModelId: undefined });
			const selected = getWhisperModelDef(config.localModelId);
			return status.cliReady && Boolean(selected && whisperRuntimeManager.isModelInstalled(selected.id));
		},
	});
	registerVoiceTranscriptionIpc({
		configStore: voiceTranscriptionConfigStore,
		service: new VoiceTranscriptionService({
			getPublicConfig: () => voiceTranscriptionConfigStore.getPublicConfig(),
			getCredentials: () => voiceTranscriptionConfigStore.getCredentials(),
			transcribeLocal: (input) => whisperTranscriber.transcribe(input),
			cancelLocal: (requestId) => whisperTranscriber.cancel(requestId),
			// 流式 2.0：主进程只负责建连与转发帧，握手/序号/收尾都在 VolcengineStreamSession 里。
			createStreamSocket: createVolcStreamSocket,
			emitStreamPartial: (partial) => {
				// 取一次当前主窗口（ctx 侧是 getter，读的是活绑定），保持与原实现的判空窄化一致。
				const mainWindow = ctx.getMainWindow();
				if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.voiceTranscriptionStreamPartial, partial);
			},
			log: (message, details) => void appLogger.info("voice-transcription", message, details),
		}),
		runtimeManager: whisperRuntimeManager,
		// 删模型/换二进制前先放下常驻进程：Windows 的文件锁会让删除直接失败。
		beforeRuntimeMutation: () => whisperServerPool.shutdown("runtime-mutation"),
		emitRuntimeProgress: (progress) => {
			// 同上：getter 每次返回当前窗口，先落到局部常量再做判空窄化。
			const mainWindow = ctx.getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.voiceTranscriptionRuntimeProgress, progress);
		},
	});

	// 生图：凭据来自独立 userData/imagegen.json，不读 pi models.json
	const imageGenConfigStore = new ImageGenConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "imagegen.json"),
		log: (message, ...args) => appLogger.info("imagegen", message, ...args),
	});
	// 生图 session 独立存储：无 pi 会话文件的纯生图草稿把历史落盘到这里（重启可恢复），
	// 不依赖 pi 会话文件也不进 pi 的 sessions 目录（PiDeck userData/imagegen/sessions）。
	// 图片二进制单独落 blobs：JSONL 只留引用，否则几十轮生图就能把会话文件堆到 200 MB+，
	// 渲染进程加载即 OOM（2026-09 白屏事故）。两个根必须同源解析，各拼一次路径会漂移成
	// 「图片写进了 A 目录、协议从 B 目录读」。
	const imageGenRoots = resolveImageGenStorageRoots();
	const imageBlobStore = new ImageBlobStore({ getBlobsPath: () => imageGenRoots.blobs });
	ctx.setAcpImageBlobStore(imageBlobStore);
	void imageBlobStore.ensureDir();
	const imageSessionStore = new ImageSessionStore({
		getStorePath: () => imageGenRoots.sessions,
		blobs: imageBlobStore,
	});
	// pideck-img:// 必须在 app ready 后注册（scheme 特权声明在文件底部 ready 前完成）
	registerImageGenImageProtocol(imageBlobStore);
	// pideck-file://：对话内本地图片只读通道。白名单根=项目目录（含 worktree）+ 聊天工作区
	// + userData + 专属临时图片目录。**不放行整个 %TEMP%**：安装器/解压/其它程序的临时文件
	// 不该被消息内容当图床读（取舍见 docs/markdown-image-rendering-plan.md）。
	// 远端项目没有本机 path（只有 locator）：它们不属于本机图片白名单，必须过滤掉，
	// 否则 map 会产出 undefined 并让整个协议白名单失效。
	// 对话内本地图的白名单根。除了项目/运行时目录，还包含**桌面**：人和 agent 都习惯把
	// 截图、设计稿放在桌面（2026-10-21 实测：会话里 `~/Desktop/PiDeck-Settings-*/x.png`
	// 全被判 403，因为桌面不在白名单）。用 `app.getPath("desktop")` 而不是拼 home/Desktop：
	// 它跟随用户重定向（OneDrive/自定义位置），路径不存在时 realpath 失败会退回原值，
	// 目录里也不可能有能读到的文件，不会放宽真实边界。
	const resolveLocalImageRoots = () => [
		app.getPath("userData"),
		app.getPath("desktop"),
		join(app.getPath("temp"), "pideck-shots"),
		projectStore.getChatProjectPath(),
		...projectStore
			.list()
			.filter(isLocalProject)
			.map((project) => project.path),
	];
	// 协议与 IPC 共用同一份「已规范化 + 5s 缓存」的根列表：realpathSync.native 是同步调用，
	// 一条消息几十张图时不能每次请求都把全部项目根重算一遍。
	const canonicalLocalImageRoots = createCanonicalRootsProvider(resolveLocalImageRoots);
	registerLocalImageProtocol(canonicalLocalImageRoots);
	// 保存/复制要在渲染层拿字节：fetch(pideck-file://) 在该 scheme 上会被拦（corsEnabled: false），
	// 所以字节走 IPC，白名单与体积判定跟协议同一份实现。
	registerLocalImageIpc({ resolveRoots: canonicalLocalImageRoots, appLogger });
	registerImageGenIpc({
		imageGen: new ImageGenService({
			getProviderCredentials: async (provider) => {
				const creds = await imageGenConfigStore.getCredentials(provider);
				if (!creds) return null;
				return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, extraParams: creds.extraParams, referenceMode: creds.provider.referenceMode, apiStyle: creds.provider.apiStyle };
			},
			log: (message, ...args) => appLogger.info("imagegen", message, ...args),
		}),
		imageGenConfig: imageGenConfigStore,
		log: (message, ...args) => appLogger.info("imagegen", message, ...args),
		readImageBlob: (ref) => imageBlobStore.readPayload(ref),
		// 生图记录落盘：user 提示词 + assistant 图片两条消息写入 pi 会话文件，
		// 让「不走 pi/dsh 直连 API」的生图结果也进会话历史（重启后可见）。
		// DSH 会话无 pi 会话文件且 host 无消息追加 API，跳过（生图仍正常返回）。
		// agentManager/sessionCatalog 在此处尚未初始化，闭包延迟引用（IPC 调用时已就绪）。
		persistImageGen: async ({ sessionId, provider, model, prompt, image, size, referenceImages }) => {
			const entry = sessionCatalog?.get(sessionId);
			if (!entry || entry.backend === "dsh") return;
			// 标题更新不依赖会话文件：生图 draft 会话不启动 pi agent，无 filePath，
			// 但仍要把占位标题（Chat agent）换成首行提示词，否则历史/侧栏永远停在占位名；
			// 用户已手动改过名（非占位标题）则不覆盖。
			const project = projectStore.get(entry.projectId);
			if (project && isDefaultAgentTitle(entry.title, project, mainCopy as never)) {
				const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
				if (firstLine) {
					// 自动命名只取首行，不在存储层硬截断；标题展示由侧栏窗口负责钳制，
					// hover 时滚动展示全文。否则 "(fork)" 或英文单词可能被写成残片。
					// 生图没有扩展模型命名链路，首行提示词只算 fallback 所有权。
					await sessionCatalog.applyAutomaticTitle(sessionId, firstLine, "fallback");
					ctx.getMainWindow()?.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
				}
			}
			const localSessionFilePath = sessionCatalog.getLocalFilePath(sessionId);
			// 生图独立持久化：imagegen 后端会话与无 pi 会话文件的纯生图草稿，
			// 都落盘到 ImageSession 独立存储；只有有本地 Pi locator 才写 JSONL。
			if (entry.backend === "imagegen" || !localSessionFilePath) {
				await imageSessionStore.append(sessionId, [
					{
						id: randomUUID(),
						agentId: "",
						role: "user",
						text: prompt,
						timestamp: Date.now(),
						// 参考图随 user 消息落盘：恢复时时间线里能看到参考图
						images: (referenceImages ?? []).map((ref) => ({
							type: "image" as const,
							data: ref.data,
							mimeType: ref.mimeType,
						})),
					},
					{
						id: randomUUID(),
						agentId: "",
						role: "assistant",
						text: "",
						stopReason: "stop",
						timestamp: Date.now(),
						images: [{ type: "image" as const, data: image.data, mimeType: image.mimeType }],
						// 历史恢复靠这个标记区分生图结果与普通图片附件（渲染层 ImageGenMessage）；
						// 结构即 shared/types/imagegen 的 ImageGenMeta，渲染层读取时自行收窄
						meta: { imageGen: { status: "complete", prompt, size } },
					},
				]);
				await sessionCatalog.promoteToActive(sessionId);
				return;
			}
			await agentManager?.appendLocalMessagesToSession(localSessionFilePath, [
				{
					role: "user",
					// 参考图随 user 消息落盘：重启恢复历史时时间线里能看到参考图
					content: [
						{ type: "text", text: prompt },
						...(referenceImages ?? []).map((ref) => ({
							type: "image" as const,
							source: {
								type: "base64" as const,
								media_type: ref.mimeType,
								data: ref.data,
							},
						})),
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: image.mimeType,
								data: image.data,
							},
						},
					],
					extra: {
						api: "openai-images",
						provider,
						model,
						// 历史恢复依赖这个标记区分生图结果与普通图片附件，
						// 否则重启后会退回普通图片渲染，丢失复制/保存操作。
						imageGen: { status: "complete", prompt, size },
					},
				},
			]);
			// 生图消息不走 Agent 消息流，refreshAutoTitle 不会触发，标题更新已在 filePath 判断前完成。
		},
	});

	return { imageSessionStore };
}
