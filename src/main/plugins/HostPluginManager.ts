/** Owns local discovery and exact-code consent, independently from pi extension discovery. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostPluginCatalog, HostPluginInfo } from "../../shared/types/hostPlugin";
import { renameWithRetry } from "../utils/fsRetry";
import { isHostPluginId, isPluginRecord } from "./hostPluginManifest";
import { readHostPluginPackage, type HostPluginPackage } from "./hostPluginFiles";

type Grant = { fingerprint: string; enabled: boolean };

export class HostPluginManager {
	readonly directory: string;
	private readonly statePath: string;
	private packages = new Map<string, HostPluginPackage>();
	private grants = new Map<string, Grant>();
	private issues: HostPluginCatalog["issues"] = [];
	private listeners = new Set<() => void>();
	private writeQueue: Promise<void> = Promise.resolve();
	private revision = 0;

	constructor(
		userData: string,
		private readonly disabled = false,
	) {
		this.directory = join(userData, "host-plugins");
		this.statePath = join(userData, "host-plugin-state.json");
	}

	/** Corrupt consent is never interpreted as trust; plugins remain disabled. */
	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		try {
			const text = await readFile(this.statePath, "utf8");
			if (text.length > 64 * 1024) throw new Error("state-too-large");
			const state: unknown = JSON.parse(text);
			if (isPluginRecord(state) && state.version === 1 && isPluginRecord(state.grants)) {
				for (const [id, grant] of Object.entries(state.grants)) {
					if (isHostPluginId(id) && isPluginRecord(grant) && typeof grant.fingerprint === "string" && /^[a-f0-9]{64}$/.test(grant.fingerprint) && typeof grant.enabled === "boolean") this.grants.set(id, { fingerprint: grant.fingerprint, enabled: grant.enabled });
				}
			}
		} catch {
			/* Missing/invalid state means no grants, never implicit enablement. */
		}
		await this.rescan();
	}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Rebuild atomically; a racing older scan must not replace newer package identities. */
	async rescan(): Promise<HostPluginCatalog> {
		const revision = ++this.revision;
		const packages = new Map<string, HostPluginPackage>();
		const issues: HostPluginCatalog["issues"] = [];
		const entries = await readdir(this.directory, { withFileTypes: true });
		const directories = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
		if (directories.length > 32) issues.push({ directory: "", code: "too-many-plugins" });
		for (const entry of directories.slice(0, 32)) {
			try {
				const plugin = await readHostPluginPackage(join(this.directory, entry.name));
				if (packages.has(plugin.manifest.id)) throw new Error("duplicate-plugin-id");
				packages.set(plugin.manifest.id, plugin);
			} catch (error) {
				issues.push({ directory: entry.name, code: error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "invalid-package" });
			}
		}
		if (revision === this.revision) {
			this.packages = packages;
			this.issues = issues;
			this.notify();
		}
		return this.catalog();
	}

	catalog(): HostPluginCatalog {
		const plugins: HostPluginInfo[] = [...this.packages.values()].map((plugin) => {
			const grant = this.grants.get(plugin.manifest.id);
			return { manifest: plugin.manifest, fingerprint: plugin.fingerprint, enabled: !this.disabled && grant?.enabled === true && grant.fingerprint === plugin.fingerprint, requiresConsent: grant?.fingerprint !== plugin.fingerprint };
		});
		return { directory: this.directory, plugins, issues: this.issues };
	}

	/** Only exact consent from the trusted management UI can authorize the package. */
	async setEnabled(id: string, enabled: boolean, fingerprint: string): Promise<HostPluginCatalog> {
		const plugin = this.packages.get(id);
		if (!plugin || plugin.fingerprint !== fingerprint || (enabled && this.disabled)) throw new Error("plugin-changed");
		const previous = this.grants.get(id);
		this.grants.set(id, { fingerprint, enabled });
		// Disable first: API revocation cannot wait for disk writes to finish.
		this.notify();
		const state = JSON.stringify({ version: 1, grants: Object.fromEntries(this.grants) });
		const persist = this.writeQueue.then(async () => {
			const temporary = `${this.statePath}.tmp`;
			await writeFile(temporary, state, { mode: 0o600 });
			await renameWithRetry(temporary, this.statePath);
		});
		this.writeQueue = persist.catch(() => undefined);
		try {
			await persist;
		} catch (error) {
			// Never restore enablement on failed disable. Failed enable remains revoked.
			this.grants.set(id, { fingerprint: previous?.fingerprint ?? fingerprint, enabled: false });
			this.notify();
			throw error;
		}
		return this.catalog();
	}

	getEnabled(id: string): HostPluginPackage | undefined {
		const plugin = this.packages.get(id);
		const grant = this.grants.get(id);
		return !this.disabled && plugin && grant?.enabled && grant.fingerprint === plugin.fingerprint ? plugin : undefined;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
	/** All active views subscribe here and are released by their owning service. */
	dispose(): void {
		this.listeners.clear();
	}
}
