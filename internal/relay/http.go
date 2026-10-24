package relay

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/QuiteAFancyEmerald/DLPCC/web"
)

// Handler serves the credential endpoints under /dlpcc/. The visitor's
// hostname comes from X-Forwarded-Host (set by nginx) or Host.
func Handler(cfg *Config) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /dlpcc/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})

	mux.HandleFunc("GET /dlpcc/ice", func(w http.ResponseWriter, r *http.Request) {
		ice, ok := iceForRequest(cfg, w, r)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ice)
	})

	mux.HandleFunc("GET /dlpcc/client.js", func(w http.ResponseWriter, r *http.Request) {
		ice, ok := iceForRequest(cfg, w, r)
		if !ok {
			return
		}
		script, err := web.ClientScript(ice)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(script)
	})

	return mux
}

func iceForRequest(cfg *Config, w http.ResponseWriter, r *http.Request) (ICEConfig, bool) {
	w.Header().Set("Cache-Control", "no-store")
	raw := r.Header.Get("X-Forwarded-Host")
	if raw == "" {
		raw = r.Host
	}
	host, err := cfg.NormalizeHost(strings.Split(raw, ",")[0])
	if err != nil {
		http.Error(w, "unknown host", http.StatusForbidden)
		return ICEConfig{}, false
	}
	ice, err := cfg.ICEFor(host)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return ICEConfig{}, false
	}
	return ice, true
}
