import { randomUUID } from "node:crypto";

type ConfirmationRequest<T> = {
	senderId: number;
	action: string;
	subjectId: string;
	stateDigest: string;
	payload: T;
};

type ConfirmationAnswer = {
	requestId: string;
	senderId: number;
	action: string;
	subjectId: string;
	stateDigest: string;
	choice: "approve" | "deny";
};

type Pending<T> = ConfirmationRequest<T> & { expiresAt: number; timer: ReturnType<typeof setTimeout> };

/** Main-only, one-shot confirmation state; never accept a candidate payload from a renderer response. */
export class PendingConfirmationBroker<T> {
	private readonly pending = new Map<string, Pending<T>>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly onRemoved: (requestId: string) => void;
	private closed = false;

	constructor(options: { ttlMs?: number; now?: () => number; onRemoved?: (requestId: string) => void } = {}) {
		this.ttlMs = options.ttlMs ?? 60_000;
		this.now = options.now ?? Date.now;
		this.onRemoved = options.onRemoved ?? (() => undefined);
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 300_000) throw new Error("CONFIRMATION_TTL_INVALID");
	}

	begin(request: ConfirmationRequest<T>): { requestId: string; expiresAt: number } {
		if (this.closed) throw new Error("CONFIRMATION_CLOSED");
		if (!Number.isSafeInteger(request.senderId) || request.senderId < 1 || !request.action || !request.subjectId || !request.stateDigest || this.pending.size >= 128) throw new Error("CONFIRMATION_INVALID");
		const requestId = randomUUID();
		const expiresAt = this.now() + this.ttlMs;
		const timer = setTimeout(() => this.remove(requestId), this.ttlMs);
		timer.unref?.();
		this.pending.set(requestId, { ...request, expiresAt, timer });
		return { requestId, expiresAt };
	}

	answer(response: ConfirmationAnswer): T | null {
		const item = this.pending.get(response.requestId);
		if (!item) throw new Error("CONFIRMATION_INVALID");
		if (item.expiresAt <= this.now()) {
			this.remove(response.requestId);
			throw new Error("CONFIRMATION_EXPIRED");
		}
		if (item.senderId !== response.senderId || item.action !== response.action || item.subjectId !== response.subjectId) throw new Error("CONFIRMATION_INVALID");
		this.remove(response.requestId);
		if (item.stateDigest !== response.stateDigest) throw new Error("CONFIRMATION_CHANGED");
		if (response.choice !== "approve" && response.choice !== "deny") throw new Error("CONFIRMATION_INVALID");
		return response.choice === "approve" ? item.payload : null;
	}

	cancel(requestId: string): void {
		this.remove(requestId);
	}

	cancelSender(senderId: number): void {
		for (const [requestId, item] of this.pending) if (item.senderId === senderId) this.remove(requestId);
	}

	dispose(): void {
		this.closed = true;
		for (const requestId of this.pending.keys()) this.remove(requestId);
	}

	private remove(requestId: string): void {
		const item = this.pending.get(requestId);
		if (!item) return;
		clearTimeout(item.timer);
		this.pending.delete(requestId);
		this.onRemoved(requestId);
	}
}
