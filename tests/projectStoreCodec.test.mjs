import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decodeProjectStoreSnapshot, encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");

function project(overrides = {}) {
	return {
		id: "project-1",
		name: "repo",
		path: "C:\\work\\repo",
		lastOpenedAt: 10,
		environment: "windows",
		...overrides,
	};
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("v1 project array reads through the local adapter and marks migration needed", () => {
	const decoded = decodeProjectStoreSnapshot([project(), project({ id: "wsl-1", path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", environment: "wsl" })]);
	assert.equal(decoded.sourceVersion, 1);
	assert.equal(decoded.revision, 0);
	assert.equal(decoded.projects[0].environment, "windows");
	assert.equal(decoded.projects[1].environment, "wsl");
	assert.equal(decoded.projects[1].path, "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo");
});

test("v2 snapshot persists location only in the locator and round-trips through local compatibility", () => {
	const source = [project(), project({ id: "wsl-1", path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", environment: "wsl", wslDistro: "Ubuntu" })];
	const encoded = encodeProjectStoreSnapshot(source, 7);
	assert.equal(encoded.schemaVersion, 2);
	assert.equal(encoded.revision, 7);
	for (const entry of encoded.projects) {
		assert.equal(Object.hasOwn(entry, "path"), false);
		assert.equal(Object.hasOwn(entry, "environment"), false);
		assert.equal(Object.hasOwn(entry, "wslDistro"), false);
	}
	assert.deepEqual(plain(encoded.projects[0].locator), { kind: "local", environment: "native", localPath: "C:\\work\\repo" });
	assert.deepEqual(plain(encoded.projects[1].locator), { kind: "local", environment: "wsl", localPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", wslDistro: "Ubuntu" });
	const decoded = decodeProjectStoreSnapshot(plain(encoded));
	assert.equal(decoded.sourceVersion, 2);
	assert.equal(decoded.revision, 7);
	assert.deepEqual(plain(decoded.projects), plain(source));
});

test("v2 SSH project is rejected instead of fabricating a local path", () => {
	const remote = {
		schemaVersion: 2,
		revision: 3,
		projects: [{ id: "remote-1", name: "repo", lastOpenedAt: 10, locator: { kind: "ssh", hostId: "host-a", remotePath: "/srv/repo" } }],
	};
	assert.throws(() => decodeProjectStoreSnapshot(remote), /PROJECT_STORE_REMOTE_UNSUPPORTED/);
});

test("v2 records reject legacy path fields and malformed locators", () => {
	assert.throws(
		() =>
			decodeProjectStoreSnapshot({
				schemaVersion: 2,
				revision: 1,
				projects: [{ ...project(), locator: { kind: "local", environment: "native", localPath: "C:\\work\\repo" } }],
			}),
		/PROJECT_STORE_INVALID_V2_PROJECT/,
	);
	assert.throws(() => decodeProjectStoreSnapshot({ schemaVersion: 2, revision: 1, projects: [{ id: "p", name: "repo", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "" } }] }), /PROJECT_STORE_INVALID_V2_PROJECT/);
});

test("invalid snapshots and revisions fail closed", () => {
	assert.throws(() => decodeProjectStoreSnapshot({ schemaVersion: 3, revision: 2, projects: [] }), /PROJECT_STORE_INVALID_SNAPSHOT/);
	assert.throws(() => decodeProjectStoreSnapshot([project({ path: "" })]), /PROJECT_STORE_INVALID_PROJECT/);
	assert.throws(() => encodeProjectStoreSnapshot([], 0), /PROJECT_STORE_INVALID_REVISION/);
});
