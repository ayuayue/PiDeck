//go:build !js && !android && !ios

package workbench

// Checks the usage CSV's sections parse and carry the numbers.

import (
	"encoding/csv"
	"strings"
	"testing"
	"time"
)

func TestUsageCSV(t *testing.T) {
	r := usageReport{
		Since:    time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC),
		Until:    time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
		Sessions: 2, Replies: 5, Files: 3,
		Total:    usageInfo{Input: 100, Output: 50, Total: 150, Cost: 0.12},
		Days:     []usageDay{{Date: "2026-05-31", Total: 150, Cost: 0.12, Replies: 5}},
		Models:   []usageBucket{{Name: "m1", Sub: "acme", Total: 150, Cost: 0.12, Count: 5}},
		Projects: []usageBucket{{Name: "shop", Sub: "/work/shop", Total: 150, Cost: 0.12, Count: 5}},
	}
	text := usageCSV(r)
	reader := csv.NewReader(strings.NewReader(text))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) < 8 {
		t.Fatalf("records = %d:\n%s", len(records), text)
	}
	for _, want := range []string{"PiDeck 用量", "2026-05-31", "m1", "acme", "shop", "/work/shop", "150", "0.1200"} {
		if !strings.Contains(text, want) {
			t.Fatalf("CSV lacks %q:\n%s", want, text)
		}
	}
	if records[0][0] != "PiDeck 用量" || records[0][1] != "2026-05-01 ~ 2026-06-01" {
		t.Fatalf("header = %v", records[0])
	}
}
