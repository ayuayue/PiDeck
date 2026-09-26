import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectLocationFromLocator, projectLocatorFromLegacy, projectLocatorToLegacyFields, sessionLocatorFromLegacy, sessionLocatorToLegacyFields } = loadTsCommonJs("src/shared/locationAdapters.ts");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("legacy Windows project paths normalize to native and round-trip locally", () => {
	const locator = projectLocatorFromLegacy({ path: "C:\\work\\app", environment: "windows" });
	assert.deepEqual(plain(locator), { kind: "local", environment: "native", localPath: "C:\\work\\app" });
	assert.deepEqual(plain(projectLocationFromLocator(locator)), { kind: "local", environment: "native" });
	assert.deepEqual(plain(projectLocatorToLegacyFields(locator)), { path: "C:\\work\\app", environment: "windows" });
});

test("legacy WSL projects preserve WSL identity without Windows path normalization", () => {
	const locator = projectLocatorFromLegacy({ path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", environment: "wsl" });
	assert.equal(locator.kind, "local");
	assert.equal(locator.environment, "wsl");
	assert.equal(locator.localPath, "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo");
	assert.deepEqual(plain(projectLocatorToLegacyFields(locator)), {
		path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo",
		environment: "wsl",
	});
});

test("SSH project locations expose host identity but never local path fields", () => {
	const locator = { kind: "ssh", hostId: "host-a", remotePath: "/srv/repo" };
	assert.deepEqual(plain(projectLocationFromLocator(locator)), { kind: "ssh", hostId: "host-a" });
	assert.equal(projectLocatorToLegacyFields(locator), undefined);
});

test("legacy WSL session fields normalize and serialize with their context", () => {
	const locator = sessionLocatorFromLegacy({
		environment: "native",
		filePath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.pi\\sessions\\one.jsonl",
		wsl: true,
		wslDistro: "Ubuntu",
		wslUser: "dev",
	});
	assert.deepEqual(plain(locator), {
		kind: "local",
		environment: "wsl",
		filePath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.pi\\sessions\\one.jsonl",
		wslDistro: "Ubuntu",
		wslUser: "dev",
	});
	assert.deepEqual(plain(sessionLocatorToLegacyFields(locator)), {
		environment: "wsl",
		filePath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\.pi\\sessions\\one.jsonl",
		wslDistro: "Ubuntu",
		wslUser: "dev",
		wsl: true,
	});
});

test("SSH session locators cannot serialize local environment or file authority", () => {
	const locator = { kind: "ssh", hostId: "host-a", remoteSessionId: "session-a", remotePath: "/srv/.pi/sessions/a.jsonl" };
	assert.equal(sessionLocatorToLegacyFields(locator), undefined);
});
