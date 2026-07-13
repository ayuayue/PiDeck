import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

async function loadTsModule(filePath, replacements = {}) {
	let source = require("node:fs").readFileSync(filePath, "utf8");
	for (const [from, to] of Object.entries(replacements)) {
		source = source.replace(from, to);
	}
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ES2022,
			target: ts.ScriptTarget.ES2022,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
		},
	}).outputText;
	const out = join(tmpdir(), `pideck-test-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(out, compiled);
	return import(pathToFileURL(out).href);
}

const rpcModule = await loadTsModule("src/main/pi/PiRpcClient.ts");
globalThis.__pideckTestDeps = { PiRpcClient: rpcModule.PiRpcClient };
const piProcessModule = await loadTsModule("src/main/pi/PiProcess.ts", {
	'import { PiRpcClient } from "./PiRpcClient";': "const { PiRpcClient } = globalThis.__pideckTestDeps;",
	'import { PiLocator } from "./PiLocator";': "class PiLocator {}",
	'import type { AppSettings } from "../../shared/types";': "",
	"const AppSettings = undefined;": "",
});

const { PiProcess } = piProcessModule;
const scriptPath = join(tmpdir(), `fake-pi-${Date.now()}.mjs`);
writeFileSync(scriptPath, `
const mode = process.argv[2];
if (mode === '--version') {
  setTimeout(() => { console.log('0.80.6'); }, 1500);
} else if (mode === '--mode') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.trim().split(/\\n+/)) {
      if (!line) continue;
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: req.type, success: true, data: { ok: true } }) + '\\n');
    }
  });
}
`);
chmodSync(scriptPath, 0o755);

class FakeLocator {
	resolveCommand() {
		return process.execPath;
	}
	createInvocation(_command, args) {
		return { command: process.execPath, args: [scriptPath, ...args], shell: false };
	}
	createProcessEnv() {
		return process.env;
	}
}

mkdirSync(join(tmpdir(), "pideck-pi-process-test"), { recursive: true });
const proc = new PiProcess(join(tmpdir(), "pideck-pi-process-test"), {}, new FakeLocator());
const startedAt = performance.now();
const client = proc.start(undefined, "no-approve");
const startElapsed = performance.now() - startedAt;
assert.ok(
	startElapsed < 500,
	`PiProcess.start should not wait for slow pi --version, took ${startElapsed.toFixed(0)}ms`,
);
const response = await client.request({ type: "get_state" }, 2_000);
assert.equal(response.success, true);
proc.stop();
console.log("pi process start tests passed");
