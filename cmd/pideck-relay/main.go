//go:build !js && !android && !ios

// Command pideck-relay is the public relay PiDeck Lite desktops dial out
// to. It is meant for the product's own host, behind a TLS proxy; users
// never run it.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/pideck-lite/internal/relay"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	cert := flag.String("tls-cert", "", "TLS certificate file; empty serves plain HTTP behind a proxy")
	key := flag.String("tls-key", "", "TLS key file")
	maxEnvs := flag.Int("max-envs", relay.DefaultConfig().MaxEnvs, "environments remembered at once")
	flag.Parse()

	logger := log.New(os.Stderr, "pideck-relay ", log.LstdFlags|log.Lmsgprefix)
	server := relay.New(relay.Config{MaxEnvs: *maxEnvs, Logger: logger})
	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	sweep := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				server.Sweep(30 * time.Minute)
			case <-sweep:
				return
			}
		}
	}()

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-done
		close(sweep)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Close()
		_ = srv.Shutdown(ctx)
	}()

	logger.Printf("listening on %s", *addr)
	var err error
	if *cert != "" && *key != "" {
		err = srv.ListenAndServeTLS(*cert, *key)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		logger.Fatal(err)
	}
}
