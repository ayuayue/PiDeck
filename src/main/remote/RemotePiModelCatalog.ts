/**
 * 远端主机上的 pi 模型目录（与本机 `pi --list-models` 逐字对称）。
 *
 * 为什么不用「问运行中的远端 pi 进程」：
 * - 会话没激活就拿不到目录 ⇒ 用户必须先盲发一条消息才能选模型；
 * - 目录生命周期被 runtime 绑死 ⇒ 进程重启/空闲回收/断线立刻让选择器变空；
 * - 与本机语义不对称（本机 `pi --list-models` 是一次性 CLI，不需要任何 agent 在跑），
 *   这种不对称会在每个「先选后建」的功能上再制造一次特例。
 *
 * 这里的做法就是用户要的那句「远端算好，传回来，缓存住」：经同一条 pinned ssh 通道跑一次
 * `pi --list-models`，用本机同一个纯函数 `parsePiListModels` 解析，按主机缓存。
 * 命令行只由 `buildRemotePiListModelsCommand` 构造（解释器 + pi 路径 + 字面量参数），无用户输入。
 *
 * 档位与本机同构（见 `REMOTE_PI_MODEL_LIST_ARGS`）：手动刷新（force）从「带扩展」全量档起步，
 * 默认走快速档。**扩展贡献的模型（issue #181）只会在手动刷新后出现**——默认档带了
 * `--no-extensions`，所以「默认看不到某插件贡献的模型」是设计取舍，不是 bug；点刷新就该出来。
 * 同理，快速档解析为空时也会继续降档（可能是「模型全来自扩展」的假空），只有全部档位都空才是真空。
 *
 * 配置页与选择器共用这份主机目录；RemotePiModelProbe 只保留旧运行时探测及 DTO 脱敏规则。
 *
 * 失败语义：返回稳定码，**不**抛异常、不伪造空列表——调用方据此回退到 runtime 或如实报错。
 */

import type { AvailableModel } from "../../shared/types";
import { isUnknownCliOption, parsePiListModels } from "../pi/modelListCache";
import { buildRemotePiListModelsCommand, type RemotePiListModelsMode } from "./RemotePiDiscovery";

/** 远端目录缓存 TTL：与本机 `pi --list-models` 的磁盘节流同量级，够快到不挡人，够慢到不反复起进程。 */
export const REMOTE_MODEL_CATALOG_TTL_MS = 5 * 60_000;

export const REMOTE_MODEL_CATALOG_CODES = {
	/** 命令跑不起来 / 退出非 0（含 pi 版本太老不认旗标且后续档位也失败）。 */
	failed: "REMOTE_MODEL_CATALOG_FAILED",
	/** 所有档位都退出 0 但解析不出任何模型（远端没配 models.json、也没登录任何 provider）。 */
	empty: "REMOTE_MODEL_CATALOG_EMPTY",
} as const;

export type RemoteModelCatalogDeps = {
	/**
	 * 这台主机上「用哪个 node 解释哪个 pi」（与远端启动同一份事实，来自连接层已缓存的探测）。
	 * 未连接/未探到 pi 时抛错，由这里折叠成稳定码。
	 */
	resolveFacts: (hostId: string) => Promise<{ piPath: string; nodePath: string }>;
	/** 在目标主机上执行一条远端命令（pinned ssh，`ssh-batch` 通道）；实现方负责超时。 */
	run: (input: { hostId: string; remoteCommand: string }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
	now?: () => number;
};

export type RemoteModelCatalogResult = { ok: true; models: AvailableModel[]; cached: boolean } | { ok: false; code: string };

export type RemoteModelCatalog = {
	/** 读目录；force 绕过缓存（手动刷新）。任何失败都不写缓存。 */
	load: (input: { hostId: string; force?: boolean }) => Promise<RemoteModelCatalogResult>;
	/** 丢弃一台主机的缓存（远端 models.json 被改写后调用，否则要等 TTL 过期才看到新模型）。 */
	invalidate: (hostId: string) => void;
};

/** `pi` 对未知旗标的抱怨可能出现在 stdout 或 stderr（不同版本不同）。 */
function looksLikeUnknownOption(result: { stdout: string; stderr?: string }): boolean {
	return isUnknownCliOption(`${result.stdout}\n${result.stderr ?? ""}`);
}

export function createRemoteModelCatalog(deps: RemoteModelCatalogDeps): RemoteModelCatalog {
	const now = deps.now ?? Date.now;
	const cache = new Map<string, { at: number; epoch: number; models: AvailableModel[] }>();
	/**
	 * 缓存代次：`invalidate` 递增。在途查询只在代次没变时写缓存——否则「保存远端 models.json 期间
	 * 正好有一次拉取在飞」的窗口里，旧目录会在 invalidate 之后重新落回来（本机侧同一坑的修法）。
	 */
	let epoch = 0;
	/**
	 * 同一主机 + 同一档位意图的在途查询共用一条 SSH（分屏两栏同时打开选择器时不要各起一条）。
	 * **key 必须带 force**：手动刷新要的是带扩展的全量目录，把它合并进普通查询会静默降级成
	 * `--no-extensions` 的结果，并且那份结果还会进缓存，5 分钟内都看不到扩展贡献的模型。
	 */
	const inflight = new Map<string, Promise<RemoteModelCatalogResult>>();

	const loadUncached = async (hostId: string, force: boolean, startedAtEpoch: number): Promise<RemoteModelCatalogResult> => {
		let facts: { piPath: string; nodePath: string };
		try {
			facts = await deps.resolveFacts(hostId);
		} catch {
			return { ok: false, code: REMOTE_MODEL_CATALOG_CODES.failed };
		}

		// 档位与本机同构：手动刷新（force）走「带扩展」全量档——扩展可以 registerProvider 贡献模型
		// （issue #181）；默认走快速档（不为一次列表加载用户全部扩展）。每档失败都降一档，
		// 老版本 pi 不认新旗标时最终落到 compat。
		const modes: RemotePiListModelsMode[] = force ? ["full", "fast", "compat"] : ["fast", "compat"];
		let lastWasEmpty = false;
		for (const mode of modes) {
			let result: { exitCode: number; stdout: string; stderr?: string };
			try {
				result = await deps.run({ hostId, remoteCommand: buildRemotePiListModelsCommand(facts.piPath, facts.nodePath, mode) });
			} catch {
				return { ok: false, code: REMOTE_MODEL_CATALOG_CODES.failed };
			}
			// 先解析、再判失败：退出 0 且能解析出模型就是有效答案，哪怕 stdout 里混着别的噪音
			// （扩展横幅、provider 名里本来就带 "unknown option" 这种词）。反过来先判噪音会丢掉好结果。
			const models = parsePiListModels(result.stdout);
			if (result.exitCode === 0 && models.length > 0) {
				// 代次变过 ⇒ 这次结果属于「invalidate 之前的世界」，不写缓存，但仍然是有效答案。
				if (epoch === startedAtEpoch) cache.set(hostId, { at: now(), epoch, models });
				return { ok: true, models, cached: false };
			}
			// 空表可能是「快速档没加载扩展」的假空：记下来继续降档，只有所有档位都空才报 empty。
			lastWasEmpty = result.exitCode === 0 && models.length === 0;
			if (result.exitCode !== 0 && !looksLikeUnknownOption(result)) return { ok: false, code: REMOTE_MODEL_CATALOG_CODES.failed };
		}
		return { ok: false, code: lastWasEmpty ? REMOTE_MODEL_CATALOG_CODES.empty : REMOTE_MODEL_CATALOG_CODES.failed };
	};

	const load = async (input: { hostId: string; force?: boolean }): Promise<RemoteModelCatalogResult> => {
		const force = input.force === true;
		if (!force) {
			const hit = cache.get(input.hostId);
			if (hit !== undefined && now() - hit.at < REMOTE_MODEL_CATALOG_TTL_MS) return { ok: true, models: hit.models, cached: true };
		}
		const key = `${input.hostId}\u0000${force ? "force" : "default"}\u0000${epoch}`;
		const pending = inflight.get(key);
		if (pending !== undefined) return pending;
		// 代次必须在**发起查询时**捕获：放在 resolveFacts 之后会让「查询途中被 invalidate」这件事
		// 看不见（那时读到的是新代次，旧结果照样写进缓存）。
		const started = loadUncached(input.hostId, force, epoch).finally(() => {
			inflight.delete(key);
		});
		inflight.set(key, started);
		return started;
	};

	return {
		load,
		invalidate: (hostId: string) => {
			// 代次递增而不是只删键：在途查询回来时不会把过期结果重新写进缓存。
			epoch += 1;
			cache.delete(hostId);
		},
	};
}
