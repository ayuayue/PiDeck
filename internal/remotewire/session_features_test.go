package remotewire

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionFeaturesRemainOptional(t *testing.T) {
	var current Transcript
	if err := json.Unmarshal([]byte(`{"id":"s1","title":"Legacy","messages":[{"role":"assistant","text":"Hello"}]}`), &current); err != nil {
		t.Fatal(err)
	}
	if current.Activity != nil || len(current.Messages) != 1 {
		t.Fatalf("legacy transcript changed: %+v", current)
	}
	current.Activity = &SessionActivity{Children: []SessionRef{{ID: "child", Title: "Child", State: "running"}}}
	wire, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	var legacy struct {
		ID       string    `json:"id"`
		Messages []Message `json:"messages"`
	}
	if err := json.Unmarshal(wire, &legacy); err != nil || legacy.ID != "s1" || len(legacy.Messages) != 1 {
		t.Fatalf("additive activity broke the old transcript shape: %+v, %v", legacy, err)
	}
	wire, err = json.Marshal(Session{ID: "s1", Title: "Legacy"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wire), "parentID") {
		t.Fatalf("root session emitted an empty parent link: %s", wire)
	}
}
