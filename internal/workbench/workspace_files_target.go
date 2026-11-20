//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// The same transport handles WSL and SSH. Every parameter from the app
// follows the literal script as a positional argument; only the script
// itself contains shell syntax.
func (t target) workspaceCommand(ctx context.Context, root, script string, params ...string) (*exec.Cmd, error) {
	if !strings.HasPrefix(root, "/") || strings.ContainsAny(root, "\x00\r\n") {
		return nil, errFilePath
	}
	args := append([]string{"sh", "-c", script, "pideck-files", root}, params...)
	var cmd *exec.Cmd
	switch t.Kind {
	case targetWSL:
		cmd = exec.CommandContext(ctx, "wsl.exe", append([]string{"-d", t.Distro, "--exec"}, args...)...)
	case targetSSH:
		if t.Host == "" || strings.HasPrefix(t.Host, "-") {
			return nil, errFilePath
		}
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "--", t.Host, shellJoin(args))
	default:
		return nil, errFilePath
	}
	hideWindow(cmd)
	return cmd, nil
}

const targetFileGuard = `
cd -P "$1" || exit 41
file="./$2"
parent="${file%/*}"
while [ "$parent" != . ]; do
  [ ! -L "$parent" ] && [ -d "$parent" ] || exit 42
  parent="${parent%/*}"
done
[ ! -L "$file" ] || exit 42
[ -f "$file" ] || exit 41
`

func (f workspaceFile) readTarget(ctx context.Context, limit int64) ([]byte, error) {
	cmd, err := f.target.workspaceCommand(ctx, f.root, targetFileGuard+`head -c "$3" "$file"`, f.rel, strconv.FormatInt(limit+1, 10))
	if err != nil {
		return nil, err
	}
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	data, readErr := readTextFile(pipe, limit)
	_ = pipe.Close()
	if readErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, readErr
	}
	if err := targetFileError(cmd.Wait()); err != nil {
		return nil, err
	}
	return data, nil
}

func (f workspaceFile) saveTarget(ctx context.Context, expected string, data []byte) error {
	cmd, err := f.target.workspaceCommand(ctx, f.root, targetFileGuard+`
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    result=$(sha256sum < "$file") || exit 43
  elif command -v shasum >/dev/null 2>&1; then
    result=$(shasum -a 256 < "$file") || exit 43
  else
    exit 43
  fi
  [ "${result%% *}" = "$3" ] || exit 44
}
checksum "$@"
temporary=$(mktemp "${file%/*}/.pideck-save-XXXXXX") || exit 43
trap 'rm -f "$temporary"' EXIT
cp -p "$file" "$temporary" && cat > "$temporary" || exit 43
checksum "$@"
mv -f "$temporary" "$file" || exit 43
`, f.rel, expected)
	if err != nil {
		return err
	}
	cmd.Stdin = bytes.NewReader(data)
	return targetFileError(cmd.Run())
}

func targetFileError(err error) error {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		switch exit.ExitCode() {
		case 41:
			return os.ErrNotExist
		case 42:
			return errFilePath
		case 44:
			return errFileConflict
		}
	}
	return err
}

// targetFiles walks the project's regular files. find uses NUL boundaries
// so names with spaces or quotes stay intact, and never follows symlinks.
func (t target) targetFiles(ctx context.Context, root string) ([]string, error) {
	cmd, err := t.workspaceCommand(ctx, root, `cd -P "$1" || exit 41
find . \( -type d \( -name .git -o -name node_modules -o -name vendor \) -prune \) -o -type f -print0`)
	if err != nil {
		return nil, err
	}
	r, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return collectTargetFiles(cmd, r)
}

func collectTargetFiles(cmd *exec.Cmd, r io.ReadCloser) ([]string, error) {
	files, limit, err := parseTargetFiles(r)
	_ = r.Close()
	if limit || err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	} else if err := targetFileError(cmd.Wait()); err != nil {
		return nil, fmt.Errorf("list project: %w", err)
	}
	sort.Strings(files)
	return files, err
}

func parseTargetFiles(r io.Reader) ([]string, bool, error) {
	const pathBudget = 4 << 20
	bounded := &io.LimitedReader{R: r, N: pathBudget}
	reader := bufio.NewReader(bounded)
	var files []string
	for len(files) < 10000 {
		line, err := reader.ReadString(0)
		if errors.Is(err, io.EOF) {
			return files, bounded.N == 0, nil
		}
		if err != nil {
			return nil, false, err
		}
		if name, ok := workspaceFileRel(strings.TrimSuffix(strings.TrimPrefix(line, "./"), "\x00")); ok {
			files = append(files, name)
		}
	}
	return files, true, nil
}
