/**
 * PiResourceTargetResolver (W1): the only place a resource target becomes a filesystem home.
 *
 * Pure parsing + injected ports: a WSL target is the app's single WSL environment (settings wslDistro/wslUser)
 * -> resolveWslEnvironment -> the distribution HOME as a Windows UNC path (skills/prompts/extensions live under
 * <home>/.pi/agent). It never starts wsl.exe itself and never falls back to the local home: an unconfigured
 * environment, an unreachable distro or a resolved environment that contradicts the settings fails with a stable
 * code before any manager is constructed.
 */

import { isAbsolute } from "node:path";
import { PI_RESOURCE_CODES, type PiResourceTarget } from "../../shared/piConfig";
import { parseWslUncPath, type WslEnvironment } from "../wsl/WslPaths";
import { piResourceStableCodeOf, readPiResourceTarget } from "./piResourceTarget";

/** Where a resource request must read/write. cacheKey is the isolation key (distro + user). */
export type PiResourceTargetResolution =
	| { kind: "local"; cacheKey: "local"; home: string }
	| {
			kind: "wsl";
			cacheKey: string;
			home: string;
			distro: string;
			user: string;
			environment: WslEnvironment;
	  };

export type PiResourceTargetResolverPorts = {
	/** The app's single WSL identity (settings: wslDistro/wslUser); undefined = WSL not configured. */
	readWslIdentity: () => Promise<{ distro: string; user: string } | undefined>;
	/** resolveWslEnvironment(distro, user): the production port also validates UNC shape (see WslPiConfigStoreFor). */
	resolveEnvironment: (distro: string, user: string) => Promise<WslEnvironment>;
	/** Local HOME (Windows home on every platform, matching the rest of the main process). */
	localHome: () => string;
};

export type PiResourceTargetResolver = {
	resolve(target: unknown): Promise<PiResourceTargetResolution>;
};

function stable(code: string): Error {
	return new Error(code);
}

export function createPiResourceTargetResolver(ports: PiResourceTargetResolverPorts): PiResourceTargetResolver {
	async function resolveWsl(): Promise<PiResourceTargetResolution> {
		let identity: { distro: string; user: string } | undefined;
		try {
			identity = await ports.readWslIdentity();
		} catch {
			// 设置读不出来就无法证明目标存在：fail closed，不退回本机。
			throw stable(PI_RESOURCE_CODES.unavailable);
		}
		if (identity === undefined || identity.distro === "" || identity.user === "") throw stable(PI_RESOURCE_CODES.unavailable);

		let environment: WslEnvironment;
		try {
			environment = await ports.resolveEnvironment(identity.distro, identity.user);
		} catch (error) {
			// 端口自己给出的稳定码原样透出；意外失败按发行版不可用处理（绝不当成本机目录继续读写）。
			throw stable(piResourceStableCodeOf(error) ?? PI_RESOURCE_CODES.distroUnavailable);
		}
		// 解析出的环境必须与设置自洽：printenv 回退 / 发行版改名 / 非绝对 HOME 时宁可拒绝，
		// 也不把资源管理实例指向另一个发行版或本机目录。
		const unc = parseWslUncPath(environment.windowsHome);
		if (!unc || unc.distro.toLowerCase() !== identity.distro.toLowerCase() || unc.linuxPath !== environment.linuxHome || !isAbsolute(environment.windowsHome)) {
			throw stable(PI_RESOURCE_CODES.unavailable);
		}
		return {
			kind: "wsl",
			cacheKey: `wsl:${identity.distro}:${identity.user}`,
			home: environment.windowsHome,
			distro: identity.distro,
			user: identity.user,
			environment,
		};
	}

	return {
		async resolve(value: unknown): Promise<PiResourceTargetResolution> {
			const target: PiResourceTarget = readPiResourceTarget(value);
			if (target.kind === "local") return { kind: "local", cacheKey: "local", home: ports.localHome() };
			return await resolveWsl();
		},
	};
}
