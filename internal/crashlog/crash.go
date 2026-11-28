package crashlog

// Crash logs: a panic under the interface is caught by the root's error
// boundary, written to the data folder, and shown with a way to reload
// the interface. A panic outside the tree is written by main's recover.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"example.com/pideck/internal/appinfo"
)

// crashDirName is the folder crash logs go in, under the data folder.
const crashDirName = "crashes"

// crashDir is the folder crash logs go in.
func Dir(dataDir string) string {
	if strings.TrimSpace(dataDir) == "" {
		return ""
	}
	return filepath.Join(dataDir, crashDirName)
}

// writeCrashReport writes one crash log and returns its path. The
// directory is made when missing, and a failure to write is returned so
// the caller can still show the panic.
func WriteReport(dataDir string, recovered any, stack []byte) (string, error) {
	dir := Dir(dataDir)
	if dir == "" {
		return "", fmt.Errorf("没有数据目录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if len(stack) > 64<<10 {
		stack = stack[:64<<10]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "PiDeck %s\n", appinfo.Version)
	fmt.Fprintf(&b, "time: %s\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(&b, "platform: %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(&b, "go: %s\n\n", runtime.Version())
	fmt.Fprintf(&b, "%v\n\n", recovered)
	b.Write(stack)
	name := "crash-" + time.Now().Format("20060102-150405.000") + ".log"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// latestCrash is the newest crash log in the data folder.
func Latest(dataDir string) (string, time.Time, bool) {
	dir := Dir(dataDir)
	if dir == "" {
		return "", time.Time{}, false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", time.Time{}, false
	}
	var newest string
	var at time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if newest == "" || info.ModTime().After(at) {
			newest = filepath.Join(dir, e.Name())
			at = info.ModTime()
		}
	}
	return newest, at, newest != ""
}

// crashCount counts the crash logs in the data folder.
func Count(dataDir string) int {
	dir := Dir(dataDir)
	if dir == "" {
		return 0
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".log") {
			n++
		}
	}
	return n
}

// crashDataDir remembers the data folder for the panic main's recover
// writes, before the app itself exists.
var crashDataDir struct {
	sync.RWMutex
	dir string
}

// setCrashDataDir records where crash logs go.
func SetDataDir(dir string) {
	crashDataDir.Lock()
	crashDataDir.dir = dir
	crashDataDir.Unlock()
}

// crashDataDirNow is the recorded data folder, or the platform's default
// when the app has not started yet.
func DataDir() string {
	crashDataDir.RLock()
	dir := crashDataDir.dir
	crashDataDir.RUnlock()
	if dir != "" {
		return dir
	}
	if custom := strings.TrimSpace(os.Getenv("PIDECK_V2_HOME")); custom != "" {
		return custom
	}
	if base, err := os.UserConfigDir(); err == nil {
		return filepath.Join(base, "dev.nsgo.pideckv2")
	}
	return ""
}
