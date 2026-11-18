#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const bootstrap = await readFile(new URL("./windows-upgrade-lab-bootstrap.cjs", import.meta.url));
export const LAB_ID = "cc.debugtools.pideck.windows-upgrade-lab";

/** Preserve every payload byte and unpacked flag; only package.main and the lab entry differ. */
export async function prepareLabPackage(source, destination) {
	source = path.resolve(source);
	destination = path.resolve(destination);
	if (destination === source || destination.startsWith(`${source}${path.sep}`) || source.startsWith(`${destination}${path.sep}`)) throw new Error("Lab package must be a separate new directory");
	await mkdir(destination, { recursive: false });
	await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
	const original = path.join(source, "resources", "app.asar");
	const target = path.join(destination, "resources", "app.asar");
	const pkg = JSON.parse(asar.extractFile(original, "package.json"));
	if (pkg.main !== "out/main/index.js") throw new Error("Unexpected package entry; refusing to replace it");
	const streams = [];
	const hashes = [];
	const normalize = (name) =>
		name
			.split(path.sep)
			.join("/")
			.replace(/^[\\/]+/, "");
	const archiveFiles = asar
		.listPackage(original)
		.map(normalize)
		.filter((relative) => {
			const info = asar.statFile(original, path.win32.normalize(relative));
			return !info.files && !info.link;
		});
	const unpacked = new Map();
	function visit(entry, prefix = "") {
		for (const [name, child] of Object.entries(entry.files ?? {})) {
			const relative = prefix ? `${prefix}/${name}` : name;
			unpacked.set(relative, Boolean(child.unpacked));
			visit(child, relative);
		}
	}
	visit(asar.getRawHeader(original).header);
	const directories = new Set();
	for (const relativeFile of archiveFiles) {
		const parts = relativeFile.split("/");
		for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
	}
	for (const relative of directories) streams.push({ type: "directory", path: relative, unpacked: unpacked.get(relative) ?? false });
	for (const relativeFile of archiveFiles) {
		const originalPath = normalize(relativeFile);
		const bytes = asar.extractFile(original, path.win32.normalize(originalPath));
		hashes.push({ path: originalPath, sha256: createHash("sha256").update(bytes).digest("hex") });
		let next = bytes;
		if (originalPath === "package.json") next = Buffer.from(JSON.stringify({ ...pkg, main: "out/main/windows-upgrade-lab-bootstrap.cjs" }, null, 2));
		streams.push({ type: "file", path: originalPath, unpacked: unpacked.get(originalPath) ?? false, stat: { size: next.length, mode: 0o100644 }, streamGenerator: () => Readable.from(next) });
	}
	streams.push({ type: "file", path: "out/main/windows-upgrade-lab-bootstrap.cjs", unpacked: false, stat: { size: bootstrap.length, mode: 0o100644 }, streamGenerator: () => Readable.from(bootstrap) });
	await finished(await asar.createPackageFromStreams(target, streams));
	asar.uncache(target);
	for (const record of hashes) {
		if (record.path === "package.json") continue;
		if (
			createHash("sha256")
				.update(asar.extractFile(target, path.win32.normalize(record.path)))
				.digest("hex") !== record.sha256
		)
			throw new Error(`Lab changed production payload: ${record.path}`);
	}
	const evidence = {
		version: pkg.version,
		source,
		destination,
		originalAsarSha256: createHash("sha256")
			.update(await readFile(original))
			.digest("hex"),
		labAsarSha256: createHash("sha256")
			.update(await readFile(target))
			.digest("hex"),
		verifiedPayloadFiles: hashes.length - 1,
		differences: ["package.json main", "out/main/windows-upgrade-lab-bootstrap.cjs"],
		executableBytes: (await stat(path.join(destination, "PiDeck.exe"))).size,
	};
	await writeFile(path.join(destination, "windows-upgrade-package.json"), JSON.stringify(evidence, null, 2));
	return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, destination] = process.argv.slice(2);
	if (!source || !destination) throw new Error("Usage: node scripts/windows-upgrade-lab.mjs <unpacked-source> <new-lab-package>");
	console.log(JSON.stringify(await prepareLabPackage(source, destination), null, 2));
}
