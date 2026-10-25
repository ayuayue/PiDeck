#!/usr/bin/env node

import { access, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ENTRIES = {
	main: "main/index.js",
	preload: "preload/index.js",
	index: "renderer/index.html",
	pet: "renderer/pet.html",
	// Web 服务入口：外部端（浏览器访问 http://host:port）加载的就是它。
	// 产物缺失时 WebServiceManager 会静默回退到 A1 旧内嵌页（功能可用但体验是旧版），
	// 因此必须纳入门禁，防止构建配置变更导致外部端悄悄变回旧页面。
	web: "renderer/web.html",
};

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function walkFiles(root) {
	if (!(await exists(root))) return [];
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function isWithin(candidate, root) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractHtmlResourceReferences(html) {
	const references = [];
	const attribute = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
	for (const match of html.matchAll(attribute)) {
		const value = match[1].trim();
		if (!value || value.startsWith("#") || value.startsWith("data:") || value.startsWith("javascript:")) continue;
		if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) continue;
		references.push(value);
	}
	return references;
}

function resolveRendererReference(rendererRoot, htmlPath, reference) {
	const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
	return clean.startsWith("/") ? resolve(rendererRoot, `.${clean}`) : resolve(htmlPath, "..", clean);
}

async function latestMtime(paths) {
	let latest = 0;
	for (const path of paths) {
		if (!(await exists(path))) continue;
		const info = await stat(path);
		if (info.isFile()) {
			latest = Math.max(latest, info.mtimeMs);
			continue;
		}
		for (const file of await walkFiles(path)) latest = Math.max(latest, (await stat(file)).mtimeMs);
	}
	return latest;
}

export async function verifyBuildArtifacts({ repoRoot = process.cwd(), outDir } = {}) {
	const root = resolve(repoRoot);
	const output = resolve(outDir ?? join(root, "out"));
	const errors = [];
	const checked = [];
	const entryPaths = Object.fromEntries(Object.entries(EXPECTED_ENTRIES).map(([name, path]) => [name, join(output, path)]));

	if (!(await exists(output))) {
		return { ok: false, repoRoot: root, outDir: output, checked, errors: [`Build output directory is missing: ${output}`] };
	}
	for (const [name, path] of Object.entries(entryPaths)) {
		if (!(await exists(path))) errors.push(`Missing ${name} entry: ${path}`);
		else {
			const info = await stat(path);
			if (!info.isFile() || info.size === 0) errors.push(`Empty or invalid ${name} entry: ${path}`);
			else checked.push(path);
		}
	}

	const rendererRoot = join(output, "renderer");
	const resourcePaths = new Set();
	for (const htmlPath of [entryPaths.index, entryPaths.pet, entryPaths.web]) {
		if (!(await exists(htmlPath))) continue;
		const html = await readFile(htmlPath, "utf8");
		for (const reference of extractHtmlResourceReferences(html)) {
			let resourcePath;
			try {
				resourcePath = resolveRendererReference(rendererRoot, htmlPath, reference);
			} catch (error) {
				errors.push(`Malformed HTML resource path: ${reference} (${htmlPath}): ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!isWithin(resourcePath, rendererRoot)) {
				errors.push(`HTML resource escapes renderer output: ${reference} (${htmlPath})`);
				continue;
			}
			try {
				const info = await stat(resourcePath);
				if (!info.isFile() || info.size === 0) {
					errors.push(`Empty or invalid HTML resource: ${reference} (${htmlPath})`);
					continue;
				}
				resourcePaths.add(resourcePath);
				checked.push(resourcePath);
			} catch {
				errors.push(`Missing HTML resource: ${reference} (${htmlPath})`);
			}
		}
	}

	const commonInputs = [join(root, "electron.vite.config.ts"), join(root, "package.json")];
	const freshnessGroups = [
		{ name: "main", inputs: [join(root, "src", "main"), ...commonInputs], artifacts: [entryPaths.main] },
		{ name: "preload", inputs: [join(root, "src", "preload"), ...commonInputs], artifacts: [entryPaths.preload] },
		{
			name: "renderer",
			inputs: [join(root, "src", "renderer"), ...commonInputs],
			artifacts: [entryPaths.index, entryPaths.pet, ...resourcePaths],
		},
	];
	for (const group of freshnessGroups) {
		const inputMtime = await latestMtime(group.inputs);
		if (inputMtime === 0) continue;
		for (const artifact of new Set(group.artifacts)) {
			if (!(await exists(artifact))) continue;
			const artifactMtime = (await stat(artifact)).mtimeMs;
			if (artifactMtime + 1_000 < inputMtime) {
				errors.push(`Stale ${group.name} artifact: ${artifact}`);
			}
		}
	}

	return { ok: errors.length === 0, repoRoot: root, outDir: output, checked: [...new Set(checked)], errors };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--repo-root" || arg === "--out") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--out" ? "outDir" : "repoRoot"] = value;
			index += 1;
		} else if (arg === "--help") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log("Usage: node scripts/verify-build-artifacts.mjs [--repo-root <path>] [--out <path>] [--json]");
		} else {
			const result = await verifyBuildArtifacts(options);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else if (result.ok) console.log(`Build artifacts verified (${result.checked.length} files): ${result.outDir}`);
			else {
				console.error(`Build artifact verification failed (${result.errors.length}):`);
				for (const error of result.errors) console.error(`- ${error}`);
			}
			if (!result.ok) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`Build artifact verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
