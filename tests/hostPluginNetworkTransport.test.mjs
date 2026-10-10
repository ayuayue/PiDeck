/** Exercise the real HTTP-hop implementation with EventEmitter sockets, not a real server/network. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** A fake Node response lets the transport observe headers/chunks/abort exactly as production does. */
function fixture(over = {}, chunks = [Buffer.from('{"value":1}')], end = true) {
	const response = Object.assign(new EventEmitter(), {
		statusCode: 200,
		headers: { "content-type": "application/json", "set-cookie": "private", "x-secret": "private" },
		destroyed: false,
		destroy() {
			this.destroyed = true;
		},
		...over,
	});
	let options;
	let url;
	let body;
	const outgoing = Object.assign(new EventEmitter(), {
		destroyed: false,
		destroy() {
			this.destroyed = true;
		},
		end(value) {
			body = value;
			queueMicrotask(() => {
				onResponse(response);
				for (const chunk of chunks) response.emit("data", chunk);
				if (end) response.emit("end");
			});
		},
	});
	let onResponse;
	const request = (target, input, callback) => {
		url = target;
		options = input;
		onResponse = callback;
		return outgoing;
	};
	const { requestHostPluginHop } = loadTsCommonJs("src/main/plugins/hostPluginNetworkTransport.ts", { stubs: { "node:http": { request }, "node:https": { request } } });
	const controller = new AbortController();
	return {
		response,
		outgoing,
		controller,
		run: () => requestHostPluginHop(new URL("https://api.example.com/v1"), { method: "POST", headers: { authorization: "Bearer plugin-owned-value" }, body: "payload" }, { address: "8.8.8.8", family: 4 }, controller.signal),
		getOptions: () => options,
		getUrl: () => url,
		getBody: () => body,
	};
}

test("real network transport keeps original HTTPS hostname for TLS and pins the validated address", async () => {
	const value = fixture();
	const response = await value.run();
	assert.equal(value.getUrl().hostname, "api.example.com");
	assert.equal(value.getOptions().agent, false);
	assert.equal(value.getOptions().maxHeaderSize, 16 * 1024);
	assert.equal(value.getOptions().headers["accept-encoding"], "identity");
	assert.equal(value.getBody(), "payload");
	value.getOptions().lookup("api.example.com", {}, (error, address, family) => {
		assert.equal(error, null);
		assert.equal(address, "8.8.8.8");
		assert.equal(family, 4);
	});
	value.getOptions().lookup("api.example.com", { all: true }, (error, addresses) => {
		assert.equal(error, null);
		assert.equal(addresses[0].address, "8.8.8.8");
	});
	assert.equal(response.body, '{"value":1}');
	assert.equal(response.headers["content-type"], "application/json");
	assert.equal(response.headers["set-cookie"], undefined);
	assert.equal(response.headers["x-secret"], undefined);
});

test("real network transport enforces response type, charset, compression and byte budgets", async () => {
	for (const [headers, chunks, code] of [
		[{ "content-type": "application/json", "content-length": String(1024 * 1024 + 1) }, [], "network-response-too-large"],
		[{ "content-type": "application/json" }, [Buffer.alloc(700000, "a"), Buffer.alloc(400000, "b")], "network-response-too-large"],
		[{ "content-type": "application/octet-stream" }, [], "network-response-type-denied"],
		[{ "content-type": "application/json; charset=latin1" }, [], "network-response-encoding-denied"],
		[{ "content-type": "application/json", "content-encoding": "gzip" }, [], "network-response-encoding-denied"],
		[{ "content-type": "text/plain" }, [Buffer.from([0xff])], "network-response-encoding-denied"],
	]) {
		const value = fixture({ headers }, chunks);
		await assert.rejects(value.run(), new RegExp(code));
		assert.equal(value.response.destroyed, true, code);
		assert.equal(value.outgoing.destroyed, true, code);
	}
	const empty = await fixture({ statusCode: 204, headers: {} }, []).run();
	assert.equal(empty.body, "");
	const boundary = await fixture({ headers: { "content-type": "text/plain; charset=utf-8" } }, [Buffer.alloc(1024 * 1024, "a")]).run();
	assert.equal(Buffer.byteLength(boundary.body), 1024 * 1024);
});

test("real network transport cancels live sockets and exposes stable errors without diagnostics", async () => {
	for (const mode of ["abort", "error", "headers"]) {
		const value = fixture({}, [], false);
		const pending = value.run();
		await Promise.resolve();
		if (mode === "abort") value.controller.abort();
		else value.outgoing.emit("error", Object.assign(new Error("private URL/token detail"), { code: mode === "headers" ? "HPE_HEADER_OVERFLOW" : "ECONNRESET" }));
		await assert.rejects(pending, new RegExp(mode === "abort" ? "network-cancelled" : mode === "headers" ? "network-headers-too-large" : "network-request-failed"));
		assert.equal(value.outgoing.destroyed, true);
		assert.equal(value.response.destroyed, true);
	}
});

test("real network transport returns redirect headers without buffering the redirect body", async () => {
	const value = fixture({ statusCode: 302, headers: { location: "/next", "set-cookie": "private" } }, [Buffer.alloc(2 * 1024 * 1024)]);
	const response = await value.run();
	assert.equal(response.body, "");
	assert.equal(response.headers.location, "/next");
	assert.equal(response.headers["set-cookie"], undefined);
	assert.equal(value.response.destroyed, true);
});
