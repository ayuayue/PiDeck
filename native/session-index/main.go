// pideck-session-index：跨会话全文搜索 sidecar（Go）。
//
// 为什么存在：PiDeck 的历史会话读取为防主进程 OOM 全线加了分页/大小护栏
// （boundedEntryPage 等），全文检索在 Electron 主进程侧从架构上就不存在；
// 侧栏搜索只匹配标题+160 字预览+路径。真实规模（本机 53 项目/1033 会话/
// 1.67GB）下，把全部正文读进主进程内存建索引不可行。
//
// 方案：本进程把每个会话 JSONL 的对话正文（user/assistant 的 text 块，
// toolCall/toolResult 不进语料）预提取到语料文件（corpus.bin）常驻磁盘，
// 查询时 mmap 多核并行扫描——无倒排索引（全量倒排要 >1GB 堆内存，否决），
// 800MB 级语料扫描在数百毫秒内完成，堆内存只有元数据（几 MB）。
//
// 进程模型：由主进程 SessionIndexService spawn 常驻。stdin 收 NDJSON 指令，
// stdout 发 NDJSON 响应（stdout 只放协议数据，日志一律走 stderr）。
//
// 启动参数：argv[1] = 语料目录（存放 corpus.bin 与 state 快照，宿主传入
// userData 下的专属目录）；argv[2..] = 会话扫描根（可多个，如
// ~/.pi/agent/sessions 与项目级 sessionDir）。
//
// 协议（v1）：
//
//	宿主 → 本进程: {"cmd":"refresh","id":N}            增量重扫（新文件/mtime 变化/删除）
//	               {"cmd":"search","id":N,"query":"...","limit":20,"perSession":3}
//	本进程 → 宿主: {"type":"ready","protocolVersion":1,"sessionCount":N,"entryCount":M,
//	                "corpusBytes":B,"indexMs":T,"fullRebuild":bool}
//	               {"type":"progress","phase":"indexing","filesDone":n,"filesTotal":m}
//	               {"type":"response","id":N,"ok":true,"result":...}
//	               {"type":"response","id":N,"ok":false,"error":"..."}
//
// 降级语义：本进程任何失败（起不来/协议错/超时）都不影响主进程——宿主侧
// 搜索入口退化为现有标题过滤（fail-open，与 xue-index 同哲学）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// ProtocolVersion 与 src/main/sessions/SessionIndexService.ts 的常量保持一致。
const ProtocolVersion = 1

type requestFrame struct {
	Cmd string `json:"cmd"`
	// ID 原样回填（json.RawMessage）：宿主侧自增数字或字符串 id 都兼容，
	// 不像 xue-index 固定 int64——协议层不关心 id 语义。
	ID         json.RawMessage `json:"id"`
	Query      string          `json:"query"`
	Limit      int             `json:"limit"`
	PerSession int             `json:"perSession"`
	// Path 仅 search-session 用：只在这个会话文件里检索（会话内查找）。
	Path string `json:"path"`
}

type readyFrame struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SessionCount    int    `json:"sessionCount"`
	EntryCount      int    `json:"entryCount"`
	CorpusBytes     int64  `json:"corpusBytes"`
	IndexMs         int64  `json:"indexMs"`
	FullRebuild     bool   `json:"fullRebuild"`
}

type progressFrame struct {
	Type       string `json:"type"`
	Phase      string `json:"phase"`
	FilesDone  int    `json:"filesDone"`
	FilesTotal int    `json:"filesTotal"`
}

type responseFrame struct {
	Type   string          `json:"type"`
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error,omitempty"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[session-index] "+format+"\n", args...)
}

func main() {
	if len(os.Args) < 3 {
		logf("usage: session-index <corpusDir> <sessionsRoot>...")
		os.Exit(1)
	}
	corpusDir := os.Args[1]
	roots := os.Args[2:]

	started := time.Now()
	indexer, err := OpenIndexer(corpusDir, roots)
	if err != nil {
		logf("open indexer failed: %v", err)
		os.Exit(1)
	}
	// boot 阶段做全量/增量索引；语料目录不可写等环境级失败 → 退出码 1，宿主降级
	progress := func(filesDone, filesTotal int) {}
	if err := indexer.BootIndex(progress); err != nil {
		logf("boot index failed: %v", err)
		os.Exit(1)
	}
	stats := indexer.Stats()
	indexMs := time.Since(started).Milliseconds()

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

	if !writeFrame(readyFrame{Type: "ready", ProtocolVersion: ProtocolVersion, SessionCount: stats.SessionCount, EntryCount: stats.EntryCount, CorpusBytes: stats.CorpusBytes, IndexMs: indexMs, FullRebuild: stats.FullRebuild}) {
		logf("stdout closed before ready")
		os.Exit(1)
	}

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
			refreshStats, err := indexer.Refresh(progress)
			if err != nil {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: err.Error()})
				continue
			}
			encoded, _ := json.Marshal(refreshStats)
			writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: true, Result: encoded})
		case "search":
			if frame.Query == "" {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "empty query"})
				continue
			}
			limit := frame.Limit
			if limit <= 0 || limit > 100 {
				limit = 20
			}
			perSession := frame.PerSession
			if perSession <= 0 || perSession > 10 {
				perSession = 3
			}
			result := indexer.Search(frame.Query, limit, perSession)
			encoded, err := json.Marshal(result)
			if err != nil {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: err.Error()})
				continue
			}
			writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: true, Result: encoded})
		case "search-session":
			// 会话内查找：只扫一个文件，命中按时间线顺序返回（逐条上一条/下一条）。
			if frame.Query == "" {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "empty query"})
				continue
			}
			if frame.Path == "" {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "empty path"})
				continue
			}
			limit := frame.Limit
			if limit <= 0 || limit > 500 {
				limit = 100
			}
			result := indexer.SearchInSession(frame.Query, frame.Path, limit)
			encoded, err := json.Marshal(result)
			if err != nil {
				writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: err.Error()})
				continue
			}
			writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: true, Result: encoded})
		default:
			writeFrame(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "unknown cmd: " + frame.Cmd})
		}
	}
	if err := scanner.Err(); err != nil {
		logf("stdin read failed: %v", err)
	}
}
