/**
 * PiResourceManagerPool (W1): one manager set per resource target, never one global mutable set.
 *
 * Why a pool instead of `configureWsl` on shared singletons: the four managers hold the target directory in
 * instance state. Reconfiguring a shared instance would make two windows/profiles fight over the same fields
 * (the old global switch). Here the local target always returns the injected singletons (byte-identical to
 * today's behavior), and a WSL target gets fresh instances constructed once from the resolved distribution
 * HOME. Every request re-reads the WSL identity from settings: the cache key embeds distro/user, so changing the
 * development setting or leaving WSL mode evicts the stale instances on the next access (no event wiring needed).
 *
 * The only `configureWsl` call allowed is inside the factory, on a freshly constructed instance; there is no
 * code path that switches an already-shared manager to another environment (guarded by tests + review).
 */

import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { PromptManager } from "../prompts/PromptManager";
import type { SkillManager } from "../skills/SkillManager";
import type { WslEnvironment } from "../wsl/WslPaths";
import { readPiResourceOptions } from "./piResourceTarget";
import type { PiResourceTargetResolver } from "./PiResourceTargetResolver";

export type PiResourceManagerSet = {
	skills: SkillManager;
	prompts: PromptManager;
	extensions: ExtensionManager;
	xuePrompts: XuePromptManager;
};

/**
 * Construction ports. Provided by the assembly layer (main/index.ts) so this module never imports the
 * manager classes as values (node tests can load it without Electron).
 */
export type PiResourceManagerFactories = {
	skills(input: { home: string }): SkillManager;
	prompts(input: { home: string }): PromptManager;
	extensions(input: { home: string; environment: WslEnvironment }): ExtensionManager;
	xuePrompts(input: { home: string; environment: WslEnvironment }): XuePromptManager;
};

export type PiResourceManagerLocalSingletons = {
	skills(): SkillManager;
	prompts(): PromptManager;
	extensions(): ExtensionManager;
	xuePrompts(): XuePromptManager;
};

export type PiResourceManagerPoolPorts = {
	resolver: PiResourceTargetResolver;
	/** Existing process-wide instances, used for the local target only (unchanged behavior). */
	local: PiResourceManagerLocalSingletons;
	create: PiResourceManagerFactories;
	/** Bounded cache: at most this many WSL scopes are kept; the oldest is evicted first. Default 8. */
	maxScopes?: number;
};

export type PiResourceManagerPool = {
	skills(options?: unknown): Promise<SkillManager>;
	prompts(options?: unknown): Promise<PromptManager>;
	extensions(options?: unknown): Promise<ExtensionManager>;
	xuePrompts(options?: unknown): Promise<XuePromptManager>;
	/** Drop every cached scope: called when the WSL identity (settings) or a project's resources change. */
	invalidate(): void;
	/** Number of cached WSL scopes (tests + diagnostics). */
	scopeCount(): number;
};

type CachedScope = {
	cacheKey: string;
	distro: string;
	user: string;
	home: string;
	environment: WslEnvironment;
	managers: Partial<PiResourceManagerSet>;
};

const DEFAULT_MAX_SCOPES = 8;

export function createPiResourceManagerPool(ports: PiResourceManagerPoolPorts): PiResourceManagerPool {
	const maxScopes = Math.max(1, Math.trunc(ports.maxScopes ?? DEFAULT_MAX_SCOPES));
	/** cacheKey -> scope; insertion order is the eviction order (oldest first). */
	const scopes = new Map<string, CachedScope>();

	function evictOverflow(): void {
		while (scopes.size > maxScopes) {
			const oldest = scopes.keys().next().value;
			if (oldest === undefined) return;
			scopes.delete(oldest);
		}
	}

	/**
	 * Resolve the requested target and return its cached scope (null = local).
	 * Re-reads the WSL identity on every call: changed distro/user maps to a new cacheKey and the stale instances
	 * are dropped; an unconfigured environment fails closed and its cache entry disappears.
	 */
	async function scopeFor(options: unknown): Promise<CachedScope | null> {
		const parsed = readPiResourceOptions(options);
		const target = parsed.target;
		if (target === undefined || target.kind === "local") return null;

		const resolution = await ports.resolver.resolve(target);
		if (resolution.kind !== "wsl") return null;

		const existing = scopes.get(resolution.cacheKey);
		if (existing === undefined) {
			scopes.set(resolution.cacheKey, {
				cacheKey: resolution.cacheKey,
				distro: resolution.distro,
				user: resolution.user,
				home: resolution.home,
				environment: resolution.environment,
				managers: {},
			});
			evictOverflow();
		}
		return scopes.get(resolution.cacheKey) ?? null;
	}

	return {
		async skills(options?: unknown): Promise<SkillManager> {
			const scope = await scopeFor(options);
			if (scope === null) return ports.local.skills();
			scope.managers.skills ??= ports.create.skills({ home: scope.home });
			return scope.managers.skills;
		},
		async prompts(options?: unknown): Promise<PromptManager> {
			const scope = await scopeFor(options);
			if (scope === null) return ports.local.prompts();
			scope.managers.prompts ??= ports.create.prompts({ home: scope.home });
			return scope.managers.prompts;
		},
		async extensions(options?: unknown): Promise<ExtensionManager> {
			const scope = await scopeFor(options);
			if (scope === null) return ports.local.extensions();
			scope.managers.extensions ??= ports.create.extensions({ home: scope.home, environment: scope.environment });
			return scope.managers.extensions;
		},
		async xuePrompts(options?: unknown): Promise<XuePromptManager> {
			const scope = await scopeFor(options);
			if (scope === null) return ports.local.xuePrompts();
			scope.managers.xuePrompts ??= ports.create.xuePrompts({ home: scope.home, environment: scope.environment });
			return scope.managers.xuePrompts;
		},
		invalidate(): void {
			scopes.clear();
		},
		scopeCount(): number {
			return scopes.size;
		},
	};
}
