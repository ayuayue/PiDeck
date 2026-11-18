//go:build !js && !android && !ios

package sessionimport

// Importing one session file the user picked: pi's own file is copied as it
// is, so the original keeps its identity; another agent's log is converted
// by its source, and the copy lands in this app's store under the folder
// the session ran in.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"example.com/pideck-lite/internal/apptext"
)

// readHeadBytes reads the first bytes of a file, for sniffing its format.
func ReadHead(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	head, _ := io.ReadAll(io.LimitReader(f, n))
	return head
}

// sniffPi says whether a file is a pi session: its first record has the
// session header's shape.
func SniffPi(head []byte) bool {
	sc := bufio.NewScanner(bytes.NewReader(head))
	sc.Buffer(make([]byte, 0, 8<<10), 1<<20)
	for i := 0; i < 4 && sc.Scan(); i++ {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(line, &entry) == nil {
			return entry.Type == "session" && entry.ID != ""
		}
	}
	return false
}

// importDisplayTitle names an imported session in the rail: the tool it came
// from, so a converted session reads as one.
func DisplayTitle(source Source, title string) string {
	if title = importTitle(title); title == "" {
		return source.Label + " · " + apptext.T("未命名会话")
	}
	return source.Label + " · " + title
}

// sourceForFile says which source wrote a file, by sniffing it.
func SourceForFile(path string) (*Source, []byte) {
	head := ReadHead(path, 256<<10)
	if len(head) == 0 {
		return nil, nil
	}
	for _, source := range Sources {
		if source.Sniff == nil || !source.Sniff(head) {
			continue
		}
		return source, head
	}
	return nil, head
}

// noSourceForFile explains a file none of the sources recognize.
func NoSourceForFile(head []byte) error {
	if len(head) == 0 {
		return fmt.Errorf("这个文件是空的")
	}
	return fmt.Errorf("认不出这个会话文件的格式")
}
