import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PendingConfirmationBroker } = loadTsCommonJs("src/main/security/PendingConfirmationBroker.ts");

function request(stateDigest = "route-key-v1") {
	return { senderId: 7, action: "ssh:fingerprint", subjectId: "host-a", stateDigest, payload: { value: "main-only evidence" } };
}

test("confirmation binds sender, action, subject, digest, and one-time approval", () => {
	const broker = new PendingConfirmationBroker();
	try {
		const issued = broker.begin(request());
		const response = { requestId: issued.requestId, senderId: 7, action: "ssh:fingerprint", subjectId: "host-a", stateDigest: "route-key-v1", choice: "approve" };
		assert.throws(() => broker.answer({ ...response, senderId: 8 }), /CONFIRMATION_INVALID/);
		assert.throws(() => broker.answer({ ...response, action: "project:trust" }), /CONFIRMATION_INVALID/);
		assert.throws(() => broker.answer({ ...response, subjectId: "host-b" }), /CONFIRMATION_INVALID/);
		assert.deepEqual(JSON.parse(JSON.stringify(broker.answer(response))), { value: "main-only evidence" });
		assert.throws(() => broker.answer(response), /CONFIRMATION_INVALID/);
	} finally {
		broker.dispose();
	}
});

test("changed state, denial, and elapsed deadline all require a new request", () => {
	let now = 1000;
	const removed = [];
	const broker = new PendingConfirmationBroker({ ttlMs: 50, now: () => now, onRemoved: (requestId) => removed.push(requestId) });
	const base = { senderId: 7, action: "ssh:fingerprint", subjectId: "host-a", stateDigest: "route-key-v1", choice: "approve" };
	try {
		const changed = broker.begin(request());
		assert.throws(() => broker.answer({ ...base, requestId: changed.requestId, stateDigest: "new-route" }), /CONFIRMATION_CHANGED/);
		assert.throws(() => broker.answer({ ...base, requestId: changed.requestId }), /CONFIRMATION_INVALID/);
		const denied = broker.begin(request());
		assert.equal(broker.answer({ ...base, requestId: denied.requestId, choice: "deny" }), null);
		assert.throws(() => broker.answer({ ...base, requestId: denied.requestId }), /CONFIRMATION_INVALID/);
		const expired = broker.begin(request());
		now += 51;
		assert.throws(() => broker.answer({ ...base, requestId: expired.requestId }), /CONFIRMATION_EXPIRED/);
		assert.deepEqual(removed, [changed.requestId, denied.requestId, expired.requestId]);
	} finally {
		broker.dispose();
	}
});

test("window cleanup and shutdown remove pending requests", () => {
	const broker = new PendingConfirmationBroker();
	const first = broker.begin(request());
	const second = broker.begin({ ...request(), senderId: 8 });
	broker.cancelSender(7);
	assert.throws(() => broker.answer({ requestId: first.requestId, senderId: 7, action: "ssh:fingerprint", subjectId: "host-a", stateDigest: "route-key-v1", choice: "approve" }), /CONFIRMATION_INVALID/);
	broker.dispose();
	assert.throws(() => broker.answer({ requestId: second.requestId, senderId: 8, action: "ssh:fingerprint", subjectId: "host-a", stateDigest: "route-key-v1", choice: "approve" }), /CONFIRMATION_INVALID/);
	assert.throws(() => broker.begin(request()), /CONFIRMATION_CLOSED/);
});
