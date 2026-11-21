import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalizeSessionPath } from "../../../shared/sessionIdentity";
import { forkParentCandidates, inferProjectPathFromFile } from "./sessionPathDerivation";

type RestoreHost = {
	wsl: boolean;
	hostPath(file: string): string;
	siblingDir(file: string): string | undefined;
	readReference(file: string): Promise<{ parentSession: string; cwd?: string } | undefined>;
	move(from: string, to: string): Promise<void>;
	forget(from: string, to: string): Promise<void>;
};

type ArchiveEntry = { archived: string; original: string };

/** lstat 也能识别被悬空链接占用的目标；权限或 I/O 错误必须阻止移动。 */
async function statIfPresent(file: string) {
	try {
		return await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** 将归档前的父引用映射到实际携带该文件的索引条目，然后按子先父后排列。 */
async function archivedSubtree(root: ArchiveEntry, index: Record<string, string>, host: RestoreHost): Promise<ArchiveEntry[]> {
	const paths = host.wsl ? path.posix : path;
	const key = (file: string) => canonicalizeSessionPath(file, host.wsl ? "wsl" : "native");
	const archiveDir = key(paths.dirname(root.archived));
	const entries = Object.entries(index)
		.filter(([archived, original]) => typeof original === "string" && key(paths.dirname(archived)) === archiveDir)
		.map(([archived, original]) => ({ archived, original }));
	const owners = new Map<string, ArchiveEntry | undefined>();
	for (const entry of entries) {
		const original = key(entry.original);
		// 同一原路径若曾多次归档，旧索引没有代际信息，不能替子会话猜父记录。
		owners.set(original, owners.has(original) ? undefined : entry);
	}
	async function ownerOf(file: string): Promise<ArchiveEntry | undefined> {
		if (!file.toLowerCase().endsWith(".jsonl")) return undefined;
		if (owners.has(key(file))) return owners.get(key(file));
		// 嵌套父文件随某个 <stem>/ 整体归档，没有自己的索引；在归档副本中核实其存在。
		for (let dir = paths.dirname(file); dir !== paths.dirname(dir); dir = paths.dirname(dir)) {
			const entry = owners.get(key(dir + ".jsonl"));
			const sibling = entry && host.siblingDir(entry.archived);
			if (sibling && (await statIfPresent(host.hostPath(paths.join(sibling, paths.relative(dir, file)))))?.isFile()) return entry;
		}
		return undefined;
	}

	const children = new Map<string, ArchiveEntry[]>();
	for (const entry of entries) {
		if (entry.archived === root.archived) continue;
		const ref = await host.readReference(entry.archived);
		if (!ref) continue;
		for (const candidate of forkParentCandidates(entry.original, ref.parentSession, host.wsl, ref.cwd ?? inferProjectPathFromFile(entry.original))) {
			const owner = await ownerOf(candidate);
			if (!owner) continue;
			const siblings = children.get(owner.archived) ?? [];
			siblings.push(entry);
			children.set(owner.archived, siblings);
			break;
		}
	}
	const ordered: ArchiveEntry[] = [];
	const seen = new Set<string>();
	function visit(entry: ArchiveEntry) {
		if (seen.has(entry.archived)) return;
		seen.add(entry.archived);
		for (const child of children.get(entry.archived) ?? []) visit(child);
		ordered.push(entry);
	}
	visit(root);
	return ordered;
}

/** 先检查整棵树的目标；逐项完成文件、同名目录和索引，以便中断后从父项重试。 */
export async function restoreArchivedSubtree(archived: string, index: Record<string, string>, host: RestoreHost): Promise<string> {
	const original = index[archived];
	if (!original) throw new Error("归档索引中找不到该会话");
	const entries = await archivedSubtree({ archived, original }, index, host);
	const destinations = new Set<string>();
	const plan = [];
	for (const entry of entries) {
		const moves = [entry];
		const sibling = host.siblingDir(entry.archived);
		const originalSibling = host.siblingDir(entry.original);
		if (sibling && originalSibling && (await statIfPresent(host.hostPath(sibling)))?.isDirectory()) {
			moves.unshift({ archived: sibling, original: originalSibling });
		}
		await lstat(host.hostPath(entry.archived));
		for (const move of moves) {
			const key = canonicalizeSessionPath(move.original, host.wsl ? "wsl" : "native");
			if (destinations.has(key) || (await statIfPresent(host.hostPath(move.original)))) throw new Error("原路径已被占用，无法恢复");
			destinations.add(key);
		}
		plan.push({ entry, moves });
	}

	for (const { entry, moves } of plan) {
		const moved: ArchiveEntry[] = [];
		try {
			for (const move of moves) {
				await host.move(move.archived, move.original);
				moved.push(move);
			}
			await host.forget(entry.archived, entry.original);
		} catch (error) {
			for (const move of moved.reverse()) await host.move(move.original, move.archived);
			throw error;
		}
	}
	return original;
}
