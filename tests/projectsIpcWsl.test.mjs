import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add resolves the active WSL environment before opening the chooser", () => {
	assert.match(source, /const wslEnvironment = env === "wsl"[\s\S]*resolveWslEnvironment\(settings\.wslDistro, settings\.wslUser\)/);
	assert.match(source, /projectStore\.chooseAndAdd\(env, wslEnvironment\)/);
});
