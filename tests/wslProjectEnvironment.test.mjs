import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";

const { resolveProjectWslIdentity } = loadTsCommonJs("src/main/wsl/WslProjectEnvironment.ts");
const HOST = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

test("project identity wins over the global settings", () => {
	const identity = resolveProjectWslIdentity({ environment: "wsl", wslDistro: "Debian", wslUser: "ops", wslHostId: HOST }, { wslDistro: "Ubuntu", wslUser: "dev" });
	assert.deepEqual({ ...identity }, { distro: "Debian", user: "ops", hostId: HOST });
});

test("legacy projects fall back to the global WSL settings", () => {
	const identity = resolveProjectWslIdentity({ environment: "wsl" }, { wslDistro: "Ubuntu", wslUser: "dev" });
	assert.equal(identity.distro, "Ubuntu");
	assert.equal(identity.user, "dev");
	assert.equal(identity.hostId, undefined);
});

test("non-WSL projects and incomplete identities have no WSL environment", () => {
	assert.equal(resolveProjectWslIdentity({ environment: "windows" }, { wslDistro: "Ubuntu", wslUser: "dev" }), undefined);
	assert.equal(resolveProjectWslIdentity(undefined, { wslDistro: "Ubuntu", wslUser: "dev" }), undefined);
	assert.equal(resolveProjectWslIdentity({ environment: "wsl", wslDistro: "Ubuntu" }, {}), undefined);
});

test("session creation and scanning use the resolver instead of raw settings", () => {
	const source = sessionIpcSource;
	assert.match(source, /const projectWsl = resolveProjectWslIdentity\(project, settings\);/);
	assert.match(source, /mergeScanned\(projectId, summaries, projectWsl !== undefined/);
	assert.match(source, /environment: projectWsl !== undefined \? "wsl" : "native"/);
	assert.match(source, /wslDistro: projectWsl\.distro, wslUser: projectWsl\.user/);
	const catalog = readFileSync("src/main/sessions/SessionCatalog.ts", "utf8");
	assert.match(catalog, /input\.wslDistro \?\? this\.identityContext\.wslDistro/);
});
