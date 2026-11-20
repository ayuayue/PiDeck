//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func wallpaperVideo(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".mp4", ".webm", ".mov", ".m4v":
		return true
	}
	return false
}

func (c config) wallpaper() string {
	if wallpaperVideo(c.BackgroundVideo) {
		return c.BackgroundVideo
	}
	return strings.TrimSpace(c.BackgroundImage)
}

func readVideoWallpaper(file string) (string, error) {
	invalid := errors.New(apptext.T("此文件不是可播放的视频壁纸。"))
	if wallpaperVideo(file) {
		if info, err := os.Stat(file); err == nil && info.Mode().IsRegular() {
			return file, nil
		}
		return "", invalid
	}
	if !strings.EqualFold(filepath.Base(file), "project.json") {
		return "", invalid
	}
	dir := filepath.Dir(file)
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	f, err := root.Open(filepath.Base(file))
	if err != nil {
		return "", err
	}
	defer f.Close()
	var project struct{ Type, File string }
	if err := json.NewDecoder(io.LimitReader(f, 256<<10)).Decode(&project); err != nil || !strings.EqualFold(project.Type, "video") ||
		!filepath.IsLocal(project.File) || !wallpaperVideo(project.File) {
		return "", invalid
	}
	video, err := root.Stat(project.File)
	if err != nil || !video.Mode().IsRegular() {
		return "", invalid
	}
	return filepath.Join(dir, project.File), nil
}

func (a *app) pickVideoWallpaper() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".mp4", ".webm", ".mov", ".m4v", ".json"}, Limit: 1}, func(files []core.File, err error) {
		if err != nil {
			a.toast(ui.ToastError, "读取视频壁纸失败", err.Error())
			return
		}
		if len(files) != 1 {
			return
		}
		go func() {
			video, err := readVideoWallpaper(files[0].Path)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "读取视频壁纸失败", err.Error())
					return
				}
				a.setBackgroundImage(video)
			})
		}()
	})
}
