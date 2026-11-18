//go:build !js && !android && !ios

package workbench

// Checks the ACP archive bounds.

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestACPArchiveTurns checks the oldest turns are dropped.
func TestACPArchiveTurns(t *testing.T) {
	arch := acpArchive{ID: "a", Turns: make([]turn, acpArchiveTurns+200)}
	for i := range arch.Turns {
		arch.Turns[i] = turn{ID: "t" + string(rune(i%26)), Prompt: "p"}
	}
	data, err := marshalACPArchive(arch)
	if err != nil {
		t.Fatal(err)
	}
	var got acpArchive
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Turns) != acpArchiveTurns {
		t.Fatalf("turns = %d, want %d", len(got.Turns), acpArchiveTurns)
	}
}

// TestACPArchiveBytes checks an oversized transcript is cut under the cap.
func TestACPArchiveBytes(t *testing.T) {
	huge := strings.Repeat("x", 9<<20)
	arch := acpArchive{ID: "a", Turns: []turn{{ID: "t1", Steps: []turnStep{{Text: huge}}}}}
	data, err := marshalACPArchive(arch)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > acpArchiveBytes {
		t.Fatalf("archive = %d bytes", len(data))
	}
	if !strings.Contains(string(data), "已截断") {
		t.Fatal("the oversized text was not marked as cut")
	}
}

// TestACPArchivePermissions checks remembered permissions survive the file.
func TestACPArchivePermissions(t *testing.T) {
	arch := acpArchive{ID: "a", Permissions: map[string]string{"run": "allow", "write": "reject"}}
	data, err := marshalACPArchive(arch)
	if err != nil {
		t.Fatal(err)
	}
	var got acpArchive
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Permissions["run"] != "allow" || got.Permissions["write"] != "reject" {
		t.Fatalf("permissions = %+v", got.Permissions)
	}
}
