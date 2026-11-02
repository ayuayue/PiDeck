// Package main implements PiDeck's one-shot SFTP transfer executor.
//
// The host process owns route verification and builds the exact OpenSSH argv. This
// process only consumes that preflighted argv, starts the pinned ssh client, and
// speaks standard SFTP to its subsystem. Keeping one job per process makes
// cancellation and generation ownership explicit; a killed job cannot leak a
// stale session into a later project generation.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	protocolVersion      = 1
	maxRequestBytes      = 1024 * 1024
	maxSSHArgs           = 256
	maxSSHArgBytes       = 64 * 1024
	maxRemotePathBytes   = 4096
	defaultMaxEntries    = 1000
	maxListEntries       = 10000
	minTransferChunkSize = 64 * 1024
	maxTransferChunkSize = 4 * 1024 * 1024
)

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type request struct {
	Version    int       `json:"version"`
	Operation  string    `json:"operation"`
	SSH        sshLaunch `json:"ssh"`
	Root       string    `json:"root"`
	Relative   string    `json:"relative,omitempty"`
	LocalPath  string    `json:"localPath,omitempty"`
	MaxEntries int       `json:"maxEntries,omitempty"`
	ChunkBytes int       `json:"chunkBytes,omitempty"`
	Overwrite  bool      `json:"overwrite,omitempty"`
}

type sshLaunch struct {
	Executable string            `json:"executable"`
	Args       []string          `json:"args"`
	Env        map[string]string `json:"env"`
	Cwd        string            `json:"cwd,omitempty"`
}

type jobError struct {
	code string
	err  error
}

func (e *jobError) Error() string {
	if e.err == nil {
		return e.code
	}
	return e.code + ": " + e.err.Error()
}

func (e *jobError) Unwrap() error {
	return e.err
}

func fail(code string, err error) error {
	return &jobError{code: code, err: err}
}

func codeOf(err error) string {
	var coded *jobError
	if errors.As(err, &coded) {
		return coded.code
	}
	return "SFTP_JOB_FAILED"
}

func decodeRequest(reader io.Reader) (request, error) {
	var value request
	limited := io.LimitReader(reader, maxRequestBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return request{}, fail("SFTP_REQUEST_READ_FAILED", err)
	}
	if len(data) > maxRequestBytes {
		return request{}, fail("SFTP_REQUEST_TOO_LARGE", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return request{}, fail("SFTP_REQUEST_INVALID", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return request{}, fail("SFTP_REQUEST_INVALID", nil)
	}
	if err := validateRequest(&value); err != nil {
		return request{}, err
	}
	return value, nil
}

func validateRequest(value *request) error {
	if value.Version != protocolVersion {
		return fail("SFTP_PROTOCOL_VERSION_UNSUPPORTED", nil)
	}
	switch value.Operation {
	case "probe", "list", "download", "upload":
	default:
		return fail("SFTP_OPERATION_INVALID", nil)
	}
	if err := validateSSHLaunch(value.SSH); err != nil {
		return err
	}
	root, err := canonicalRemoteRoot(value.Root)
	if err != nil {
		return err
	}
	value.Root = root
	relative, err := relativeRemotePath(value.Relative)
	if err != nil {
		return err
	}
	value.Relative = relative
	if value.Operation != "list" && value.Operation != "probe" && relative == "" {
		return fail("SFTP_REMOTE_PATH_INVALID", nil)
	}
	if value.Operation == "download" || value.Operation == "upload" {
		if value.Overwrite {
			return fail("SFTP_OVERWRITE_UNSUPPORTED", nil)
		}
		if !validLocalPath(value.LocalPath) {
			return fail("SFTP_LOCAL_PATH_INVALID", nil)
		}
	}
	if value.Operation == "probe" || value.Operation == "download" || value.Operation == "upload" {
		value.MaxEntries = 0
	} else {
		if value.MaxEntries == 0 {
			value.MaxEntries = defaultMaxEntries
		}
		if value.MaxEntries < 1 || value.MaxEntries > maxListEntries {
			return fail("SFTP_LIST_LIMIT_INVALID", nil)
		}
	}
	if value.ChunkBytes == 0 {
		value.ChunkBytes = 1024 * 1024
	}
	if value.ChunkBytes < minTransferChunkSize || value.ChunkBytes > maxTransferChunkSize {
		return fail("SFTP_CHUNK_SIZE_INVALID", nil)
	}
	return nil
}

func validateSSHLaunch(value sshLaunch) error {
	if !validLocalPath(value.Executable) {
		return fail("SFTP_SSH_EXECUTABLE_INVALID", nil)
	}
	if len(value.Args) > maxSSHArgs {
		return fail("SFTP_SSH_ARGS_INVALID", nil)
	}
	total := 0
	for _, arg := range value.Args {
		if strings.ContainsRune(arg, '\x00') {
			return fail("SFTP_SSH_ARGS_INVALID", nil)
		}
		total += len(arg)
		if total > maxSSHArgBytes {
			return fail("SFTP_SSH_ARGS_INVALID", nil)
		}
	}
	for key, item := range value.Env {
		if !envKeyPattern.MatchString(key) || strings.ContainsRune(item, '\x00') {
			return fail("SFTP_SSH_ENV_INVALID", nil)
		}
	}
	if value.Cwd != "" && !validLocalPath(value.Cwd) {
		return fail("SFTP_SSH_CWD_INVALID", nil)
	}
	return nil
}

func canonicalRemoteRoot(value string) (string, error) {
	if value == "" || len(value) > maxRemotePathBytes || hasControl(value) || !path.IsAbs(value) {
		return "", fail("SFTP_REMOTE_ROOT_INVALID", nil)
	}
	clean := path.Clean(value)
	if clean != value || clean == "/" {
		return "", fail("SFTP_REMOTE_ROOT_INVALID", nil)
	}
	return clean, nil
}

func relativeRemotePath(value string) (string, error) {
	if len(value) > maxRemotePathBytes || hasControl(value) {
		return "", fail("SFTP_REMOTE_PATH_INVALID", nil)
	}
	if value == "" {
		return "", nil
	}
	if path.IsAbs(value) {
		return "", fail("SFTP_REMOTE_PATH_INVALID", nil)
	}
	clean := path.Clean(value)
	if clean == "." || clean != value || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fail("SFTP_REMOTE_PATH_INVALID", nil)
	}
	return clean, nil
}

func validLocalPath(value string) bool {
	return value != "" &&
		len(value) <= maxRemotePathBytes &&
		!hasControl(value) &&
		filepath.IsAbs(value) &&
		filepath.Clean(value) == value
}

func hasControl(value string) bool {
	for _, r := range value {
		if r == 0 || r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func remotePath(root, relative string) string {
	if relative == "" {
		return root
	}
	return path.Join(root, relative)
}

func remoteChild(root, relative string) (string, error) {
	item := remotePath(root, relative)
	if item != root && !strings.HasPrefix(item, root+"/") {
		return "", fail("SFTP_REMOTE_PATH_INVALID", nil)
	}
	return item, nil
}
