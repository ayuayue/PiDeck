// pideck-xue-index：提示词库检索 sidecar（Go）。
//
// 为什么存在：xueprompts.db 的 content/description 是 gzip BLOB，SQL LIKE 对压缩
// 字节恒不命中，旧实现每次搜索都要把 4MB 库读进 WASM 内存再全表解压匹配，
// 且这些开销全部压在 Electron 主进程上。本进程启动时一次性加载并解压全部
// 条目常驻内存（约 25MB，独立于主进程），查询退化为内存内过滤，毫秒级完成。
//
// 进程模型：由主进程 XueIndexService spawn 常驻。stdin 收 NDJSON 指令，stdout
// 发 NDJSON 响应（stdout 只放协议数据，日志一律走 stderr）。请求串行处理——
// 单次查询是微秒到毫秒级，无需并发。
//
// 启动参数：argv[1] = xueprompts.db 绝对路径（缺失或打不开 → 退出码 1）。
//
// 协议（v1）：
//   宿主 → 本进程: {"cmd":"list","id":N,"params":{...}}   检索（语义见 store.go）
//                  {"cmd":"get","id":N,"slug":"..."}        取单条明文
//   本进程 → 宿主: {"type":"ready","protocolVersion":1,"count":N,"loadMs":M}
//                  {"type":"response","id":N,"ok":true,"result":...}
//                  {"type":"response","id":N,"ok":false,"error":"..."}
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// ProtocolVersion 与 src/main/prompts/XueIndexService.ts 的常量保持一致。
const ProtocolVersion = 1

// listRequest / getRequest 的共用外壳。
type requestFrame struct {
	Cmd    string          `json:"cmd"`
	ID     int64           `json:"id"`
	Params json.RawMessage `json:"params"`
	Slug   string          `json:"slug"`
}

type readyFrame struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	Count           int    `json:"count"`
	LoadMs          int64  `json:"loadMs"`
}

type responseFrame struct {
	Type   string          `json:"type"`
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error,omitempty"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[xue-index] "+format+"\n", args...)
}

func main() {
	if len(os.Args) < 2 {
		logf("missing db path argument")
		os.Exit(1)
	}
	dbPath := os.Args[1]

	started := time.Now()
	store, err := LoadStore(dbPath)
	if err != nil {
		// db 打不开属于环境级失败：告知宿主后退出，宿主会降级回 sql.js 路径
		logf("load db failed: %v", err)
		os.Exit(1)
	}
	loadMs := time.Since(started).Milliseconds()

	out := bufio.NewWriter(os.Stdout)
	writeResponse := func(frame responseFrame) bool {
		encoded, err := json.Marshal(frame)
		if err != nil {
			logf("marshal response frame failed: %v", err)
			return false
		}
		if _, err := out.Write(append(encoded, '\n')); err != nil {
			return false
		}
		return out.Flush() == nil
	}

	count := store.Count()
	ready, readyErr := json.Marshal(readyFrame{Type: "ready", ProtocolVersion: ProtocolVersion, Count: count, LoadMs: loadMs})
	if readyErr != nil {
		logf("marshal ready frame failed: %v", readyErr)
		os.Exit(1)
	}
	if _, err := out.Write(append(ready, '\n')); err != nil || out.Flush() != nil {
		logf("stdout closed before ready")
		os.Exit(1)
	}

	// stdin 结束（宿主退出/关闭管道）即正常结束；单条指令解析失败只回错误帧，不退出。
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
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
		case "list":
			var params ListParams
			if len(frame.Params) > 0 {
				if err := json.Unmarshal(frame.Params, &params); err != nil {
					writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: fmt.Sprintf("bad list params: %v", err)})
					continue
				}
			}
			result, err := store.List(params)
			if err != nil {
				writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: err.Error()})
				continue
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: err.Error()})
				continue
			}
			writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: true, Result: encoded})
		case "get":
			doc := store.Get(frame.Slug)
			// 未命中返回 result:null（宿主侧把 null 视为「库里没有这条」）
			var encoded json.RawMessage
			if doc != nil {
				encoded, _ = json.Marshal(doc)
			} else {
				encoded = json.RawMessage("null")
			}
			writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: true, Result: encoded})
		default:
			writeResponse(responseFrame{Type: "response", ID: frame.ID, OK: false, Error: "unknown cmd: " + frame.Cmd})
		}
	}
	if err := scanner.Err(); err != nil {
		logf("stdin read failed: %v", err)
	}
}
