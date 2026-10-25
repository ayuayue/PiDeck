/**
 * 生图独立配置落盘（userData/imagegen.json）。
 * 不读写 pi 的 models.json / auth.json——生图供应商与会话 LLM 供应商分离。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EMPTY_IMAGE_GEN_CONFIG, findImageGenProvider, sanitizeImageGenConfig, type ImageGenConfigFile, type ImageGenProviderConfig, type ImageGenProviderExtraParams } from "../../shared/imageGenConfig";

export type ImageGenCredentials = {
	baseUrl: string;
	apiKey: string;
	extraParams: ImageGenProviderExtraParams;
	provider: ImageGenProviderConfig;
};

export class ImageGenConfigStore {
	constructor(
		private readonly deps: {
			/** 配置文件绝对路径（主进程用 userData/imagegen.json，测试注入临时文件） */
			getConfigPath: () => string;
			log: (message: string, ...args: unknown[]) => void;
		},
	) {}

	async getConfig(): Promise<ImageGenConfigFile> {
		try {
			const raw = await readFile(this.deps.getConfigPath(), "utf8");
			return sanitizeImageGenConfig(JSON.parse(raw) as unknown);
		} catch {
			return { ...EMPTY_IMAGE_GEN_CONFIG, providers: [] };
		}
	}

	async saveConfig(input: unknown): Promise<{ ok: true; config: ImageGenConfigFile } | { ok: false; error: string }> {
		const config = sanitizeImageGenConfig(input);
		try {
			const filePath = this.deps.getConfigPath();
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
			this.deps.log("imagegen", "config saved", {
				providers: config.providers.length,
				activeProviderId: config.activeProviderId,
				activeModel: config.activeModel,
				// 只记是否有 key，不记 key 值
				hasApiKey: config.providers.some((provider) => Boolean(provider.apiKey)),
			});
			return { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("imagegen", "config save failed", { error: message });
			return { ok: false, error: message };
		}
	}

	/**
	 * 按供应商 id 取凭据；id 为空则用上次选中的 activeProviderId。
	 * 缺 baseUrl 或 apiKey 返回 null（调用方映射 notConfigured）。
	 */
	async getCredentials(providerId?: string): Promise<ImageGenCredentials | null> {
		const config = await this.getConfig();
		const id = (providerId ?? "").trim() || config.activeProviderId;
		const provider = findImageGenProvider(config, id);
		if (!provider) return null;
		const baseUrl = provider.baseUrl.trim();
		const apiKey = provider.apiKey.trim();
		if (!baseUrl || !apiKey) return null;
		return { baseUrl, apiKey, extraParams: provider.extraParams, provider };
	}
}
