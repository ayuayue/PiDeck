package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
	"syscall"

	"github.com/pkg/sftp"
)

const maxSSHStderrBytes = 16 * 1024

type progressFrame struct {
	Type        string `json:"type"`
	Operation   string `json:"operation"`
	Transferred int64  `json:"transferred"`
	Total       int64  `json:"total"`
}

type resultFrame struct {
	Type   string `json:"type"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Code   string `json:"code,omitempty"`
}

type boundedTail struct {
	data []byte
}

func (b *boundedTail) Write(chunk []byte) (int, error) {
	b.data = append(b.data, chunk...)
	if len(b.data) > maxSSHStderrBytes {
		b.data = b.data[len(b.data)-maxSSHStderrBytes:]
	}
	return len(chunk), nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	encoder := json.NewEncoder(os.Stdout)
	writeResult := func(value any, err error) {
		if err != nil {
			_ = encoder.Encode(resultFrame{Type: "result", OK: false, Code: codeOf(err)})
			return
		}
		_ = encoder.Encode(resultFrame{Type: "result", OK: true, Result: value})
	}

	value, err := decodeRequest(os.Stdin)
	if err != nil {
		writeResult(nil, err)
		os.Exit(1)
	}
	result, err := runCommand(ctx, value, func(transferred, total int64) {
		_ = encoder.Encode(progressFrame{Type: "progress", Operation: value.Operation, Transferred: transferred, Total: total})
	})
	writeResult(result, err)
	if err != nil {
		os.Exit(1)
	}
}

func runCommand(ctx context.Context, value request, progress progressFunc) (any, error) {
	cmd := exec.CommandContext(ctx, value.SSH.Executable, value.SSH.Args...)
	cmd.Env = environmentList(value.SSH.Env)
	if value.SSH.Cwd != "" {
		cmd.Dir = value.SSH.Cwd
	}
	var stderr boundedTail
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fail("SFTP_SSH_START_FAILED", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fail("SFTP_SSH_START_FAILED", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fail("SFTP_SSH_START_FAILED", err)
	}

	var input io.Reader = stdout
	var bounded *boundedPacketReader
	if value.Operation == "list" {
		bounded = newBoundedPacketReader(stdout)
		input = bounded
	}
	client, err := sftp.NewClientPipe(bufio.NewReader(input), stdin)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fail("SFTP_SUBSYSTEM_UNAVAILABLE", err)
	}
	remote := &sftpRemoteClient{client: client, bounded: bounded}
	result, runErr := executeJob(remote, value, progress)
	closeErr := remote.Close()
	waitErr := cmd.Wait()
	if runErr != nil {
		return nil, runErr
	}
	if value.Operation == "list" {
		if listed, ok := result.(listResult); ok && listed.Truncated {
			// The bounded reader intentionally ends the one-shot protocol after the
			// first batch beyond its cap. Process teardown errors are not a second
			// result and must not turn a complete bounded receipt into failure.
			return result, nil
		}
	}
	if closeErr != nil {
		return nil, mapRemoteError(closeErr)
	}
	if waitErr != nil {
		tail := strings.TrimSpace(string(stderr.data))
		if tail != "" {
			_, _ = fmt.Fprintln(os.Stderr, tail)
		}
		return nil, fail("SFTP_SSH_EXITED", waitErr)
	}
	return result, nil
}

func environmentList(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}
