import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { prepareLabPackage } from "../scripts/windows-upgrade-lab.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

async function writeArchive(file, entries) {
	const staging = `${file}.source`;
	for (const [entryPath, bytes] of Object.entries(entries)) {
		const target = path.join(staging, entryPath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
	await mkdir(path.dirname(file), { recursive: true });
	await asar.createPackage(staging, file);
	await rm(staging, { recursive: true, force: true });
}

test("Windows upgrade lab keeps the production main byte-identical at its original path", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pideck-windows-upgrade-lab-"));
	const source = path.join(root, "source");
	const destination = path.join(root, "destination");
	try {
		await mkdir(path.join(source, "resources"), { recursive: true });
		await writeFile(path.join(source, "PiDeck.exe"), "lab executable");
		const originalMain = Buffer.from('require("./chunk.js");\n');
		const packageJson = Buffer.from(JSON.stringify({ version: "1.2.3", main: "out/main/index.js" }));
		await writeArchive(path.join(source, "resources", "app.asar"), {
			"package.json": packageJson,
			"out/main/index.js": originalMain,
			"out/main/chunk.js": Buffer.from('require("./index.js");\n'),
		});

		const evidence = await prepareLabPackage(source, destination);
		const archive = path.join(destination, "resources", "app.asar");
		const labPackage = JSON.parse(asar.extractFile(archive, "package.json"));
		const mainPath = path.win32.normalize("out/main/index.js");
		const bootstrapPath = path.win32.normalize("out/main/windows-upgrade-lab-bootstrap.cjs");

		assert.equal(labPackage.main, "out/main/windows-upgrade-lab-bootstrap.cjs");
		assert.deepEqual(asar.extractFile(archive, mainPath), originalMain);
		assert.ok(asar.extractFile(archive, bootstrapPath).toString("utf8").trim().endsWith('require("./index.js");'));
		assert.deepEqual(
			asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/")),
			["/out", "/out/main", "/out/main/chunk.js", "/out/main/index.js", "/out/main/windows-upgrade-lab-bootstrap.cjs", "/package.json"],
		);
		assert.equal(evidence.version, "1.2.3");
		assert.equal(evidence.verifiedPayloadFiles, 2);
		assert.deepEqual(evidence.differences, ["package.json main", "out/main/windows-upgrade-lab-bootstrap.cjs"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows upgrade lab refuses nested output directories", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pideck-windows-upgrade-lab-"));
	const source = path.join(root, "source");
	try {
		await mkdir(source, { recursive: true });
		await assert.rejects(() => prepareLabPackage(source, path.join(source, "nested")), /separate new directory/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
