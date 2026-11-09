package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func namePacket(id uint32, names ...string) []byte {
	payload := make([]byte, 0, 13)
	payload = append(payload, sftpPacketName)
	payload = binary.BigEndian.AppendUint32(payload, id)
	payload = binary.BigEndian.AppendUint32(payload, uint32(len(names)))
	for _, name := range names {
		payload = binary.BigEndian.AppendUint32(payload, uint32(len(name)))
		payload = append(payload, name...)
		payload = binary.BigEndian.AppendUint32(payload, 0)
		payload = binary.BigEndian.AppendUint32(payload, 0)
	}
	frame := make([]byte, 4)
	binary.BigEndian.PutUint32(frame, uint32(len(payload)))
	return append(frame, payload...)
}

func TestBoundedPacketReaderStopsBeforeAnAdditionalNameBatch(t *testing.T) {
	first := namePacket(1, "a", "b")
	second := namePacket(2, "c", "d")
	reader := newBoundedPacketReader(bytes.NewReader(append(first, second...)))
	reader.begin(2)

	got, err := io.ReadAll(reader)
	if !errors.Is(err, errBoundedDirectory) {
		t.Fatalf("got error %v, want bounded-directory sentinel", err)
	}
	if !bytes.Equal(got, first) {
		t.Fatalf("reader consumed data beyond the retained batch: got %d bytes, want %d", len(got), len(first))
	}
	observed, truncated, terminal := reader.end()
	if observed != 2 || !truncated || !errors.Is(terminal, errBoundedDirectory) {
		t.Fatalf("unexpected bounded state: observed=%d truncated=%v terminal=%v", observed, truncated, terminal)
	}
}

func TestBoundedPacketReaderExactCapIsNotTruncated(t *testing.T) {
	frame := namePacket(4, "a", "b")
	reader := newBoundedPacketReader(bytes.NewReader(frame))
	reader.begin(2)

	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, frame) {
		t.Fatal("exact-cap batch was not passed through unchanged")
	}
	observed, truncated, terminal := reader.end()
	if observed != 2 || truncated || terminal != nil {
		t.Fatalf("unexpected exact-cap state: observed=%d truncated=%v terminal=%v", observed, truncated, terminal)
	}
}

func TestBoundedPacketReaderInactivePathIsTransparent(t *testing.T) {
	frame := namePacket(3, "a")
	reader := newBoundedPacketReader(bytes.NewReader(frame))
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, frame) {
		t.Fatal("inactive reader changed the SFTP frame")
	}
}
