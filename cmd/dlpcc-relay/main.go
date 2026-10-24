// Command dlpcc-relay is a TURN relay meant to sit behind nginx on 443, so
// WebRTC media from proxied pages travels as TLS instead of blocked UDP.
package main

import (
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/QuiteAFancyEmerald/DLPCC/internal/relay"
)

func main() {
	cfg, err := relay.Load(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatalf("dlpcc-relay: %v", err)
	}

	srv, err := relay.Start(cfg)
	if err != nil {
		log.Fatalf("dlpcc-relay: %v", err)
	}
	log.Printf("dlpcc-relay: turn on %s, relaying as %s ports %d-%d", cfg.TURNListen, cfg.RelayIP, cfg.RelayMinPort, cfg.RelayMaxPort)
	if cfg.HTTPListen != "" {
		log.Printf("dlpcc-relay: credentials on http://%s/dlpcc/", cfg.HTTPListen)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig

	if err := srv.Close(); err != nil {
		log.Printf("dlpcc-relay: shutdown: %v", err)
	}
}
