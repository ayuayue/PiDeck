import { execFile } from "node:child_process";
import type { AppSettings, PiExtensionListResult, PiExtensionSummary } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";

type SettingsProvider = () => AppSettings;

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * list/remove 都使用 --no-approve，防止配置弹窗因为项目级信任确认而阻塞。
 */
export class ExtensionManager {
	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
	) {}

	async list(): Promise<PiExtensionListResult> {
		const raw = await this.runPi(["list", "--no-approve"], 20_000);
		return { extensions: this.parseListOutput(raw), raw };
	}

	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error("扩展来源不能为空");
		await this.runPi([
			"remove",
			normalized,
			...(scope === "project" ? ["-l"] : []),
			"--no-approve",
		], 30_000);
	}

	private async runPi(args: string[], timeout: number) {
		const command = this.locator.resolveCommand(this.getSettings().customPiPath);
		const invocation = this.locator.createInvocation(command, args);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: {
						...this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
						PI_OFFLINE: "1",
					},
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = (stderr || error.message).trim();
						reject(new Error(detail || "pi 扩展命令执行失败"));
						return;
					}
					resolve(stdout);
				},
			);
		});
	}

	private parseListOutput(raw: string): PiExtensionSummary[] {
		const result: PiExtensionSummary[] = [];
		let scope: PiExtensionSummary["scope"] = "unknown";
		let pending: PiExtensionSummary | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (/^User packages:/i.test(trimmed)) {
				scope = "user";
				pending = null;
				continue;
			}
			if (/^Project packages:/i.test(trimmed)) {
				scope = "project";
				pending = null;
				continue;
			}

			if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
				pending = {
					id: `${scope}:${trimmed}`,
					source: trimmed,
					scope,
				};
				result.push(pending);
				continue;
			}

			if (pending && !pending.path) {
				pending.path = trimmed;
			}
		}

		return result;
	}
}
