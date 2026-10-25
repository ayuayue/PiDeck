/**
 * 生视频独立配置落盘（userData/videogen.json）。
 * 不读写 pi 的 models.json / auth.json——与生图 imagegen.json 平行的独立信任域。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EMPTY_VIDEO_GEN_CONFIG, findVideoGenProvider, sanitizeVideoGenConfig, type VideoGenConfigFile, type VideoGenProviderConfig, type VideoGenProtocolFamily } from "../../shared/videoGenConfig";

export type VideoGenCredentials = {
	baseUrl: string;
	apiKey: string;
	protocol: VideoGenProtocolFamily;
	provider: VideoGenProviderConfig;
};

export class VideoGenConfigStore {
	constructor(
		private readonly deps: {
			/** 配置文件绝对路径（主进程用 userData/videogen.json，测试注入临时文件） */
			getConfigPath: () => string;
			log: (message: string, ...args: unknown[]) => void;
		},
	) {}

	async getConfig(): Promise<VideoGenConfigFile> {
		try {
			const raw = await readFile(this.deps.getConfigPath(), "utf8");
			return sanitizeVideoGenConfig(JSON.parse(raw) as unknown);
		} catch {
			return { ...EMPTY_VIDEO_GEN_CONFIG, providers: [] };
		}
	}

	async saveConfig(input: unknown): Promise<{ ok: true; config: VideoGenConfigFile } | { ok: false; error: string }> {
		const config = sanitizeVideoGenConfig(input);
		try {
			const filePath = this.deps.getConfigPath();
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
			this.deps.log("videogen", "config saved", {
				providers: config.providers.length,
				activeProviderId: config.activeProviderId,
				activeModel: config.activeModel,
				// 只记是否有 key，不记 key 值
				hasApiKey: config.providers.some((provider) => Boolean(provider.apiKey)),
			});
			return { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("videogen", "config save failed", { error: message });
			return { ok: false, error: message };
		}
	}

	/**
	 * 按供应商 id 取凭据；id 为空则用上次选中的 activeProviderId。
	 * 缺 baseUrl 或 apiKey 返回 null（调用方映射 notConfigured）。
	 */
	async getCredentials(providerId?: string): Promise<VideoGenCredentials | null> {
		const config = await this.getConfig();
		const id = (providerId ?? "").trim() || config.activeProviderId;
		const provider = findVideoGenProvider(config, id);
		if (!provider) return null;
		const baseUrl = provider.baseUrl.trim();
		const apiKey = provider.apiKey.trim();
		if (!baseUrl || !apiKey) return null;
		return { baseUrl, apiKey, protocol: provider.protocol, provider };
	}
}
