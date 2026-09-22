import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 生图契约：独立 imagegen.json、IPC 三处同步、composer 不读会话 LLM、
 * extraParams 驱动底栏、i18n key 对齐。
 */

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const imagegenIpc = readFileSync("src/main/ipc/imagegenIpc.ts", "utf8");
const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeSelect = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const composerPanels = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
// 设置页 tab 的标题 i18n key 已收敛到这份布局模块（命令面板 Ctrl+P 搜设置项复用同一份）
const settingsTabLayout = readFileSync("src/renderer/src/components/app/settings/settingsTabLayout.ts", "utf8");

test("IPC 通道三处同步：generate / get-config / save-config", () => {
	assert.match(ipc, /imagegenGenerate: "imagegen:generate"/);
	assert.match(ipc, /imagegenGetConfig: "imagegen:get-config"/);
	assert.match(ipc, /imagegenSaveConfig: "imagegen:save-config"/);
	assert.match(imagegenIpc, /ipcChannels\.imagegenGenerate/);
	assert.match(imagegenIpc, /ipcChannels\.imagegenGetConfig/);
	assert.match(imagegenIpc, /ipcChannels\.imagegenSaveConfig/);
	assert.match(preload, /ipcChannels\.imagegenGenerate/);
	assert.match(preload, /ipcChannels\.imagegenGetConfig/);
	assert.match(preload, /ipcChannels\.imagegenSaveConfig/);
	assert.match(preload, /generate: \(request: ImageGenRequest\)/);
	assert.match(preload, /getConfig: \(\) =>/);
	assert.match(preload, /saveConfig: \(config: ImageGenConfigFile\)/);
});

test("IPC 通道三处同步：read-image-blob（按需取回落盘图片）", () => {
	assert.match(ipc, /imagegenReadImageBlob: "imagegen:read-image-blob"/);
	assert.match(imagegenIpc, /ipcChannels\.imagegenReadImageBlob/);
	assert.match(preload, /ipcChannels\.imagegenReadImageBlob/);
	assert.match(preload, /readImageBlob: \(ref: string\)/);
	// 入参在 IPC 边界收窄成非空字符串（渲染层数据不可信）
	assert.match(imagegenIpc, /typeof ref !== "string" \|\| !ref/);
});

test("生图图片落盘：blob 存储 + pideck-img 协议 + CSP 允许", () => {
	const protocol = readFileSync("src/main/imagegen/ImageGenImageProtocol.ts", "utf8");
	const blobStore = readFileSync("src/main/imagegen/ImageBlobStore.ts", "utf8");
	const sessionStore = readFileSync("src/main/imagegen/ImageSessionStore.ts", "utf8");
	const html = readFileSync("src/renderer/index.html", "utf8");
	// 装配：两个磁盘根同源解析 + 协议注册 + 按需读取回灌
	assert.match(mainIndex, /new ImageBlobStore\(/);
	assert.match(mainIndex, /resolveImageGenStorageRoots\(\)/);
	assert.match(mainIndex, /registerImageGenImageProtocol\(imageBlobStore\)/);
	assert.match(mainIndex, /scheme: "pideck-img"/);
	assert.match(mainIndex, /readImageBlob: \(ref\) => imageBlobStore\.readPayload\(ref\)/);
	// 协议：白名单解析 + 只允许 blobs 目录内的引用名
	assert.match(protocol, /protocol\.handle\(IMAGE_BLOB_PROTOCOL/);
	assert.match(protocol, /blobs\.resolvePath\(ref\)/);
	assert.match(blobStore, /IMAGE_BLOB_REF_RE/);
	// 会话存储：字节水位 + 旧格式自愈 + base64 不落 JSONL + 追加不重写
	assert.match(sessionStore, /MAX_SESSION_BYTES/);
	assert.match(sessionStore, /MAX_READ_BYTES/);
	assert.match(sessionStore, /migrateLegacyFile/);
	assert.match(sessionStore, /readTailLines/);
	// 回归守卫：每轮「全量读 + 全量重写」是 246 MB 事故的直接成因，必须只追加
	assert.match(sessionStore, /appendFile\(file/);
	assert.doesNotMatch(sessionStore, /import \{[^}]*readFile[^}]*\} from "node:fs\/promises"/);
	// CSP：渲染层 <img> 必须被允许加载 pideck-img:
	assert.match(html, /img-src[^"]*pideck-img:/);
});

test("主进程装配：ImageGenConfigStore + 独立 userData/imagegen.json", () => {
	assert.match(mainIndex, /new ImageGenConfigStore\(/);
	assert.match(mainIndex, /join\(app\.getPath\("userData"\), "imagegen\.json"\)/);
	assert.match(mainIndex, /registerImageGenIpc\(\{/);
	assert.match(mainIndex, /imageGenConfig: imageGenConfigStore/);
	assert.match(mainIndex, /extraParams: creds\.extraParams/);
	assert.doesNotMatch(mainIndex, /resolveProviderCredentials/);
	assert.doesNotMatch(imagegenIpc, /getModelsConfig\(\)/);
	assert.doesNotMatch(imagegenIpc, /getAuthConfig\(\)/);
});

test("IPC 入参校验：model/prompt 非空，prompt ≤ 4000，provider 可空（回落到 active）", () => {
	assert.match(imagegenIpc, /typeof candidate\?\.provider === "string"/);
	assert.match(imagegenIpc, /typeof candidate\?\.model === "string"/);
	assert.match(imagegenIpc, /typeof candidate\?\.prompt === "string"/);
	assert.match(imagegenIpc, /prompt\.length > 4000/);
	assert.match(imagegenIpc, /if \(!model \|\| !prompt/);
	assert.match(imagegenIpc, /parseImageGenSize\(candidate\?\.size\)/);
	assert.match(imagegenIpc, /parseImageGenWatermark\(candidate\?\.watermark/);
	assert.match(imagegenIpc, /parseImageGenOutputFormat\(candidate\?\.outputFormat/);
	assert.match(imagegenIpc, /imageGen\.generate\(\{ provider, model, prompt, size, watermark, outputFormat, referenceImages \}/);
	// 参考图入参在 IPC 边界整体校验，非法 all-or-null
	assert.match(imagegenIpc, /parseImageGenReferenceImages/);
});

test("ComposerAgentMode 含 imagegen 与 goal", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "goal"/);
});

test("composer 生图底栏用独立配置，不读会话 LLM", () => {
	const options = readFileSync("src/renderer/src/components/session/ComposerImageGenOptions.tsx", "utf8");
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	const configUi = readFileSync("src/renderer/src/components/config/ImageGenSection.tsx", "utf8");
	assert.match(composerComponents, /imageGenOptions\?:/);
	assert.match(composerComponents, /ComposerImageGenOptions/);
	assert.match(composerComponents, /isImageGenMode \? null/);
	assert.match(options, /IMAGE_GEN_SIZE_PRESETS/);
	assert.match(options, /IMAGE_GEN_SIZE_UNSET/);
	assert.match(options, /ImageGenSizeCombobox/);
	assert.match(options, /extra\.size/);
	assert.match(options, /extra\.output_format/);
	assert.match(options, /extra\.watermark/);
	assert.match(area, /composer\.delivery\.imageGenConfig/);
	assert.match(area, /composer\.delivery\.setImageGenSelection/);
	assert.match(options, /encodeImageGenSelection/);
	assert.match(options, /SelectGroup/);
	// 空的 activeProviderId/activeModel 必须保持未选择，不能在底栏静默落到 providers[0]。
	assert.match(options, /providers\.find\(\(item\) => item\.id === props\.providerId\)/);
	assert.doesNotMatch(options, /providers\[0\]/);
	assert.doesNotMatch(controller, /findImageGenProvider\(imageGenConfig, activeImageGenProviderId\) \?\? imageGenConfig\.providers\[0\]/);
	assert.match(controller, /imageGenConfigAtom/);
	assert.match(controller, /findImageGenProvider/);
	assert.match(controller, /provider: provider\.id/);
	assert.doesNotMatch(controller, /provider: model\.provider/);
	assert.doesNotMatch(controller, /imageGenArkFieldsSupported/);
	assert.match(settingsModal, /value="imagegen"/);
	// TAB_META 只留 icon，labelKey 取 SETTINGS_TAB_LABEL_KEYS（值仍指向 settings.tabs.imagegen）
	assert.match(settingsModal, /labelKey: SETTINGS_TAB_LABEL_KEYS\.imagegen/);
	assert.match(settingsTabLayout, /imagegen: "settings\.tabs\.imagegen"/);
	assert.match(configUi, /config\.imagegen\.extraParams/);
	assert.doesNotMatch(configUi, /kindOpenai|kindArk|IMAGE_GEN_KINDS/);
});

test("composer 模式选择器与底栏三态（含生图图标）", () => {
	// 模式三态已重构进 ComposerComponents（旧 ComposerModeSelect.tsx 已删）：
	// 模式项标签文案 modeIconLabel 与 imagegen 图标内联在组件里
	assert.match(composerModeSelect, /mode === "imagegen"/);
	assert.match(composerModeSelect, /"app\.composerModeImagegen"/);
	assert.match(composerModeSelect, /<Select/);
	assert.match(composerModeSelect, /<ImageIcon size=\{14\}/);
	assert.match(composerComponents, /ComposerPickerHost|composerModeLabel|modeOptions/);
	assert.match(composerComponents, /const isImageGenMode = props\.composerAgentMode === "imagegen"/);
	assert.doesNotMatch(composerComponents, /ComposerModePicker|onOpenComposerModePicker|composer-mode-picker/);
	assert.doesNotMatch(composerComponents, /onGenerateImage/);
});

test("controller：生图分支不 send、生图占位消息三态上屏（不进附件栏）、错误码映射", () => {
	assert.match(controller, /if \(mode === "imagegen"\) \{\s*void generateImage\(\);\s*return;\s*\}/);
	assert.match(controller, /desktopApi\.imagegen\.generate\(\{/);
	assert.match(controller, /size: imageGenSize/);
	assert.match(controller, /watermark: imageGenWatermark/);
	assert.match(controller, /outputFormat: imageGenOutputFormat/);
	assert.match(controller, /appendTimelineMessage/);
	assert.match(controller, /setCacheMessages\(\{ sessionId, messages: \[\.\.\.previous, message\], source: "runtime" \}\)/);
	assert.match(controller, /role: "user"/);
	assert.match(controller, /role: "assistant"/);
	assert.match(controller, /stopReason: "stop"/);
	assert.match(controller, /updateTimelineMessage/);
	assert.match(controller, /const imageMessageId = crypto\.randomUUID\(\)/);
	assert.match(controller, /imageGen: \{ status: "generating", prompt/);
	assert.match(controller, /imageGen: \{ status: "complete", prompt/);
	assert.match(controller, /images: \[result\.image\]/);
	assert.match(controller, /status: "error"/);
	assert.match(controller, /errorDetail: mapImageGenError\(result\.error, result\.detail\)/);
	assert.doesNotMatch(controller, /setAttachments\(\(current\) => \[\.\.\.current, result\.image\]\)/);
	assert.doesNotMatch(controller, /role: "error"/);
	assert.match(controller, /function mapImageGenError\(error: string, detail\?: string\)/);
	assert.match(controller, /case "notConfigured"/);
	assert.match(controller, /case "invalidKey"/);
	assert.match(controller, /imagegen\.error\.invalidKeyDetail/);
	assert.match(controller, /case "badBaseUrl"/);
	assert.match(controller, /imagegen\.error\.badBaseUrlDetail/);
	assert.match(controller, /case "http"/);
	assert.match(controller, /t\("imagegen\.error\.http", \{ detail: extra \}\)/);
});

test("发送控件：生图进行中显示转圈并禁用", () => {
	assert.match(composerPanels, /isGeneratingImage\?: boolean/);
	// 三元的 JSX 可能被格式化到下一行：只锁条件表达式。
	assert.match(composerPanels, /isGeneratingImage \? \(?/);
	assert.match(composerPanels, /props\.isAgentStarting \|\| props\.isGeneratingImage \|\| !props\.canSend/);
});

test("生图结果提供原图复制与按 mime 保存", () => {
	const finalAnswer = readFileSync("src/renderer/src/components/session/turn/FinalAnswer.tsx", "utf8");
	assert.match(finalAnswer, /writeClipboardImage/);
	assert.doesNotMatch(finalAnswer, /fetch\(imageDataUrl\)/);
	assert.doesNotMatch(finalAnswer, /navigator\.clipboard\.write\(\[new ClipboardItem/);
	assert.match(finalAnswer, /image\.mimeType === "image\/jpeg" \? "jpg" : "png"/);
	assert.match(finalAnswer, /imagegen\.copy/);
	assert.match(finalAnswer, /imagegen\.save/);
	assert.match(finalAnswer, /whitespace-pre-wrap/);
	assert.match(finalAnswer, /props.meta.errorDetail/);
});

test("i18n：zh/en 生图模式与错误文案 key 一致", () => {
	const extract = (src) => [...src.matchAll(/"(app\.composerModeImagegen|app\.composerModeImagegenDesc|imagegen\.[^"]+|config\.nav\.imagegen|config\.imagegen\.[^"]+)"/g)].map((m) => m[0].slice(1, -1)).sort();
	const zhKeys = extract(zh);
	const enKeys = extract(en);
	assert.ok(zhKeys.length >= 8, `zh imagegen keys: ${zhKeys.length}`);
	assert.deepEqual(zhKeys, enKeys);
	assert.match(zh, /settings\.tabs\.imagegen/);
	assert.match(en, /settings\.tabs\.imagegen/);
	assert.match(zh, /settings\.tabs\.imagegenDesc/);
	assert.match(en, /settings\.tabs\.imagegenDesc/);
	assert.match(zh, /config\.nav\.imagegen/);
	assert.match(zh, /config\.imagegen\.paramWatermark/);
	assert.match(zh, /"imagegen\.error\.http": "生图服务返回错误（\{detail\}）"/);
	assert.match(en, /"imagegen\.error\.http": "Image service returned an error \(\{detail\}\)"/);
	assert.match(zh, /imagegen\.error\.invalidKeyDetail/);
	assert.match(zh, /imagegen\.error\.badBaseUrlDetail/);
});
