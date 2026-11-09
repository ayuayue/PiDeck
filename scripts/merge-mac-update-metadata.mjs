#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";

/** Merge independently built macOS feeds before one publisher uploads the shared channel file. */
export function mergeMacUpdateInfo(documents, expectedVersion) {
	if (!documents.length) throw new Error("No macOS update metadata found");
	const files = new Map();
	let brand = null;
	for (const document of documents) {
		if (!document || document.version !== expectedVersion || !Array.isArray(document.files)) throw new Error("macOS update metadata version/files do not match the release");
		for (const file of document.files) {
			const name = typeof file?.url === "string" ? file.url : "";
			const prefix = name.startsWith("PiDeck-Dev-") ? "PiDeck-Dev" : "PiDeck";
			const suffix = name.slice(`${prefix}-${expectedVersion}-`.length);
			if (!name.startsWith(`${prefix}-${expectedVersion}-`) || !/^(arm64|x64)\.(zip|dmg)$/.test(suffix)) throw new Error(`Unexpected macOS update asset: ${name}`);
			if (brand !== null && brand !== prefix) throw new Error("Cannot mix stable and dev application identities in one update feed");
			brand = prefix;
			if (typeof file.sha512 !== "string" || Buffer.from(file.sha512, "base64").length !== 64 || Buffer.from(file.sha512, "base64").toString("base64") !== file.sha512 || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`Invalid digest or size for ${name}`);
			if (files.has(name)) throw new Error(`Duplicate macOS update asset: ${name}`);
			files.set(name, file);
		}
	}
	const zip = (arch) => files.get(`${brand}-${expectedVersion}-${arch}.zip`);
	if (!zip("arm64") || !zip("x64")) throw new Error("macOS update metadata must contain both arm64 and x64 ZIPs");
	// Modern updaters select from files; keep the legacy fallback Intel-compatible.
	const fallback = zip("x64");
	return { ...documents[0], version: expectedVersion, files: [...files.values()].sort((left, right) => left.url.localeCompare(right.url)), path: fallback.url, sha512: fallback.sha512 };
}

/** Read per-architecture workflow artifacts and write one complete file per update channel. */
export async function mergeMacUpdateMetadata({ inputDir, outputDir, version }) {
	const groups = new Map();
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && /^[a-z][a-z0-9-]*-mac\.yml$/.test(entry.name)) {
				const group = groups.get(entry.name) ?? [];
				group.push(load(await readFile(path, "utf8")));
				groups.set(entry.name, group);
			}
		}
	}
	await walk(inputDir);
	if (!groups.size) throw new Error("No macOS channel files found in workflow artifacts");
	// Validate every channel before writing any output: an incomplete beta feed cannot be published.
	const merged = [...groups].map(([name, documents]) => [name, mergeMacUpdateInfo(documents, version)]);
	await mkdir(outputDir, { recursive: true });
	for (const [name, document] of merged) await writeFile(join(outputDir, name), dump(document, { lineWidth: -1 }), "utf8");
	return merged.map(([name]) => name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = {};
		for (let index = 2; index < process.argv.length; index += 2) {
			const key = { "--input-dir": "inputDir", "--output-dir": "outputDir", "--version": "version" }[process.argv[index]];
			const value = process.argv[index + 1];
			if (!key || !value || value.startsWith("--")) throw new Error("Usage: merge-mac-update-metadata.mjs --input-dir <path> --output-dir <path> --version <version>");
			options[key] = value;
		}
		if (!options.inputDir || !options.outputDir || !options.version) throw new Error("input-dir, output-dir and version are required");
		const names = await mergeMacUpdateMetadata(options);
		console.log(`Merged macOS update metadata: ${names.join(", ")}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
