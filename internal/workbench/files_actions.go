//go:build !js && !android && !ios

package workbench

// revealFileBrowserRoot shows the platform file manager at root.
func (a *app) revealFileBrowserRoot(root string) {
	if root == "" {
		return
	}
	a.openFolder(localTarget, root)
}
