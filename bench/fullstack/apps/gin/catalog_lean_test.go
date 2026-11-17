package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCatalogLeanLoggingAndRecovery(t *testing.T) {
	mode := gin.Mode()
	output, errors := gin.DefaultWriter, gin.DefaultErrorWriter
	gin.SetMode(gin.ReleaseMode)
	t.Cleanup(func() {
		gin.SetMode(mode)
		gin.DefaultWriter, gin.DefaultErrorWriter = output, errors
	})
	for _, profile := range []string{"", "defaults", "matched", "catalog-lean", "catalog-lean-extra", " catalog-lean", "CATALOG-LEAN"} {
		t.Run("profile="+profile, func(t *testing.T) {
			t.Setenv("PROFILE", profile)
			var access, recovery bytes.Buffer
			gin.DefaultWriter, gin.DefaultErrorWriter = &access, &recovery
			r := newRouter()
			r.GET("/ok", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
			r.GET("/panic", func(c *gin.Context) { panic("catalog profile panic") })
			for _, path := range []string{"/ok", "/panic", "/ok"} {
				access.Reset()
				res := httptest.NewRecorder()
				r.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
				want := http.StatusOK
				if path == "/panic" {
					want = http.StatusInternalServerError
				}
				if res.Code != want {
					t.Fatalf("%s: status=%d, want %d", path, res.Code, want)
				}
				if profile == "catalog-lean" {
					if access.Len() != 0 {
						t.Fatalf("lean access log: %s", access.String())
					}
				} else if !strings.Contains(access.String(), path) {
					t.Fatalf("missing ordinary access log for %s: %s", path, access.String())
				}
			}
			if !strings.Contains(recovery.String(), "catalog profile panic") {
				t.Fatalf("panic recovery log missing: %s", recovery.String())
			}
		})
	}
}
