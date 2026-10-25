import type { AppSettings } from "../../shared/types";
import type { TelemetrySnapshot } from "./telemetrySnapshot";

type TelemetrySettingsStore = {
	get: () => AppSettings;
	update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
};

type TelemetryMetadata = {
	appVersion: string;
	platform: NodeJS.Platform;
	arch: NodeJS.Architecture;
	packaged: boolean;
};

type TelemetryConfig = {
	projectKey?: string;
	host?: string;
};

type HeartbeatProperties = {
	app_version: string;
	platform: NodeJS.Platform;
	arch: NodeJS.Architecture;
	packaged: boolean;
	install_id: string;
	$set: Record<string, string | number | boolean | string[]>;
};

type CaptureRequest = {
	url: string;
	body: {
		api_key: string;
		event: "app_heartbeat";
		distinct_id: string;
		// unknown 索引容纳快照标量/数组与嵌套的 $set 对象，固定字段仍保有精确类型
		properties: HeartbeatProperties & Record<string, unknown>;
	};
};

export type TelemetryCapture = (request: CaptureRequest) => Promise<void>;

export type TelemetryServiceOptions = {
	settingsStore: TelemetrySettingsStore;
	capture: TelemetryCapture;
	config: TelemetryConfig;
	metadata: TelemetryMetadata;
	/** 心跳附带的匿名快照（功能开关/规模计数/平台环境），在全部发送门禁通过后才调用，
	 *  合并进 event properties 与 person $set；固定字段后写，快照无法覆盖。 */
	snapshot?: () => TelemetrySnapshot;
	now?: () => Date;
	createInstallId?: () => string;
};

export class TelemetryService {
	private readonly now: () => Date;
	private readonly createInstallId: () => string;

	constructor(private readonly options: TelemetryServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.createInstallId = options.createInstallId ?? (() => crypto.randomUUID());
	}

	async sendHeartbeat() {
		const settings = this.options.settingsStore.get();
		const projectKey = this.options.config.projectKey?.trim();
		const host = normalizePostHogHost(this.options.config.host);
		if (!settings.telemetryEnabled || !this.options.metadata.packaged || !projectKey || !host) {
			return;
		}

		const today = toLocalDateKey(this.now());
		if (settings.telemetryLastHeartbeatDate === today) return;

		const installId = settings.telemetryInstallId || this.createInstallId();
		const snapshot = this.options.snapshot?.() ?? {};
		await this.options.capture({
			url: `${host}/capture/`,
			body: {
				api_key: projectKey,
				event: "app_heartbeat",
				distinct_id: installId,
				properties: {
					...snapshot,
					app_version: this.options.metadata.appVersion,
					platform: this.options.metadata.platform,
					arch: this.options.metadata.arch,
					packaged: this.options.metadata.packaged,
					install_id: installId,
					$set: {
						...snapshot,
						app_version: this.options.metadata.appVersion,
						platform: this.options.metadata.platform,
						arch: this.options.metadata.arch,
						packaged: this.options.metadata.packaged,
					},
				},
			},
		});

		// Only mark the day as sent after PostHog accepts the request; transient
		// network failures should retry on next launch instead of silently losing data.
		await this.options.settingsStore.update({
			telemetryInstallId: installId,
			telemetryLastHeartbeatDate: today,
		});
	}
}

function normalizePostHogHost(host?: string) {
	const trimmed = host?.trim();
	if (!trimmed) return "";
	return trimmed.replace(/\/+$/, "");
}

function toLocalDateKey(date: Date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
