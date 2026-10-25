// pideck-file-index：工作区文件索引 sidecar（Go）。
//
// 为什么存在：主进程里的文件搜索（src/main/fs/FileSystemService.ts::searchNames）
// 是实时 BFS——8s 超时、200 条上限、单目录 >5000 项跳过、只匹配文件名本身。
// 大仓库里既慢又常常「搜不到」。本进程把项目根清单常驻内存，名字检索毫秒级；
// 内容检索在索引之上做有界实时扫描（白名单扩展名 + 单文件/全局字节上限）。
//
// 进程模型：由主进程 FileIndexService spawn 常驻。stdin 收 NDJSON 指令，
// stdout 发 NDJSON 响应（stdout 只放协议数据，日志一律走 stderr）。
//
// 启动参数：argv[1..] = 项目根（宿主传入，已剔除 WSL/网络项目）。
//
// 协议（v1）：
//
//	宿主 → 本进程: {"cmd":"refresh","id":N}
//	               {"cmd":"search-name","id":N,"query":"...","limit":200}
//	               {"cmd":"search-content","id":N,"query":"...","limit":50,
//	                "maxFileBytes":1048576,"maxScannedBytes":67108864}
//	本进程 → 宿主: {"type":"ready","protocolVersion":1,"rootCount":N,"fileCount":N,
//	                "dirCount":M,"indexMs":T,"truncated":bool}
//	               {"type":"response","id":N,"ok":true,"result":...}
//	               {"type":"response","id":N,"ok":false,"error":"..."}
//
// 降级语义：本进程任何失败（起不来/协议错/超时/根为空）都不影响主进程——
// 宿主侧文件搜索退化为现有 BFS（fail-open，与 session-index / xue-index 同哲学）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

// ProtocolVersion 与 src/main/files/FileIndexService.ts 的常量保持一致。
const ProtocolVersion = 1

type requestFrame struct {
	Cmd             string          `json:"cmd"`
	ID              json.RawMessage `json:"id"`
	Query           string          `json:"query"`
	Limit           int             `json:"limit"`
	MaxFileBytes    int64           `json:"maxFileBytes"`
	MaxScannedBytes int64           `json:"maxScannedBytes"`
}

type readyFrame struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	RootCount       int    `json:"rootCount"`
	FileCount       int    `json:"fileCount"`
	DirCount        int    `json:"dirCount"`
	IndexMs         int64  `json:"indexMs"`
	Truncated       bool   `json:"truncated"`
}

type responseFrame struct {
	Type   string          `json:"type"`
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error,omitempty"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[file-index] "+format+"\n", args...)
}

func main() {
	if len(os.Args) < 2 {
		logf("usage: file-index <root>...")
		os.Exit(1)
	}
	indexer, err := OpenIndexer(os.Args[1:])
	if err != nil {
		logf("open indexer failed: %v", err)
		os.Exit(1)
	}
	// boot 阶段先建立索引再发 ready：宿主拿到的第一条 ready 就意味着
	// 索引可用（查询入口才好做「就绪直接用、未就绪回退 BFS」的判断）。
	stats := indexer.Index()

	out := bufio.NewWriter(os.Stdout)
	writeFrame := func(frame any) bool {
		encoded, err := json.Marshal(frame)
		if err != nil {
			logf("marshal frame failed: %v", err)
			return false
		}
		if _, err := out.Write(append(encoded, '\n')); err != nil {
			return false
		}
		return out.Flush() == nil
	}

	if !writeFrame(readyFrame{
		Type:            "ready",
		ProtocolVersion: ProtocolVersion,
		RootCount:       stats.Roots,
		FileCount:       stats.Files,
		DirCount:        stats.Dirs,
		IndexMs:         stats.IndexMs,
		Truncated:       stats.Truncated,
	}) {
		logf("stdout closed before ready")
		os.Exit(1)
	}
	logf("ready: roots=%d files=%d dirs=%d indexMs=%d truncated=%v", stats.Roots, stats.Files, stats.Dirs, stats.IndexMs, stats.Truncated)

	// stdin 结束（宿主退出/关闭管道）即正常结束；单条指令解析失败只跳过，不退出。
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var frame requestFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			logf("bad request frame: %v", err)
			continue
		}
		switch frame.Cmd {
		case "refresh":
			writeResult(writeFrame, frame.ID, indexer.Index())
		case "search-name":
			if frame.Query == "" {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "empty query"})
				continue
			}
			limit := clampInt(frame.Limit, 1, 200, 50)
			writeResult(writeFrame, frame.ID, indexer.SearchNames(frame.Query, limit))
		case "search-content":
			if frame.Query == "" {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "empty query"})
				continue
			}
			limit := clampInt(frame.Limit, 1, 200, 50)
			writeResult(writeFrame, frame.ID, indexer.SearchContent(frame.Query, limit, frame.MaxFileBytes, frame.MaxScannedBytes))
		default:
			writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "unknown cmd: " + frame.Cmd})
		}
	}
	if err := scanner.Err(); err != nil {
		logf("stdin read failed: %v", err)
	}
}

func writeResult(writeFrame func(any) bool, id json.RawMessage, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		writeFrame(responseFrame{Type: "response", ID: id, OK: false, Error: err.Error()})
		return
	}
	writeFrame(responseFrame{Type: "response", ID: id, OK: true, Result: encoded})
}

func clampInt(value, min, max, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
