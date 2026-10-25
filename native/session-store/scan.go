package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

// 单行上限：与 TS 侧 `src/main/sessions/jsonlLineStream.ts` 的
// MAX_JSONL_LINE_BYTES 一致——超过它的行不 decode 正文（巨型内联附件行），
// 只从行首前缀里抢 id，避免把内存打穿。
const maxScanLineBytes = 64 * 1024 * 1024

// 单次读盘块大小；与 TS 侧 DEFAULT_JSONL_CHUNK_BYTES 一致。
const scanChunkBytes = 1024 * 1024

// 超长行回传/回看的前缀长度（与 TS 侧 OVERSIZED_PREFIX_BYTES 同口径）。
const oversizedPrefixBytes = 64 * 1024

// scanResult 是一次区间扫描的结果。
//
// CommittedSize 是「已提交字节数」，恒落在完整行边界上：文件写到一半时它停在
// 最后一条完整行的末尾，下一轮从该位置继续读即可，天然支持 pi 边写边追加。
type scanResult struct {
	CommittedSize   int64
	EntryCount      int
	HasCompaction   bool
	EndsWithNewline bool
}

// 行首字段：只解出判定所需的两个顶层字段，其余（正文、工具结果、附件）一律不进内存。
type lineHeader struct {
	ID   *string `json:"id"`
	Type string  `json:"type"`
}

// scanRange 从 start 起扫描文件，统计条目数与压缩标记。
//
// 只统计**完整行**（以 \n 结尾）：文件末尾的残行是 pi 正在写的半条记录，
// 本轮不计入、也不推进 CommittedSize，等它写完整后下一轮再算。
func scanRange(path string, start int64) (scanResult, error) {
	file, err := os.Open(path)
	if err != nil {
		return scanResult{}, err
	}
	defer file.Close()

	if start > 0 {
		if _, err := file.Seek(start, io.SeekStart); err != nil {
			return scanResult{}, err
		}
	}

	reader := bufio.NewReaderSize(file, scanChunkBytes)
	result := scanResult{CommittedSize: start}
	line := make([]byte, 0, 4096)
	lineOversized := false
	lastComplete := false

	commitLine := func() {
		if lineOversized {
			// 超长行：正文已被丢弃，只用前缀里的 id/type 做降级判定。
			if prefixHasStringField(line, "id") {
				result.EntryCount++
			}
			if bytes.Contains(line, []byte(`"compaction"`)) {
				result.HasCompaction = true
			}
		} else if len(line) > 0 {
			var header lineHeader
			if err := json.Unmarshal(line, &header); err == nil {
				if header.ID != nil {
					result.EntryCount++
				}
				if header.Type == "compaction" {
					result.HasCompaction = true
				}
			}
		}
		result.CommittedSize += int64(len(line)) + 1
		line = line[:0]
		lineOversized = false
	}

	for {
		chunk, err := reader.ReadSlice('\n')
		if err != nil && err != bufio.ErrBufferFull && err != io.EOF {
			return result, err
		}
		complete := err == nil

		payload := chunk
		if complete {
			payload = chunk[:len(chunk)-1]
		}

		if len(payload) > 0 && !lineOversized {
			room := maxScanLineBytes - len(line)
			if room <= 0 {
				lineOversized = true
			} else if len(payload) <= room {
				line = append(line, payload...)
			} else {
				line = append(line, payload[:room]...)
				lineOversized = true
			}
			if len(line) >= maxScanLineBytes {
				lineOversized = true
			}
		}

		if complete {
			lastComplete = true
			commitLine()
			continue
		}
		if err == io.EOF {
			// 末尾无终止符的残行：不提交；它不改变 endsWithNewline 之外的任何计数。
			if len(payload) > 0 {
				lastComplete = false
			}
			break
		}
		// ErrBufferFull：同一行还没读完，继续。
	}

	result.EndsWithNewline = lastComplete
	return result, nil
}

// prefixHasStringField 在超长行前缀里粗判 `"key":"…"` 是否存在。
// 只用于「正文已被丢弃」的降级路径，与 TS 侧 oversized 条目的抢救口径同类。
func prefixHasStringField(prefix []byte, key string) bool {
	needle := []byte(`"` + key + `"`)
	index := bytes.Index(prefix, needle)
	if index < 0 {
		return false
	}
	rest := prefix[index+len(needle):]
	colon := bytes.IndexByte(rest, ':')
	if colon < 0 {
		return false
	}
	rest = bytes.TrimLeft(rest[colon+1:], " \t\r\n")
	return len(rest) > 1 && rest[0] == '"' && rest[1] != '"'
}
