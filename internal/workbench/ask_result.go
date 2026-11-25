//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"

	"example.com/pideck-v2/internal/remotewire"
)

// askToolResult is the extension's existing result projection. The session
// message owns it; no separate answer history is kept by the view.
type askToolResult struct {
	Questions []askQuestion   `json:"questions"`
	Answers   []askAnswerWire `json:"answers"`
}

func askResultFromDetails(name string, raw json.RawMessage) *askToolResult {
	if name != "ask_question" || len(raw) == 0 {
		return nil
	}
	var result askToolResult
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	result.Questions = normalizeAskQuestions(result.Questions)
	if len(result.Questions) == 0 {
		return nil
	}
	return &result
}

func (r askToolResult) answer(q askQuestion) askAnswer {
	for _, in := range r.Answers {
		if in.ID != q.ID {
			continue
		}
		if answer, ok := askAnswerFromWire(q, remotewire.AskAnswer{ID: in.ID, Value: in.Value, Skipped: in.Skipped}); ok {
			return answer
		}
	}
	return askAnswer{}
}
