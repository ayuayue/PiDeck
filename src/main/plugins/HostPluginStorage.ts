/** Small plugin-owned JSON stores; keys cannot select host paths or another plugin's namespace. */
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "../utils/fsRetry";
import { isHostPluginId, isPluginRecord } from "./hostPluginManifest";

const MAX_STORE_BYTES = 1024 * 1024;
const MAX_STORE_KEYS = 200;
const VALID_KEY = /^[a-zA-Z0-9_.-]{1,80}$/;
const RESERVED_KEYS = ["__proto__", "prototype", "constructor"];

export class HostPluginStorage {
	private readonly queues = new Map<string, Promise<void>>();
	constructor(private readonly directory: string) {}

	private path(id: string): string {
		if (!isHostPluginId(id)) throw new Error("invalid-plugin-id");
		return join(this.directory, `${id}.json`);
	}

	private async read(id: string): Promise<Record<string, unknown>> {
		let handle;
		try {
			handle = await open(this.path(id), "r");
		} catch (error) {
			if (isPluginRecord(error) && error.code === "ENOENT") return {};
			throw error;
		}
		try {
			const buffer = Buffer.alloc(MAX_STORE_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_STORE_BYTES) throw new Error("storage-too-large");
			const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
			if (!isPluginRecord(value)) throw new Error("invalid-storage");
			return value;
		} finally {
			await handle.close();
		}
	}

	private validateKey(key: string): void {
		if (!VALID_KEY.test(key) || RESERVED_KEYS.includes(key)) throw new Error("invalid-storage-key");
	}

	async get(id: string, key: string): Promise<unknown> {
		this.validateKey(key);
		await this.queues.get(id);
		return (await this.read(id))[key] ?? null;
	}

	/** 只列出白名单形状的键：手写过的存储文件也不能把原型链名字带进插件视野。 */
	async keys(id: string): Promise<string[]> {
		await this.queues.get(id);
		return Object.keys(await this.read(id))
			.filter((key) => VALID_KEY.test(key) && !RESERVED_KEYS.includes(key))
			.sort();
	}

	async remove(id: string, key: string, authorized: () => boolean): Promise<void> {
		this.validateKey(key);
		await this.mutate(id, authorized, (data) => {
			delete data[key];
			return data;
		});
	}

	/** Serial writes share a quota; failed writes never publish a partially updated store. */
	async set(id: string, key: string, value: unknown, authorized: () => boolean): Promise<void> {
		this.validateKey(key);
		await this.mutate(id, authorized, (data) => {
			// 键数上限与体积上限同属配额：只限制字节数会让无数小键把读取代价抬高。
			if (data[key] === undefined && Object.keys(data).length >= MAX_STORE_KEYS) throw new Error("storage-full");
			data[key] = value;
			return data;
		});
	}

	private async mutate(id: string, authorized: () => boolean, update: (data: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
		const pending = (this.queues.get(id) ?? Promise.resolve()).then(async () => {
			const data = update(await this.read(id));
			const serialized = JSON.stringify(data);
			if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("storage-too-large");
			if (!authorized()) throw new Error("plugin-revoked");
			await mkdir(this.directory, { recursive: true });
			const path = this.path(id);
			await writeFile(`${path}.tmp`, serialized, { mode: 0o600 });
			if (!authorized()) throw new Error("plugin-revoked");
			// rename 的退避重试窗口内授权可能已被撤销：每次尝试前都复查，撤销后禁止替换正式文件。
			await renameWithRetry(`${path}.tmp`, path, () => {
				if (!authorized()) throw new Error("plugin-revoked");
			});
		});
		const settled = pending.catch(() => undefined);
		this.queues.set(id, settled);
		try {
			await pending;
		} finally {
			if (this.queues.get(id) === settled) this.queues.delete(id);
		}
	}
}
