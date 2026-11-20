//go:build !js && !android && !ios && !windows

package workbench

import "errors"

func registerSessionLinks(string) error {
	return errors.New("this platform registers links at installation")
}
