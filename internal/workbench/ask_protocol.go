//go:build !js && !android && !ios

package workbench

// The ask protocol: the batch envelope a pi extension sends through
// ctx.ui.input, the question shapes inside it, and the answer envelope it
// gets back. The extension (extensions/pi-deck-ask-question.ts) asks one
// question or many in one call, so the window has one card shape: a list
// of questions, each answered by its type.

import (
	"encoding/json"
	"fmt"
	"strings"
)

// askOption is one choice: what it shows, what it answers with, and the
// line under it.
type askOption struct {
	Label       string `json:"label"`
	Value       string `json:"value"`
	Description string `json:"description"`
}

// UnmarshalJSON takes an option written as a string or as an object, as
// models write both.
func (o *askOption) UnmarshalJSON(data []byte) error {
	var s string
	if json.Unmarshal(data, &s) == nil {
		o.Label, o.Value = s, s
		return nil
	}
	var raw struct {
		Label       string `json:"label"`
		Value       string `json:"value"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	o.Label, o.Value, o.Description = raw.Label, raw.Value, raw.Description
	if o.Value == "" {
		o.Value = o.Label
	}
	return nil
}

// askQuestion is one question of an ask.
type askQuestion struct {
	ID          string      `json:"id"`
	Type        string      `json:"type"`
	Question    string      `json:"question"`
	Options     []askOption `json:"options"`
	AllowOther  bool        `json:"allowOther"`
	Placeholder string      `json:"placeholder"`
	Prefill     string      `json:"prefill"`
}

// The question types the card knows.
const (
	askSelect      = "select"
	askMultiSelect = "multi_select"
	askConfirm     = "confirm"
	askInput       = "input"
	askEditor      = "editor"
)

// askEnvelopeMarker is the placeholder pi carries for a batch envelope,
// so the window can tell it from a plain input request without parsing.
const askEnvelopeMarker = "__piDeckBatchAsk__"

// batchAskEnvelope is what the extension puts in the request's title.
type batchAskEnvelope struct {
	Marker    int           `json:"__piDeckBatchAsk"`
	Review    bool          `json:"review"`
	Questions []askQuestion `json:"questions"`
}

// parseBatchAsk reads the extension's envelope out of a title. Titles that
// are not an envelope are plain input questions.
func parseBatchAsk(title string) (*batchAskEnvelope, bool) {
	raw := strings.TrimSpace(title)
	if !strings.HasPrefix(raw, "{") {
		return nil, false
	}
	var env batchAskEnvelope
	if json.Unmarshal([]byte(raw), &env) != nil {
		return nil, false
	}
	if env.Marker != 1 {
		return nil, false
	}
	env.Questions = normalizeAskQuestions(env.Questions)
	if len(env.Questions) == 0 {
		return nil, false
	}
	return &env, true
}

// normalizeAskQuestions fills in what models leave out: ids by position,
// a type from the shape, and the custom row on every select.
func normalizeAskQuestions(in []askQuestion) []askQuestion {
	out := make([]askQuestion, 0, len(in))
	for i, q := range in {
		q.Question = strings.TrimSpace(q.Question)
		if q.Question == "" {
			continue
		}
		if strings.TrimSpace(q.ID) == "" {
			q.ID = fmt.Sprintf("q%d", i+1)
		}
		q.Type = normalizeAskType(q)
		if q.Type == askSelect || q.Type == askMultiSelect {
			if len(q.Options) == 0 {
				// Nothing to pick: ask for text instead of showing an
				// empty list.
				q.Type = askInput
			} else {
				q.AllowOther = q.Type == askSelect
			}
		}
		out = append(out, q)
	}
	return out
}

// normalizeAskType resolves an omitted or odd type from the question's
// shape, as the extension does.
func normalizeAskType(q askQuestion) string {
	switch strings.ToLower(strings.TrimSpace(q.Type)) {
	case askSelect, askMultiSelect, askConfirm, askInput, askEditor:
		return strings.ToLower(strings.TrimSpace(q.Type))
	}
	if len(q.Options) > 0 {
		return askSelect
	}
	return askInput
}

// splitAskOption reads an option text the extension encoded as
// "label|description" or "label — description".
func splitAskOption(text string) askOption {
	if label, desc, ok := strings.Cut(text, "|"); ok {
		return askOption{Label: strings.TrimSpace(label), Value: strings.TrimSpace(label), Description: strings.TrimSpace(desc)}
	}
	label, desc, ok := strings.Cut(text, " — ")
	if !ok {
		return askOption{Label: text, Value: text}
	}
	return askOption{Label: strings.TrimSpace(label), Value: strings.TrimSpace(label), Description: strings.TrimSpace(desc)}
}

// askOptionsFromStrings turns a plain select's options into choices and
// reports the custom row the extension marks with ✎.
func askOptionsFromStrings(list []string) (choices []askOption, allowOther bool) {
	for _, text := range list {
		if strings.HasPrefix(strings.TrimSpace(text), "✎") {
			allowOther = true
			continue
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		choices = append(choices, splitAskOption(text))
	}
	return choices, allowOther
}

// askAnswer is one question's answer while the card is open.
type askAnswer struct {
	// Value is what the model receives: a string, a bool, or []string for
	// multi_select; nil when skipped.
	Value     any    `json:"value"`
	Label     string `json:"label"`
	WasCustom bool   `json:"wasCustom,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
}

// answered reports whether the answer counts: a skipped question counts,
// an empty one does not.
func (a askAnswer) answered() bool {
	if a.Skipped {
		return true
	}
	switch v := a.Value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(v) != ""
	case []string:
		return len(v) > 0
	default:
		return true
	}
}

// askUIState is the card's own state for the question showing: which tab
// and what was answered. Typed text lives apart, in the session's
// askTexts, so a keystroke does not redraw the card.
type askUIState struct {
	Tab     int
	Review  bool
	Answers map[string]askAnswer
}

// askAnswerWire is one answer as the extension reads it.
type askAnswerWire struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Value     any    `json:"value"`
	Label     string `json:"label"`
	WasCustom bool   `json:"wasCustom,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
}

// askResponseWire is the answer envelope the extension parses out of the
// input response's value.
type askResponseWire struct {
	Cancelled bool            `json:"cancelled,omitempty"`
	Answers   []askAnswerWire `json:"answers"`
}
