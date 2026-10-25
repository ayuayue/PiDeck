import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveRespondingKind } from "../src/renderer/src/components/session/timeline/respondingKind.ts";
import { buildTurnDisplay } from "../src/renderer/src/components/session/timeline/buildTurnDisplay.ts";
import { deriveTimelineRunActivity } from "../src/renderer/src/components/session/timeline/timelineRunActivity.ts";

test("context compaction keeps the runtime busy but closes the preceding model turn", () => {
	const activity = deriveTimelineRunActivity({
		isRuntimeBusy: true,
		isCompacting: true,
	});

	assert.equal(activity.isCompacting, true);
	assert.equal(activity.isTurnRunning, false);
	const displayItems = buildTurnDisplay(
		{
			kind: "agent-run",
			id: "run-1",
			startedAt: 1,
			endedAt: 2,
			items: [
				{
					kind: "message",
					message: {
						id: "assistant-1",
						agentId: "agent-1",
						role: "assistant",
						text: "The completed answer",
						stopReason: "stop",
						timestamp: 2,
					},
				},
			],
		},
		{ isComplete: !activity.isTurnRunning },
	);
	assert.equal(displayItems[0]?.kind, "final-answer");
	assert.equal(
		deriveRespondingKind({
			isCompacting: true,
			isExecutingTool: true,
			liveTextStreaming: true,
		}),
		"compacting",
	);
});

test("timeline uses turn activity for folding while retaining the compression status", () => {
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	const cards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

	assert.match(timeline, /deriveTimelineRunActivity/);
	// 2026-08 perf：接线改身份判定，语义保留——isTurnRunning 参与 isRunStreaming
	// 判定，compaction 阶段（isTurnRunning=false）不把已完成的回答当 live。
	assert.match(timeline, /isRunStreaming = isTurnRunning && item\.id === lastDisplayedItemId/);
	assert.match(timeline, /isRuntimeBusy=\{isRuntimeBusy\}/);
	assert.match(timeline, /isCompacting=\{isCompacting\}/);
	assert.match(cards, /agent\.loading\.compacting/);
	assert.match(turnRow, /isRuntimeBusy\?: boolean/);
	assert.match(turnRow, /!props\.isRuntimeBusy/);
	assert.match(agentManager, /private readonly agentTurnActiveById = new Map<string, boolean>\(\)/);
	assert.match(agentManager, /if \(typed\.type === "agent_start" && runtime\) \{[\s\S]*?setAgentTurnActive\(agentId, true\)/);
	assert.match(agentManager, /if \(typed\.type === "agent_end"\) \{[\s\S]*?setAgentTurnActive\(agentId, false\)/);
});

test("an active model turn remains active outside the compaction phase", () => {
	assert.equal(deriveTimelineRunActivity({ isRuntimeBusy: true, isCompacting: false }).isTurnRunning, true);
	assert.equal(
		deriveTimelineRunActivity({
			isRuntimeBusy: true,
			isCompacting: false,
			isTurnActive: false,
		}).isTurnRunning,
		false,
	);
	assert.equal(deriveTimelineRunActivity({ isRuntimeBusy: false, isCompacting: false }).isTurnRunning, false);
});
