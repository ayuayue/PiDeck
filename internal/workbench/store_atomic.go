//go:build !js && !android && !ios

package workbench

import (
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var atomicFileWrites = struct {
	sync.Mutex
	tails map[string]chan struct{}
}{tails: make(map[string]chan struct{})}

// writeFileAtomic publishes a complete file from a temporary file in the
// same directory. Every call owns its temporary file, including on failure.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	key := path
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	// Windows can reject simultaneous renames onto one destination. Wait
	// for its previous writer without holding a mutex across waiting or I/O.
	done := make(chan struct{})
	atomicFileWrites.Lock()
	previous := atomicFileWrites.tails[key]
	atomicFileWrites.tails[key] = done
	atomicFileWrites.Unlock()
	defer func() {
		atomicFileWrites.Lock()
		if atomicFileWrites.tails[key] == done {
			delete(atomicFileWrites.tails, key)
		}
		atomicFileWrites.Unlock()
		close(done)
	}()
	if previous != nil {
		<-previous
	}
	tmpPath := filepath.Join(filepath.Dir(path), ".pideck-"+rand.Text()+".tmp")
	// Exclusive creation never reuses an existing file or symlink. Opening
	// with the caller's mode also preserves the operating system's umask.
	tmp, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer os.Remove(tmpPath)
	_, writeErr := tmp.Write(data)
	if err := errors.Join(writeErr, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
