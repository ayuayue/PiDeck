import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PI_PROXY_INJECTED_ENV, scopeShellCommand, default: loadExtension } = loadTsCommonJs("resources/extensions/pi-deck-shell-proxy.ts");

const originalMarker = process.env[PI_PROXY_INJECTED_ENV];

function restoreMarker() {
	if (originalMarker === undefined) delete process.env[PI_PROXY_INJECTED_ENV];
	else process.env[PI_PROXY_INJECTED_ENV] = originalMarker;
}

test("scopeShellCommand strips PiDeck model-proxy variables before bash execution", () => {
	const command = scopeShellCommand("bash", "env | grep -i proxy");
	assert.match(command, /^unset /);
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", PI_PROXY_INJECTED_ENV]) {
		assert.match(command, new RegExp(`\\b${key}\\b`));
	}
	assert.ok(command.endsWith("\nenv | grep -i proxy"));
});

test("scopeShellCommand uses PowerShell environment syntax for powershell tool calls", () => {
	const command = scopeShellCommand("powershell", "Get-ChildItem Env:");
	assert.match(command, /\$env:HTTP_PROXY\s*=\s*\$null/);
	assert.match(command, /\$env:NODE_USE_ENV_PROXY\s*=\s*\$null/);
	assert.ok(command.endsWith("\nGet-ChildItem Env:"));
});

test("shell-proxy extension only rewrites model shell tools when PiDeck injected proxy env", () => {
	const registrations = [];
	const pi = {
		on(event, handler) {
			registrations.push({ event, handler });
		},
	};

	try {
		delete process.env[PI_PROXY_INJECTED_ENV];
		loadExtension(pi);
		assert.equal(registrations.length, 0, "direct sessions must preserve their inherited shell environment");

		process.env[PI_PROXY_INJECTED_ENV] = "model-only";
		loadExtension(pi);
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0].event, "tool_call");

		const bashInput = { command: "env | grep -i proxy" };
		registrations[0].handler({ toolName: "bash", input: bashInput }, {});
		assert.equal(bashInput.command, scopeShellCommand("bash", "env | grep -i proxy"));

		const powershellInput = { command: "Get-ChildItem Env:" };
		registrations[0].handler({ toolName: "powershell", input: powershellInput }, {});
		assert.equal(powershellInput.command, scopeShellCommand("powershell", "Get-ChildItem Env:"));

		const otherInput = { command: "cat package.json" };
		registrations[0].handler({ toolName: "read", input: otherInput }, {});
		assert.equal(otherInput.command, "cat package.json");
	} finally {
		restoreMarker();
	}
});
