//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"example.com/pideck-lite/internal/remotewire"
)

func transcriptImageRef(turn, step, tool, index int, start time.Time) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d", turn, step, tool, index, start.UnixNano())
}

type imageLocation struct {
	turn, step, tool, index int
	stamp                   int64
}

func parseImageLocation(ref string) (imageLocation, bool) {
	if len(ref) > 90 {
		return imageLocation{}, false
	}
	parts := strings.Split(ref, ":")
	if len(parts) != 5 {
		return imageLocation{}, false
	}
	var nums [4]int
	for i := range nums {
		v, err := strconv.Atoi(parts[i])
		if err != nil {
			return imageLocation{}, false
		}
		nums[i] = v
	}
	stamp, err := strconv.ParseInt(parts[4], 10, 64)
	return imageLocation{nums[0], nums[1], nums[2], nums[3], stamp}, err == nil && nums[0] >= 0 && nums[3] >= 0
}

func (loc imageLocation) imageIn(turns []turn) []byte {
	if loc.turn >= len(turns) || loc.turn < 0 || loc.index < 0 {
		return nil
	}
	t := turns[loc.turn]
	if t.Start.UnixNano() != loc.stamp {
		return nil
	}
	var imgs []remotewire.Image
	switch {
	case loc.step == -1 && loc.tool == -1:
		imgs = t.Images
	case loc.step >= 0 && loc.step < len(t.Steps) && loc.tool >= 0 && loc.tool < len(t.Steps[loc.step].Tools):
		imgs = t.Steps[loc.step].Tools[loc.tool].Images
	}
	if loc.index >= len(imgs) {
		return nil
	}
	return imgs[loc.index].Data
}

func (h *remoteHost) handleTranscriptImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("session")
	loc, valid := parseImageLocation(r.URL.Query().Get("ref"))
	if id == "" || !valid {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	var path string
	var data []byte
	if !h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			return
		}
		if s.loaded.GetUntracked() {
			data = loc.imageIn(s.turns.GetUntracked())
			return
		}
		path = s.File
	}) {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if path != "" {
		if turns, err := readSessionTurns(path); err == nil {
			data = loc.imageIn(turns)
		}
	}
	img, ok := transcriptImage(data)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", img.MimeType)
	w.Header().Set("Content-Length", strconv.Itoa(len(img.Data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(img.Data)
}
