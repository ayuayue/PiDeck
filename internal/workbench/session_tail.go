//go:build !js && !android && !ios

package workbench

// Reading a session file where the last read stopped. pi appends to a
// session file and never rewrites it, so a reader that remembers how far it
// got only has to read the new tail - once it has checked that the bytes
// before its stopping point are still there, which is what a rewrite (a
// compacted session) is missing.

import (
	"bytes"
	"errors"
	"io"
	"os"
)

// errStopTail ends a read early: the caller already knows enough about the
// file, and reading on would only cost time.
var errStopTail = errors.New("stop reading")

// tailProbe is how many bytes before the stopping point are checked, and
// how many an appended parse reads back to fingerprint its new position.
const tailProbe = 256

// tailChunk is how much of a file is read at a time.
const tailChunk = 256 << 10

// parsedTail is how much of a file a parse has taken, with a checksum of
// the bytes just before that point.
type parsedTail struct {
	Consumed int64  `json:"consumed,omitempty"`
	Probe    uint64 `json:"probe,omitempty"`
}

// resumeAt is where a parse of the same file may start again: where the last
// one stopped, when the file only grew and the bytes before that point are
// unchanged, otherwise the beginning.
func (t parsedTail) resumeAt(path string, size int64) int64 {
	if t.Consumed <= 0 || size <= t.Consumed {
		return 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := int64(tailProbe)
	if n > t.Consumed {
		n = t.Consumed
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, t.Consumed-n); err != nil {
		return 0
	}
	if probeSum(buf) != t.Probe {
		return 0
	}
	return t.Consumed
}

// probeSum is FNV-1a over the bytes before a stopping point. It only has to
// tell a rewrite from an append, so a checksum is enough and keeps the cache
// small enough to write on every start.
func probeSum(b []byte) uint64 {
	h := uint64(14695981039346656037)
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

// readTail hands every complete line from start to fn, and reports where it
// stopped: after the last line that ended with a newline, so a line still
// being written is read again once the file grows. The line a callback gets
// is only good until it returns.
func readTail(path string, start int64, fn func(line []byte) error) (parsedTail, error) {
	f, err := os.Open(path)
	if err != nil {
		return parsedTail{}, err
	}
	defer f.Close()
	if start > 0 {
		if _, err := f.Seek(start, io.SeekStart); err != nil {
			return parsedTail{}, err
		}
	}
	buf := make([]byte, tailChunk)
	consumed := start
	// A line can be longer than a chunk - a tool result is - so its start
	// is carried to the next read.
	var partial []byte
	for {
		n, readErr := f.Read(buf)
		rest := buf[:n]
		for {
			i := bytes.IndexByte(rest, '\n')
			if i < 0 {
				partial = append(partial, rest...)
				break
			}
			line := rest[:i]
			if len(partial) > 0 {
				partial = append(partial, line...)
				line = partial
			}
			consumed += int64(len(line)) + 1
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if perr := fn(line); perr != nil {
				return parsedTail{Consumed: consumed, Probe: tailProbeAt(f, consumed)}, perr
			}
			partial = partial[:0]
			rest = rest[i+1:]
		}
		if readErr != nil {
			if readErr != io.EOF {
				return parsedTail{Consumed: consumed, Probe: tailProbeAt(f, consumed)}, readErr
			}
			break // a half-written last line stays for the next read
		}
	}
	return parsedTail{Consumed: consumed, Probe: tailProbeAt(f, consumed)}, nil
}

// tailProbeAt fingerprints the bytes just before off, read back from the
// file so it covers the earlier parse as well as the new tail.
func tailProbeAt(f *os.File, off int64) uint64 {
	n := int64(tailProbe)
	if n > off {
		n = off
	}
	if n <= 0 {
		return 0
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, off-n); err != nil {
		return 0
	}
	return probeSum(buf)
}
