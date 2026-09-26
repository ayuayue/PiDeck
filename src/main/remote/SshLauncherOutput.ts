import { StringDecoder } from "node:string_decoder";

/**
 * Bounded output accumulator of one launched pinned process (plan §10).
 *
 * This module owns everything between a raw stream chunk and one decoded line: the incremental UTF-8
 * decode (a multi-byte character may be split across chunks, so a per-chunk `toString()` would corrupt
 * the frame it belongs to), the split into lines, the per-line and per-stream byte bounds, the small
 * holding area for lines that arrive before the first subscriber, and the "unconsumed bytes" gauge that
 * decides when the owner has to stop the process. One instance serves both streams of one process; the
 * launcher keeps no stream state of its own.
 *
 * What it does not do: it never spawns, signals, kills or reports an exit, it owns no timer, and it does
 * not judge frames. An overflow is reported through `onOverflow` - exactly once, and only while the
 * accumulator is still open - and the owner decides what that means (the launcher force-kills the process
 * and reports its own stable exit code). A decoded line is handed over verbatim; blank lines are dropped
 * here so no consumer has to ask whether a line is meaningful.
 */

export type SshLauncherStreamName = "stdout" | "stderr";

/**
 * Why the accumulator gave up on the stream. The owner maps these to its own stable codes; the
 * accumulator itself has no error vocabulary, so a cause can never be confused with an exit reason.
 */
export type SshLauncherOutputOverflow = "output-too-large" | "line-too-large";

export type SshLauncherOutputOptions = {
	/** Ceiling for the *unconsumed* bytes of each stream, measured separately. */
	maxOutputBytes: number;
	/** Longest single line a stream may accumulate without a newline. */
	maxLineBytes: number;
	/** Called at most once, when a line or the unconsumed gauge exceeds its bound. */
	onOverflow(cause: SshLauncherOutputOverflow): void;
};

export type SshLauncherOutput = {
	/** Decode, meter and deliver one raw stream chunk. Ignored once `flush()` ran. */
	feed(name: SshLauncherStreamName, chunk: unknown): void;
	/** Flush both decoders and any partial final line, so a dying process still reports what it wrote. */
	flush(): void;
	/** Subscribe to complete non-blank lines; the first subscriber also replays the holding area. */
	subscribe(name: SshLauncherStreamName, listener: (line: string) => void): () => void;
	/** Subscribers currently attached to one stream. */
	subscriberCount(name: SshLauncherStreamName): number;
};

const STREAM_NAMES: readonly SshLauncherStreamName[] = ["stdout", "stderr"];
/** Lines held for a caller that has not subscribed yet; a helper may answer before we attach. */
const MAX_BACKLOG_LINES = 64;

function byteLengthOf(chunk: unknown): number {
	if (typeof chunk === "string") return Buffer.byteLength(chunk, "utf8");
	if (Buffer.isBuffer(chunk)) return chunk.length;
	if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
	return 0;
}

/** A stream chunk as bytes for the line decoder; an unusable chunk decodes to nothing. */
function bufferOf(chunk: unknown): Buffer {
	if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
	if (Buffer.isBuffer(chunk)) return chunk;
	if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	return Buffer.alloc(0);
}

export function createSshLauncherOutput(options: SshLauncherOutputOptions): SshLauncherOutput {
	const { maxOutputBytes, maxLineBytes } = options;
	// The holding area for frames that arrived before the first subscriber counts against the same
	// unconsumed gauge, so its byte bound may not be wider than either cap it mirrors. One extra byte
	// covers the newline of a maximum-size frame: without it a legal maximal frame could never be
	// held and would be killed as an overflow.
	const maxBacklogBytes = Math.min(maxLineBytes + 1, maxOutputBytes);
	/** Bytes that arrived and were neither handed to a subscriber nor discarded as a blank line. */
	const outputBytes: Record<SshLauncherStreamName, number> = { stdout: 0, stderr: 0 };
	const lineListeners: Record<SshLauncherStreamName, Set<(line: string) => void>> = { stdout: new Set(), stderr: new Set() };
	const lineBacklog: Record<SshLauncherStreamName, Array<{ line: string; bytes: number }>> = { stdout: [], stderr: [] };
	/** Bytes currently held in lineBacklog; they keep counting until a subscriber takes them. */
	const backlogBytes: Record<SshLauncherStreamName, number> = { stdout: 0, stderr: 0 };
	const decoders: Record<SshLauncherStreamName, StringDecoder> = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
	const lineBuffers: Record<SshLauncherStreamName, string> = { stdout: "", stderr: "" };
	/** Set by `flush()`: the owner settled the process, so nothing may be delivered or reported again. */
	let closed = false;
	/** An overflow is a terminal verdict; a second one would only race the owner's own teardown. */
	let overflowReported = false;

	function reportOverflow(cause: SshLauncherOutputOverflow): void {
		if (closed || overflowReported) return;
		overflowReported = true;
		options.onOverflow(cause);
	}

	/** Release bytes that left the unconsumed gauge because a subscriber took them or they were blank. */
	function releaseConsumed(name: SshLauncherStreamName, bytes: number): void {
		if (bytes <= 0) return;
		outputBytes[name] = Math.max(0, outputBytes[name] - bytes);
	}

	/**
	 * Hand one complete line to the subscribers. `footprint` is the number of stream bytes the line
	 * occupied (its text plus the terminating newline): those bytes stop counting against the
	 * unconsumed budget the moment the line is delivered or dropped as blank, while a line held for a
	 * subscriber that has not attached yet keeps counting.
	 */
	function emitLine(name: SshLauncherStreamName, rawLine: string, footprint: number): void {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		// Blank lines carry no frame; dropping them here keeps every downstream parser free of
		// "is this line meaningful" logic.
		if (line.length === 0) {
			releaseConsumed(name, footprint);
			return;
		}
		const subscribers = lineListeners[name];
		if (subscribers.size === 0) {
			holdLine(name, line, footprint);
			return;
		}
		releaseConsumed(name, footprint);
		for (const listener of [...subscribers]) listener(line);
	}

	/**
	 * Hold a line for a caller that has not subscribed yet. The holding area is bounded by line count
	 * and by bytes, and a full area means nobody is consuming the stream: report the same
	 * output-too-large overflow as any other unconsumed overflow instead of growing without bound.
	 */
	function holdLine(name: SshLauncherStreamName, line: string, footprint: number): void {
		if (lineBacklog[name].length >= MAX_BACKLOG_LINES || backlogBytes[name] + footprint > maxBacklogBytes) {
			reportOverflow("output-too-large");
			return;
		}
		lineBacklog[name].push({ line, bytes: footprint });
		backlogBytes[name] += footprint;
	}

	/** Split decoded text into lines, enforcing the per-line cap without ever truncating silently. */
	function consumeText(name: SshLauncherStreamName, text: string): void {
		if (text.length === 0) return;
		lineBuffers[name] += text;
		let index = lineBuffers[name].indexOf("\n");
		while (index !== -1) {
			const rawLine = lineBuffers[name].slice(0, index);
			lineBuffers[name] = lineBuffers[name].slice(index + 1);
			// The terminating newline is one byte and belongs to this line's footprint even though it is
			// not part of the frame text.
			emitLine(name, rawLine, Buffer.byteLength(rawLine, "utf8") + 1);
			// A line that overflowed the bounds already handed the process to the owner.
			if (closed) return;
			index = lineBuffers[name].indexOf("\n");
		}
		if (Buffer.byteLength(lineBuffers[name], "utf8") > maxLineBytes) {
			reportOverflow("line-too-large");
		}
	}

	return {
		feed(name, chunk) {
			if (closed) return;
			const size = byteLengthOf(chunk);
			if (size <= 0) return;
			// Arriving bytes are unconsumed until a complete line is handed to a subscriber (or discarded
			// as blank), so a long-lived stream is not charged for output the caller already consumed.
			outputBytes[name] += size;
			consumeText(name, decoders[name].write(bufferOf(chunk)));
			if (closed) return;
			// Compared after this chunk's complete lines were delivered on purpose: bytes a subscriber has
			// already taken are not unconsumed any more.
			if (outputBytes[name] > maxOutputBytes) {
				// Only byte counts are kept, so the oversized chunk - and everything before it - neither
				// grows the main-process heap nor reaches an error message.
				outputBytes[name] = maxOutputBytes;
				reportOverflow("output-too-large");
			}
		},
		flush() {
			closed = true;
			for (const name of STREAM_NAMES) {
				const tail = decoders[name].end();
				if (tail.length > 0) consumeText(name, tail);
				if (lineBuffers[name].length > 0) {
					const partial = lineBuffers[name];
					lineBuffers[name] = "";
					// A partial line has no newline: its footprint is exactly its own bytes.
					emitLine(name, partial, Buffer.byteLength(partial, "utf8"));
				}
			}
		},
		subscribe(name, listener) {
			// Same code the launcher itself raises for an unusable request: restated rather than imported,
			// because the launcher depends on this module and the caller-visible code may not drift.
			if (typeof listener !== "function") throw new Error("SSH_LAUNCHER_REQUEST_INVALID");
			lineListeners[name].add(listener);
			// Replay what arrived before the first subscriber; later subscribers only see new lines.
			if (lineListeners[name].size === 1) {
				const backlog = lineBacklog[name].splice(0);
				const held = backlogBytes[name];
				backlogBytes[name] = 0;
				// The holding area is consumed by this hand-off, so its bytes leave the unconsumed gauge; the
				// replay itself stays asynchronous to keep subscribing free of re-entrancy.
				releaseConsumed(name, held);
				queueMicrotask(() => {
					for (const entry of backlog) if (lineListeners[name].has(listener)) listener(entry.line);
				});
			}
			return () => {
				lineListeners[name].delete(listener);
			};
		},
		subscriberCount(name) {
			return lineListeners[name].size;
		},
	};
}
