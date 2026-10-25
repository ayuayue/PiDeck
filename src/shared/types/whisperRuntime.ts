/**
 * 本地语音转写（whisper.cpp）运行时契约：模型目录、平台二进制清单、状态与进度类型。
 *
 * 为什么进包为 0 字节：whisper-cli 二进制（~9MB）与 ggml 模型（181~547MB）都在用户
 * 点击「下载」后才拉取到 userData/voice-runtime/，安装包本身不受影响。
 *
 * 数据锚点（2026-09 核对，更新版本时同步改这里）：
 * - 二进制：whisper.cpp 官方 GitHub Nightly Release（tag 固定，防漂移）；
 * - 模型：ggerganov/whisper.cpp HuggingFace 仓库，sha256 取自 LFS oid，
 *   镜像顺序 hf-mirror.com → huggingface.co。
 */

export type WhisperModelId = "small-q5_1" | "medium-q5_0" | "turbo-q5_0";

export type WhisperModelDef = {
	id: WhisperModelId;
	/** HuggingFace 仓库内的文件名。 */
	file: string;
	/** 期望字节数（下载上限判据）。 */
	bytes: number;
	/** LFS sha256（小写 hex），下载后必须逐一校验。 */
	sha256: string;
	/** 设置页展示名（非 i18n：模型名是专有名词）。 */
	label: string;
	/** 是否支持多语言（false = 仅英文，语言下拉需联动）。 */
	multilingual: boolean;
};

export const WHISPER_MODEL_CATALOG: readonly WhisperModelDef[] = [
	{ id: "small-q5_1", file: "ggml-small-q5_1.bin", bytes: 190085487, sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", label: "Small (q5_1) · 181MB", multilingual: true },
	{ id: "medium-q5_0", file: "ggml-medium-q5_0.bin", bytes: 539212467, sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f", label: "Medium (q5_0) · 514MB", multilingual: true },
	{ id: "turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", bytes: 574041195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", label: "Large v3 Turbo (q5_0) · 547MB", multilingual: true },
];

/**
 * 清单下限收在 Small（181MB）：Tiny / Base 已按实测效果下架（2026-09 用户反馈——
 * 「180 多兆这一档才刚刚可以使用」，更小档位准确率不可接受）。
 * 默认档取下限而不是最大档：首次启用只需下载 181MB，想要更准可在设置页升到 Medium / Turbo。
 * 下架只是从清单移除：旧 id 的 .bin 不再出现在设置页（成为孤儿文件，刻意不自动删），
 * 存量配置里的旧 id 由 sanitizeVoiceTranscriptionConfig 回落到默认档。
 */
export const DEFAULT_WHISPER_MODEL_ID: WhisperModelId = "small-q5_1";

export function getWhisperModelDef(id: unknown): WhisperModelDef | undefined {
	return typeof id === "string" ? WHISPER_MODEL_CATALOG.find((def) => def.id === id) : undefined;
}

/** whisper.cpp 官方 Nightly tag（固定版本；升级时连同各资产 URL/清单一起核对）。 */
export const WHISPER_CPP_RELEASE_TAG = "b5130";
const WHISPER_CPP_RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE_TAG}`;

/** GitHub Release API 地址：安装时读取各资产的 digest(sha256)，GitHub 不可达时降级为「哈希锁定」模式。 */
export function whisperCppReleaseApiUrl(): string {
	return `https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${WHISPER_CPP_RELEASE_TAG}`;
}

export type WhisperHostSupport = {
	/** 是否支持一键下载二进制（macOS 官方无 CLI 预编译包，只能手动指定路径）。 */
	autoRuntime: boolean;
	/** 归档资产文件名。 */
	asset: string;
	/** 归档格式（决定解压器）。 */
	format: "zip" | "tar.gz";
};

/** 按 Node platform/arch 解析官方预编译归档；未知架构返回 null。 */
export function resolveWhisperHostSupport(platform: NodeJS.Platform | string, arch: string): WhisperHostSupport | null {
	if (platform === "win32" && arch === "x64") return { autoRuntime: true, asset: "whisper-bin-x64.zip", format: "zip" };
	if (platform === "win32" && arch === "arm64") return { autoRuntime: true, asset: "whisper-bin-win-cpu-arm64.zip", format: "zip" };
	if (platform === "linux" && arch === "x64") return { autoRuntime: true, asset: "whisper-bin-ubuntu-x64.tar.gz", format: "tar.gz" };
	if (platform === "linux" && arch === "arm64") return { autoRuntime: true, asset: "whisper-bin-ubuntu-arm64.tar.gz", format: "tar.gz" };
	if (platform === "darwin") return { autoRuntime: false, asset: "", format: "tar.gz" };
	return null;
}

export function whisperAssetUrl(asset: string): string {
	return `${WHISPER_CPP_RELEASE_BASE}/${asset}`;
}

/** 模型下载候选源：镜像优先（国内可达），官方兜底。 */
export function whisperModelUrlCandidates(file: string): string[] {
	return [`https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${file}`, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`];
}

/** 运行时/模型状态（主进程 stat + 校验记录得出，渲染层只读）。 */
export type WhisperRuntimeStatus = {
	/** 当前平台是否支持一键下载二进制。 */
	autoRuntimeSupported: boolean;
	/** whisper-cli 已就位（自动下载或用户指定的自定义路径有效）。 */
	cliReady: boolean;
	/** 生效的 CLI 来源：auto = 下载目录，custom = 设置里的自定义路径。 */
	cliSource: "auto" | "custom" | "none";
	/** 解析出的 whisper-cli 可执行文件绝对路径（未就绪为 null）。 */
	cliPath: string | null;
	/** 已安装的版本标签。 */
	runtimeVersion: string | null;
	/**
	 * 各模型安装状态。
	 * `partialBytes`：未完成下载（.part）已落盘的字节数，>0 表示下次点下载会从这里续传。
	 */
	models: Array<{ id: WhisperModelId; installed: boolean; bytes: number; partialBytes?: number }>;
};

/** 安装进度（runtime 与 model 共用一条事件通道）。 */
export type WhisperInstallProgress = {
	target: "runtime" | WhisperModelId;
	phase: "downloading" | "verifying" | "installing" | "done" | "error";
	percent: number;
	receivedBytes?: number;
	totalBytes?: number;
	error?: string;
};

export type WhisperInstallResult = { ok: true } | { ok: false; error: string };
