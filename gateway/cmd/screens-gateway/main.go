// Command screens-gateway is the Screens site gateway agent: a thin executor
// of hub primitives plus a site DNS resolver and mDNS/SSDP reflector that
// keep working from the last persisted config when the cloud is down.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/astralwalker0o/screens/gateway/internal/agent"
	"github.com/astralwalker0o/screens/gateway/internal/config"
	"github.com/astralwalker0o/screens/gateway/internal/logbuf"
)

// version is injected with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-version", "--version":
			fmt.Println(version)
			return
		}
	}
	env := config.FromEnv()
	level := new(slog.LevelVar)
	level.Set(logbuf.ParseLevel(env.LogLevel))
	ring := logbuf.NewRing(2000)
	h := logbuf.New(os.Stderr, ring, level)
	log := slog.New(h)
	slog.SetDefault(log)

	log.Info("screens-gateway starting", "version", version, "data", env.DataDir, "central", env.CentralURL)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	a := agent.New(agent.Options{
		CentralURL:  env.CentralURL,
		EnrollToken: env.EnrollToken,
		DataDir:     env.DataDir,
		Version:     version,
		Logger:      log,
		Handler:     h,
		Ring:        ring,
		Exit:        os.Exit,
	})
	if err := a.Run(ctx); err != nil {
		log.Error("agent failed", "err", err)
		os.Exit(1)
	}
}
