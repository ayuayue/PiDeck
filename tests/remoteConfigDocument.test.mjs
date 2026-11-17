import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_CONFIG_SOURCE } = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const createScope = new Function(REMOTE_CONFIG_SOURCE.replace("export function createConfigScope", "function createConfigScope") + "\nreturn createConfigScope;")();

/** Run the deployed config artifact against a real isolated directory, including on Windows. */
function fixture(t, data) {
	const directory = fs.mkdtempSync(path.join(tmpdir(), "pideck-config-document-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const home = "/pideck-config-document";
	const resolve = (value) => (typeof value === "string" && value.startsWith(home) ? directory + value.slice(home.length) : value);
	const mappedFs = new Proxy(fs, {
		get(target, key) {
			const value = target[key];
			if (key === "lstatSync") return (targetPath) => fs.lstatSync(resolve(targetPath), { bigint: true });
			return typeof value === "function" ? (...args) => value(...args.map(resolve)) : value;
		},
	});
	fs.mkdirSync(path.join(directory, ".pi/agent"), { recursive: true });
	const file = path.join(directory, ".pi/agent/models.json");
	fs.writeFileSync(file, JSON.stringify(data));
	return { scope: createScope(home, mappedFs, path.posix, crypto), data: () => JSON.parse(fs.readFileSync(file, "utf8")), file };
}

test("document replacement preserves hidden provider and reordered model credentials, supports null and deletion", (t) => {
	const f = fixture(t, {
		providers: {
			p: {
				apiKey: "provider-secret",
				models: [
					{ id: "a", apiKey: "model-a" },
					{ id: "b", apiKey: "model-b" },
				],
			},
		},
		remove: true,
		unknown: { nested: true },
	});
	const snapshot = f.scope.read({ file: "models" });
	const data = structuredClone(snapshot.data);
	data.providers.p.models.reverse();
	data.providers.p.models[0].contextWindow = 9000;
	data.explicitNull = null;
	delete data.remove;
	const result = f.scope.replace({ file: "models", expectedVersion: snapshot.version, data, secretSources: [] });
	assert.equal(result.data.providers.p.apiKey, "configured");
	assert.deepEqual(
		f.data().providers.p.models.map((model) => [model.id, model.apiKey]),
		[
			["b", "model-b"],
			["a", "model-a"],
		],
	);
	assert.equal(f.data().providers.p.apiKey, "provider-secret");
	assert.equal(f.data().explicitNull, null);
	assert.equal(Object.hasOwn(f.data(), "remove"), false);
	assert.deepEqual(f.data().unknown, { nested: true });
	assert.equal(JSON.stringify(result).includes("provider-secret"), false);
});

test("renaming and copying provider settings retains credentials within the same versioned file", (t) => {
	const f = fixture(t, { providers: { p: { apiKey: "provider-secret", headers: { Authorization: "Bearer secret" }, models: [{ id: "a", apiKey: "model-a" }] } } });
	const snapshot = f.scope.read({ file: "models" });
	const copied = structuredClone(snapshot.data.providers.p);
	f.scope.replace({
		file: "models",
		expectedVersion: snapshot.version,
		data: { providers: { renamed: copied, copy: structuredClone(copied) } },
		secretSources: [
			{ from: ["providers", "p"], to: ["providers", "renamed"] },
			{ from: ["providers", "p"], to: ["providers", "copy"] },
		],
	});
	assert.deepEqual(f.data().providers.renamed, f.data().providers.copy);
	assert.equal(f.data().providers.renamed.headers.Authorization, "Bearer secret");
	assert.equal(f.data().providers.copy.models[0].apiKey, "model-a");
	assert.equal(Object.hasOwn(f.data().providers, "p"), false);
});

test("unresolvable placeholders, stale versions, reserved paths and auth writes never change disk", (t) => {
	const original = { providers: { p: { apiKey: "secret", models: [] } } };
	const f = fixture(t, original);
	const snapshot = f.scope.read({ file: "models" });
	for (const input of [
		{ data: { providers: { copied: snapshot.data.providers.p } }, secretSources: [] },
		{ data: snapshot.data, secretSources: [{ from: ["__proto__"], to: ["providers", "p"] }] },
		{ data: snapshot.data, secretSources: [], expectedVersion: "0".repeat(64) },
		{ data: {}, secretSources: [], file: "auth" },
	]) {
		assert.throws(() => f.scope.replace({ file: "models", expectedVersion: snapshot.version, ...input }), /CONFIG_/);
		assert.deepEqual(f.data(), original);
	}
});
