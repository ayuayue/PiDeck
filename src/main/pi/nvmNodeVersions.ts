import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { compareVersions } from "../utils/versionCompare";

const NVM_VERSION_NAME = /^v\d+\.\d+\.\d+$/;
const NVM_VERSION_PREFIX = /^v?(\d+(?:\.\d+){0,2})$/;
const MAX_ALIAS_HOPS = 8;

/**
 * nvm 已安装的 Node 版本目录（`<nvmRoot>/versions/node/<version>`），按「nvm 默认版本 → 其余新到旧」排序。
 *
 * Dock/Finder 启动不加载 shell rc，`nvm use default` 不生效，只能靠扫描目录补 PATH；
 * readdir 的字母序会让 v20 排在 v24 前，`#!/usr/bin/env node` 又取 PATH 中第一个 node，
 * 结果是桌面端用了与终端不同的旧 Node。解析不出默认版本时取最新版；非版本号目录保留在末尾。
 */
export function nvmNodeVersionDirs(nvmRoot: string): string[] {
	const versionsRoot = join(nvmRoot, "versions", "node");
	let names: string[];
	try {
		names = readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const versions = names.filter((name) => NVM_VERSION_NAME.test(name)).sort((left, right) => compareVersions(right, left));
	const others = names.filter((name) => !NVM_VERSION_NAME.test(name)).sort();
	const preferred = resolveNvmDefaultVersion(nvmRoot, versions);
	const ordered = preferred ? [preferred, ...versions.filter((name) => name !== preferred)] : versions;
	return [...ordered, ...others].map((name) => join(versionsRoot, name));
}

/** 按 nvm 的 alias 规则解析 `default`：别名链、`node`/`stable`（最新版）、版本前缀（`22`、`v22.1`）。 */
function resolveNvmDefaultVersion(nvmRoot: string, newestFirst: string[]): string | undefined {
	let value = readNvmAlias(nvmRoot, "default");
	for (let hop = 0; value !== undefined && hop < MAX_ALIAS_HOPS; hop += 1) {
		if (value === "node" || value === "stable") return newestFirst[0];
		const prefix = NVM_VERSION_PREFIX.exec(value)?.[1];
		if (prefix) return newestFirst.find((name) => name.slice(1) === prefix || name.slice(1).startsWith(`${prefix}.`));
		value = readNvmAlias(nvmRoot, value);
	}
	return undefined;
}

function readNvmAlias(nvmRoot: string, name: string): string | undefined {
	if (!name || isAbsolute(name) || name.split(/[\\/]/).includes("..")) return undefined;
	try {
		return readFileSync(join(nvmRoot, "alias", name), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
