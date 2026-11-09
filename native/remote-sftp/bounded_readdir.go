package main

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
)

const maxControlPacketBytes = 4 * 1024 * 1024
const sftpPacketName byte = 104

var errBoundedDirectory = errors.New("bounded directory limit reached")

// boundedPacketReader inspects SFTP response packets before pkg/sftp parses them.
// It is inactive for all non-list operations; only ReadDirBounded enables it. This
// keeps directory output bounded without copying pkg/sftp or writing a second SFTP
// client, and lets the executor stop after the first READDIR batch beyond its cap.
type boundedPacketReader struct {
	source io.Reader

	mu        sync.Mutex
	active    bool
	max       int
	observed  int
	truncated bool
	terminal  error
	pending   []byte
	offset    int
}

func newBoundedPacketReader(source io.Reader) *boundedPacketReader {
	return &boundedPacketReader{source: source}
}

func (r *boundedPacketReader) begin(maxEntries int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = true
	r.max = maxEntries
	r.observed = 0
	r.truncated = false
	r.terminal = nil
}

func (r *boundedPacketReader) end() (observed int, truncated bool, terminal error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = false
	return r.observed, r.truncated, r.terminal
}

func (r *boundedPacketReader) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	for {
		r.mu.Lock()
		if r.offset < len(r.pending) {
			n := copy(buffer, r.pending[r.offset:])
			r.offset += n
			r.mu.Unlock()
			return n, nil
		}
		if r.terminal != nil {
			err := r.terminal
			r.mu.Unlock()
			return 0, err
		}
		r.pending = nil
		r.offset = 0
		r.mu.Unlock()

		frame, packetType, nameCount, err := readSFTPPacket(r.source)
		if err != nil {
			return 0, err
		}

		r.mu.Lock()
		if r.active && packetType == sftpPacketName && r.observed >= r.max && nameCount > 0 {
			r.truncated = true
			r.terminal = errBoundedDirectory
			r.mu.Unlock()
			return 0, errBoundedDirectory
		}
		if r.active && packetType == sftpPacketName {
			r.observed += nameCount
		}
		r.pending = frame
		r.offset = 0
		r.mu.Unlock()
	}
}

func readSFTPPacket(source io.Reader) ([]byte, byte, int, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(source, header); err != nil {
		return nil, 0, 0, err
	}
	length := binary.BigEndian.Uint32(header)
	if length < 1 || length > maxControlPacketBytes {
		return nil, 0, 0, fail("SFTP_LIST_PACKET_INVALID", nil)
	}
	frame := make([]byte, 4+int(length))
	copy(frame, header)
	if _, err := io.ReadFull(source, frame[4:]); err != nil {
		return nil, 0, 0, err
	}
	packetType := frame[4]
	if packetType != sftpPacketName {
		return frame, packetType, 0, nil
	}
	// SSH_FXP_NAME: length | type | request id | count | entries.
	if length < 9 {
		return nil, 0, 0, fail("SFTP_LIST_PACKET_INVALID", nil)
	}
	return frame, packetType, int(binary.BigEndian.Uint32(frame[9:13])), nil
}
