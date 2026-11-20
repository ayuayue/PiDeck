//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// importSession copies a session file into the app's own store, so it can
// be resumed here without sharing a file with another app.
func (s *store) importSession(src string) (sessionMeta, error) {
	f, err := os.Open(src)
	if err != nil {
		return sessionMeta{}, err
	}
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	err = json.NewDecoder(bufio.NewReader(f)).Decode(&head)
	f.Close()
	if err != nil || head.Type != "session" || head.ID == "" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	existing, _ := filepath.Glob(filepath.Join(s.sessions, "*", "*_"+head.ID+".jsonl"))
	if len(existing) > 0 {
		return sessionMeta{}, fmt.Errorf("这个会话已经导入过了")
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(head.Cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, time.Now().UTC().Format("2006-01-02T15-04-05-000Z")+"_"+head.ID+".jsonl")
	data, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("导入后无法读取该会话")
	}
	return m, nil
}

// duplicateSession copies a session file under a new id, so the copy can
// be resumed without sharing a file with the original.
func (s *store) duplicateSession(src, id, title string) (sessionMeta, error) {
	if src == "" || id == "" {
		return sessionMeta{}, fmt.Errorf("没有可复制的会话文件")
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	nl := bytes.IndexByte(raw, '\n')
	if nl < 0 {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	var head map[string]any
	if json.Unmarshal(raw[:nl], &head) != nil || head["type"] != "session" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	cwd, _ := head["cwd"].(string)
	now := time.Now().UTC()
	head["id"] = id
	head["timestamp"] = now.Format(time.RFC3339Nano)
	headRaw, err := json.Marshal(head)
	if err != nil {
		return sessionMeta{}, err
	}
	var out bytes.Buffer
	out.Write(headRaw)
	out.WriteByte('\n')
	out.Write(raw[nl+1:])
	if title != "" {
		info, _ := json.Marshal(map[string]any{
			"type":      "session_info",
			"name":      title,
			"timestamp": now.Format(time.RFC3339Nano),
		})
		out.Write(info)
		out.WriteByte('\n')
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("复制后无法读取该会话")
	}
	return m, nil
}

// deleteSession moves a session file out of the way rather than erasing
// it. A process that just closed can hold the file a moment longer, so the
// move is retried before it is reported as failed.
func (s *store) deleteSession(file, id string) error {
	if file == "" {
		return nil
	}
	trash := filepath.Join(s.dir, "trash")
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	dst := filepath.Join(trash, stamp+"-"+id+".jsonl")
	var err error
	for i := 0; i < 12; i++ {
		if err = os.Rename(file, dst); err == nil {
			return nil
		}
		if _, statErr := os.Stat(file); statErr != nil {
			return nil // already gone
		}
		dst = filepath.Join(trash, fmt.Sprintf("%s-%s-%d.jsonl", stamp, id, i+1))
		time.Sleep(time.Duration(60*(i+1)) * time.Millisecond)
	}
	return fmt.Errorf("文件被占用，稍后再试：%w", err)
}

// encodeCwd is pi's session folder name for a working directory: the
// path with its separator, drive colon and slashes flattened.
func encodeCwd(cwd string) string {
	if cwd == "" {
		return "--unknown--"
	}
	r := strings.NewReplacer(":", "-", "\\", "-", "/", "-")
	return "--" + strings.Trim(r.Replace(filepath.Clean(cwd)), "-") + "--"
}

// newSessionID makes a UUID v4, the ID pi uses for a session.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

// shortPath shortens an absolute path for a label, keeping its end.
func shortPath(path string, n int) string {
	runes := []rune(path)
	if len(runes) <= n {
		return path
	}
	return "…" + string(runes[len(runes)-n+1:])
}
