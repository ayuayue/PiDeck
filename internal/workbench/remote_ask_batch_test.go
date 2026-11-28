//go:build !js && !android && !ios

package workbench

// The phone answers a batch ask with the same envelope the desktop card
// sends; these check the conversion, including what it refuses.

import (
	"encoding/json"
	"testing"

	"example.com/pideck/internal/remotewire"
)

func batchAskFixture() *extensionAsk {
	return &extensionAsk{ID: "ask-1", Method: remotewire.AskMethodBatch, Review: true,
		Questions: []askQuestion{
			{ID: "q1", Type: askSelect, Question: "用哪个方案？", Options: []askOption{
				{Label: "方案甲", Value: "a"}, {Label: "方案乙", Value: "b", Description: "更快"}}},
			{ID: "q2", Type: askMultiSelect, Question: "带上哪些检查？", Options: []askOption{
				{Label: "单元测试", Value: "unit"}, {Label: "构建", Value: "build"}}},
			{ID: "q3", Type: askConfirm, Question: "现在改吗？"},
			{ID: "q4", Type: askInput, Question: "备注", Placeholder: "写一句"},
		}}
}

func TestAskAnswersFromWire(t *testing.T) {
	ask := batchAskFixture()
	answers := []remotewire.AskAnswer{
		{ID: "q1", Type: askSelect, Value: "b"},
		{ID: "q2", Type: askMultiSelect, Value: []any{"unit", "build"}},
		{ID: "q3", Type: askConfirm, Value: true},
		{ID: "q4", Type: askInput, Value: " 按乙方案 "},
	}
	wire, err := askAnswersFromWire(ask, answers, false)
	if err != nil {
		t.Fatalf("conversion failed: %v", err)
	}
	if wire.Cancelled || len(wire.Answers) != 4 {
		t.Fatalf("wire = %+v", wire)
	}
	if wire.Answers[0].Value != "b" || wire.Answers[0].Label != "方案乙" {
		t.Fatalf("select answer = %+v", wire.Answers[0])
	}
	if values, ok := wire.Answers[1].Value.([]string); !ok || len(values) != 2 || values[0] != "unit" {
		t.Fatalf("multi_select answer = %+v", wire.Answers[1])
	}
	if yes, ok := wire.Answers[2].Value.(bool); !ok || !yes || wire.Answers[2].Label != "是" {
		t.Fatalf("confirm answer = %+v", wire.Answers[2])
	}
	if wire.Answers[3].Value != "按乙方案" {
		t.Fatalf("input answer = %+v", wire.Answers[3])
	}
	// The extension reads it back as its own envelope.
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var back askResponseWire
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("the extension cannot read %s: %v", data, err)
	}
	if len(back.Answers) != 4 {
		t.Fatalf("round trip = %+v", back)
	}
}

func TestAskAnswersFromWireSkipsAndRefuses(t *testing.T) {
	ask := batchAskFixture()
	// A question left out is refused: the model must not get a half answer.
	if _, err := askAnswersFromWire(ask, []remotewire.AskAnswer{{ID: "q1", Value: "a"}}, false); err == nil {
		t.Fatal("a missing question was accepted")
	}
	// A choice the question never offered is refused.
	bad := []remotewire.AskAnswer{
		{ID: "q1", Value: "c"}, {ID: "q2", Value: []string{"unit"}},
		{ID: "q3", Value: true}, {ID: "q4", Value: "x"},
	}
	if _, err := askAnswersFromWire(ask, bad, false); err == nil {
		t.Fatal("an invented option was accepted")
	}
	// A skipped question settles it without a value.
	skipped := []remotewire.AskAnswer{
		{ID: "q1", Skipped: true}, {ID: "q2", Value: []string{"build"}},
		{ID: "q3", Value: false}, {ID: "q4", Value: "记一句"},
	}
	wire, err := askAnswersFromWire(ask, skipped, false)
	if err != nil {
		t.Fatalf("skipped conversion failed: %v", err)
	}
	if !wire.Answers[0].Skipped || wire.Answers[0].Value != nil {
		t.Fatalf("skipped answer = %+v", wire.Answers[0])
	}
	// Cancelling keeps what was answered, as the desktop's close does.
	cancelled, err := askAnswersFromWire(ask, skipped, true)
	if err != nil || !cancelled.Cancelled {
		t.Fatalf("cancelled = %+v, %v", cancelled, err)
	}
}
