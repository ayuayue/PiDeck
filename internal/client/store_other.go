//go:build !js

package client

// The last connection lives beside the app's data on a device with a disk.

import (
	"os"
	"path/filepath"

	"github.com/nsgo-dev/nsgo/core"
)

func mobileStorePath(cx *core.Scope) string {
	dir := os.Getenv("PIDECK_LITE_HOME")
	if dir == "" {
		dir = cx.DataDir()
	}
	return filepath.Join(dir, "remote.json")
}

func readMobileStore(cx *core.Scope) ([]byte, error) {
	return os.ReadFile(mobileStorePath(cx))
}

func writeMobileStore(cx *core.Scope, raw []byte) error {
	path := mobileStorePath(cx)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

// webStart has nothing to say to a native build: no page served it.
func webStart() (server, token string) { return "", "" }

// webReload has nothing to reload on a device: its app is installed.
func webReload() {}
