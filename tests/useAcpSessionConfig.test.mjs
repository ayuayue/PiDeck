/** ACP config state remains scoped to the active runtime, including delayed IPC responses. */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const options = (id) => [{ id, name: id, type: "select", currentValue: id, options: [{ value: id, name: id }] }];
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness(t) {
	const host = quickMessageHookHost();
	const gets = [];
	const sets = [];
	const sinks = new Set();
	const { useAcpSessionConfig } = loadTsCommonJs("src/renderer/src/hooks/useAcpSessionConfig.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": {
				desktopApi: {
					acp: {
						getSessionConfig(agentId) {
							const request = { agentId, ...deferred() };
							gets.push(request);
							return request.promise;
						},
						setSessionConfig(agentId, optionId, value) {
							const request = { agentId, optionId, value, ...deferred() };
							sets.push(request);
							return request.promise;
						},
						onSessionConfigChanged(sink) {
							sinks.add(sink);
							return () => sinks.delete(sink);
						},
					},
				},
			},
		},
	});
	t.after(() => host.unmount());
	return {
		gets,
		sets,
		render: (agentId = "a", backend = "acp") => host.render(() => useAcpSessionConfig(agentId, backend)),
		emit: (event) => {
			for (const sink of sinks) sink(event);
		},
		unmount: host.unmount,
	};
}

test("switching ACP runtimes hides previous options while the new read is pending or fails", async (t) => {
	const h = harness(t);
	h.render();
	h.gets[0].resolve(options("a-model"));
	await flush();
	assert.equal(h.render().options[0].id, "a-model");
	assert.equal(h.render("b").options, undefined, "first render must not expose A options with a B setter");
	h.gets[1].reject(new Error("B is closing"));
	await flush();
	assert.equal(h.render("b").options, undefined);
});

test("a delayed set result cannot replace another runtime's loaded config", async (t) => {
	const h = harness(t);
	h.render();
	h.gets[0].resolve(options("a-model"));
	await flush();
	const pending = h.render().setOption("a-model", "slow");
	h.render("b");
	h.gets[1].resolve(options("b-model"));
	await flush();
	h.sets[0].resolve(options("a-slow"));
	await pending;
	assert.equal(h.render("b").options[0].id, "b-model");
});

test("config notifications win over an older initial read", async (t) => {
	const h = harness(t);
	h.render();
	h.emit({ agentId: "a", options: options("new-model") });
	h.gets[0].resolve(options("old-model"));
	await flush();
	assert.equal(h.render().options[0].id, "new-model");
});

test("latest selection wins when same-runtime set responses arrive out of order", async (t) => {
	const h = harness(t);
	const first = h.render().setOption("model", "first");
	const second = h.render().setOption("model", "second");
	h.sets[1].resolve(options("second"));
	await second;
	h.sets[0].resolve(options("first"));
	await first;
	assert.equal(h.render().options[0].id, "second");
});

test("leaving ACP hides its selector immediately and an old callback cannot dispatch to it", async (t) => {
	const h = harness(t);
	h.render();
	h.gets[0].resolve(options("a-model"));
	await flush();
	const previous = h.render();
	assert.equal(h.render("a", "pi").options, undefined);
	await previous.setOption("model", "slow");
	assert.equal(h.sets.length, 0);
});

test("unmounted or previous-runtime subscriptions cannot repopulate config state", async (t) => {
	const h = harness(t);
	h.render();
	h.render("b");
	h.emit({ agentId: "a", options: options("a-model") });
	h.gets[0].resolve(options("a-late"));
	h.gets[1].resolve(null);
	await flush();
	assert.equal(h.render("b").options, undefined);
	h.unmount();
	h.emit({ agentId: "b", options: options("b-late") });
	assert.equal(h.render("b").options, undefined);
});
