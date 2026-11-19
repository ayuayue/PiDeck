package alerts

// The app's sounds must stay the shapes every platform decodes: a short
// mono PCM WAV. A file drifted into a format NSGo refuses would only show
// up as silence on a phone, so the check runs here.

import (
	"encoding/binary"
	"testing"
)

func TestBuiltinSoundsAreShortMonoWAV(t *testing.T) {
	for _, name := range Names() {
		data, ok := Data(name)
		if !ok || len(data) < 44 {
			t.Fatalf("%s: missing or empty", name)
		}
		if string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
			t.Fatalf("%s: not a RIFF/WAVE file", name)
		}
		// Find fmt and data within the canonical header the generator writes.
		format := int(binary.LittleEndian.Uint16(data[20:22]))
		channels := int(binary.LittleEndian.Uint16(data[22:24]))
		rate := int(binary.LittleEndian.Uint32(data[24:28]))
		bits := int(binary.LittleEndian.Uint16(data[34:36]))
		if format != 1 || channels != 1 || rate <= 0 || bits != 16 {
			t.Fatalf("%s: fmt = %d channels = %d rate = %d bits = %d, want mono 16-bit PCM", name, format, channels, rate, bits)
		}
		size := int(binary.LittleEndian.Uint32(data[40:44]))
		seconds := float64(size) / float64(rate*channels*bits/8)
		if seconds <= 0 || seconds > 5 {
			t.Fatalf("%s: %.2fs, want within NSGo's five seconds", name, seconds)
		}
	}
}

func TestDefaultSoundIsBuiltin(t *testing.T) {
	for _, kind := range []string{KindDone, KindError, KindWaiting} {
		name := Default(kind)
		if _, ok := Data(name); !ok {
			t.Fatalf("%s defaults to %q, which is not a built-in sound", kind, name)
		}
	}
	if Default(KindDone) == Default(KindWaiting) {
		t.Fatal("done and waiting should not sound alike")
	}
}

func TestNamesIsACopy(t *testing.T) {
	list := Names()
	if len(list) == 0 {
		t.Fatal("no built-in sounds")
	}
	list[0] = "changed"
	if Names()[0] == "changed" {
		t.Fatal("Names returns the shared slice")
	}
}
