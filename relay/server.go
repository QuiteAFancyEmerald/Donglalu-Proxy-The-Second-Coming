package main

import (
	"fmt"
	"net"
	"sync"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// Server is the TURN relay. nginx feeds it plain TURN over TCP after
// terminating TLS on 443.
type Server struct {
	cfg  *Config
	turn *turn.Server

	mu     sync.Mutex
	total  int
	byUser map[string]int
}

// Start opens the TURN listener and returns once it is serving.
func Start(cfg *Config) (*Server, error) {
	s := &Server{cfg: cfg, byUser: map[string]int{}}

	logs := logging.NewDefaultLoggerFactory()
	logs.DefaultLogLevel = logLevel(cfg.LogLevel)

	ln, err := net.Listen("tcp", cfg.TURNListen)
	if err != nil {
		return nil, fmt.Errorf("turn listener: %w", err)
	}

	s.turn, err = turn.NewServer(turn.ServerConfig{
		Realm:         cfg.Realm,
		LoggerFactory: logs,
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(cfg.Secret, logs.NewLogger("auth")),
		QuotaHandler:  s.quota,
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(_, _ net.Addr, _, username, _ string, _ net.Addr, _ int) {
				s.track(username, 1)
			},
			OnAllocationDeleted: func(_, _ net.Addr, _, username, _ string) {
				s.track(username, -1)
			},
		},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener: ln,
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: cfg.RelayIP,
				Address:      cfg.RelayBind,
				MinPort:      cfg.RelayMinPort,
				MaxPort:      cfg.RelayMaxPort,
			},
			PermissionHandler: func(_ net.Addr, peerIP net.IP) bool {
				return cfg.peerAllowed(peerIP)
			},
		}},
	})
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	return s, nil
}

// Close stops the listener and drops every allocation.
func (s *Server) Close() error {
	return s.turn.Close()
}

func (s *Server) quota(username, _ string, _ net.Addr) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cfg.MaxAllocs > 0 && s.total >= s.cfg.MaxAllocs {
		return false
	}
	return s.cfg.MaxAllocsPerUser <= 0 || s.byUser[username] < s.cfg.MaxAllocsPerUser
}

func (s *Server) track(username string, delta int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.total += delta
	if n := s.byUser[username] + delta; n > 0 {
		s.byUser[username] = n
	} else {
		delete(s.byUser, username)
	}
}

func logLevel(name string) logging.LogLevel {
	switch name {
	case "error":
		return logging.LogLevelError
	case "info":
		return logging.LogLevelInfo
	case "debug":
		return logging.LogLevelDebug
	case "trace":
		return logging.LogLevelTrace
	default:
		return logging.LogLevelWarn
	}
}
