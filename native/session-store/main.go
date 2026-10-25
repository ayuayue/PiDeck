package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// 与宿主 src/main/sessions/SessionStoreService.ts 对齐；不匹配即视为协议不通。
const protocolVersion = 1

// 请求帧行上限：请求只带 roots 列表，1MiB 足够。
const maxRequestLineBytes = 1024 * 1024

type requestFrame struct {
	Cmd   string          `json:"cmd"`
	ID    json.RawMessage `json:"id"`
	Roots []string        `json:"roots"`
	// Path 仅 get-index 使用：宿主已 stat 过的会话文件绝对路径。
	Path string `json:"path"`
}

type readyFrame struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SnapshotFiles   int    `json:"snapshotFiles"`
	BootMs          int64  `json:"bootMs"`
}

type responseFrame struct {
	Type   string          `json:"type"`
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result any             `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

var logPrefix = "[session-store] "

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, logPrefix+format+"\n", args...)
}

func main() {
	if len(os.Args) < 2 {
		logf("usage: session-store <statePath> [tablesDir]")
		os.Exit(1)
	}
	bootStartedAt := time.Now()
	store := OpenStore(os.Args[1])
	// tablesDir 可选：给了才落盘条目表（Wave 2b）；缺省退化成纯内存缓存。
	tablesDir := ""
	if len(os.Args) >= 3 {
		tablesDir = os.Args[2]
	}
	tables := newTableCache(tablesDir)

	out := bufio.NewWriter(os.Stdout)
	writeFrame := func(frame any) {
		payload, err := json.Marshal(frame)
		if err != nil {
			logf("encode frame failed: %v", err)
			return
		}
		if _, err := out.Write(append(payload, '\n')); err != nil {
			logf("write frame failed: %v", err)
			return
		}
		if err := out.Flush(); err != nil {
			logf("flush frame failed: %v", err)
		}
	}

	writeFrame(readyFrame{
		Type:            "ready",
		ProtocolVersion: protocolVersion,
		SnapshotFiles:   store.SnapshotSize(),
		BootMs:          time.Since(bootStartedAt).Milliseconds(),
	})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRequestLineBytes)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var request requestFrame
		if err := json.Unmarshal(line, &request); err != nil {
			logf("invalid request line: %v", err)
			continue
		}
		switch request.Cmd {
		case "list-files", "refresh":
			if len(request.Roots) == 0 {
				writeFrame(responseFrame{Type: "response", ID: request.ID, OK: false, Error: "no roots"})
				continue
			}
			stats, err := store.ListFiles(request.Roots)
			if err != nil {
				logf("%s failed: %v", request.Cmd, err)
				writeFrame(responseFrame{Type: "response", ID: request.ID, OK: false, Error: err.Error()})
				continue
			}
			logf("%s %s", request.Cmd, formatStats(stats))
			writeFrame(responseFrame{Type: "response", ID: request.ID, OK: true, Result: stats})
		case "get-index":
			if request.Path == "" {
				writeFrame(responseFrame{Type: "response", ID: request.ID, OK: false, Error: "no path"})
				continue
			}
			startedAt := time.Now()
			index, err := getIndexTable(tables, request.Path)
			if err != nil {
				logf("get-index failed (%s): %v", request.Path, err)
				writeFrame(responseFrame{Type: "response", ID: request.ID, OK: false, Error: err.Error()})
				continue
			}
			hits, misses, evicted := tables.statsSnapshot()
			logf("get-index %s entries=%d oversized=%d endsWithNewline=%t elapsedMs=%d cache(hit=%d miss=%d evict=%d)", request.Path, len(index.Entries), index.OversizedLines, index.EndsWithNewline, time.Since(startedAt).Milliseconds(), hits, misses, evicted)
			writeFrame(responseFrame{Type: "response", ID: request.ID, OK: true, Result: index})
		default:
			writeFrame(responseFrame{Type: "response", ID: request.ID, OK: false, Error: "unknown cmd: " + request.Cmd})
		}
	}
	if err := scanner.Err(); err != nil {
		logf("stdin read failed: %v", err)
	}
}
