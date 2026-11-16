//go:build !js

package main

// The processes and terminals the workbench started end with it.

func shutdownHosts() {
	stopTaskScheduler()
	closeAllPi()
	closeAllACP()
	closeAllTerminals()
}
