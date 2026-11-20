//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"time"
)

type savedTrajectory struct {
	Entry  string `json:"entry"`
	Time   int64  `json:"time"`
	System string `json:"system"`
}

func readTrajectory(file, entry string, started time.Time) ([]string, error) {
	var prompts []string
	seen := map[string]bool{}
	var matchedEntry string
	_, err := readTail(file, 0, func(line []byte) error {
		if len(prompts) >= 8 {
			return nil
		}
		var row struct {
			Type       string          `json:"type"`
			CustomType string          `json:"customType"`
			Data       savedTrajectory `json:"data"`
		}
		if json.Unmarshal(line, &row) != nil || row.Type != "custom" || row.CustomType != "pideck-lite-trajectory" || row.Data.Entry == "" || row.Data.System == "" || len(row.Data.System) > 128<<10 {
			return nil
		}
		if entry != "" && row.Data.Entry != entry {
			return nil
		}
		if entry == "" {
			// A live turn does not have its JSONL entry ID yet. Its user
			// timestamp is emitted by pi when it writes that same entry.
			delta := time.UnixMilli(row.Data.Time).Sub(started)
			if delta < -time.Second || delta > 60*time.Second || (matchedEntry != "" && matchedEntry != row.Data.Entry) {
				return nil
			}
			matchedEntry = row.Data.Entry
		}
		if !seen[row.Data.System] {
			seen[row.Data.System] = true
			prompts = append(prompts, row.Data.System)
		}
		return nil
	})
	return prompts, err
}
