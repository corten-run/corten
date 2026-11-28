package main

import (
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/netutil"
)

func matchedRouter(t *testing.T) *gin.Engine {
	t.Helper()
	t.Setenv("PROFILE", "matched")
	t.Setenv("HOSTS", "localhost,127.0.0.1,[::1],example.test:8443")
	r := gin.New()
	if err := configureProduction(r); err != nil {
		t.Fatal(err)
	}
	return r
}

func serveNativeProduction(t *testing.T, r *gin.Engine, cap int, prepare func(*http.Server)) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := productionHTTPServer(l.Addr().String(), r)
	if prepare != nil {
		prepare(s)
	}
	done := make(chan error, 1)
	go func() { done <- s.Serve(netutil.LimitListener(l, cap)) }()
	t.Cleanup(func() {
		_ = s.Close()
		select {
		case err := <-done:
			if err != http.ErrServerClosed {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Error("native server failed to close")
		}
	})
	return "http://" + l.Addr().String()
}

func TestNativeMatchedHeadersHostsAndCompression(t *testing.T) {
	r := matchedRouter(t)
	r.Match([]string{"GET", "HEAD"}, "/json", func(c *gin.Context) { c.JSON(200, gin.H{"native": "<&>"}) })
	r.GET("/page", func(c *gin.Context) { render(c, 200, sourceErrorPage("Native page")) })
	r.GET("/empty", func(c *gin.Context) { c.Status(204) })
	app := httptest.NewServer(r)
	defer app.Close()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	for _, path := range []string{"/page", "/json"} {
		var plain string
		for _, encoding := range []string{"identity", "gzip", "br, gzip", "gzip;q=0, *;q=1", "gzip;q=0.5"} {
			req, _ := http.NewRequest("GET", app.URL+path, nil)
			req.Header.Set("Accept-Encoding", encoding)
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			var body io.Reader = res.Body
			compressed := encoding == "gzip" || encoding == "br, gzip" || encoding == "gzip;q=0.5"
			if compressed {
				if res.Header.Get("Content-Encoding") != "gzip" {
					t.Fatal(res.Header)
				}
				reader, err := gzip.NewReader(body)
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				body = reader
			} else if res.Header.Get("Content-Encoding") != "" {
				t.Fatal(res.Header)
			}
			data, err := io.ReadAll(body)
			res.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if plain == "" {
				plain = string(data)
			} else if string(data) != plain {
				t.Fatal("native representation changed with compression")
			}
			for _, header := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Cross-Origin-Opener-Policy", "Permissions-Policy"} {
				if res.Header.Get(header) == "" {
					t.Fatal(header, res.Header)
				}
			}
			if res.Header.Get("Cache-Control") != "no-store" || !strings.Contains(res.Header.Get("Vary"), "Accept-Encoding") {
				t.Fatal(res.Header)
			}
			if csp := res.Header.Get("Content-Security-Policy"); strings.Contains(csp, "unsafe-") || strings.Contains(csp, "*") {
				t.Fatal(csp)
			}
		}
	}
	for _, tc := range []struct {
		host   string
		status int
	}{{"LOCALHOST:8080", 200}, {"example.test:8443", 200}, {"example.test:8444", 421}, {"attacker.invalid", 421}, {"[::1]:8080", 200}} {
		req, _ := http.NewRequest("GET", app.URL+"/health/live", nil)
		req.Host = tc.host
		req.Header.Set("X-Forwarded-Host", "localhost")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatal(tc, res.Status)
		}
	}
	for _, path := range []string{"/empty", "/json"} {
		method := "GET"
		if path == "/json" {
			method = "HEAD"
		}
		req, _ := http.NewRequest(method, app.URL+path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if len(body) != 0 || res.Header.Get("Content-Encoding") != "" {
			t.Fatal(res.Header, string(body))
		}
	}
	res, _ := client.Get(app.URL + "/health/not-a-health-check")
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("catch-all liveness")
	}
}

func TestNativeProductionBoundsAndFollowup(t *testing.T) {
	r := matchedRouter(t)
	var handled atomic.Int32
	r.POST("/body", func(c *gin.Context) {
		handled.Add(1)
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			c.Status(400)
		} else {
			c.String(200, "read")
		}
	})
	s := productionHTTPServer("", r)
	if s.ReadHeaderTimeout != 30*time.Second || s.ReadTimeout != 30*time.Second || s.WriteTimeout != 30*time.Second || s.IdleTimeout != 30*time.Second || s.MaxHeaderBytes != 16<<10 {
		t.Fatal(s)
	}
	base := serveNativeProduction(t, r, 2, nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableKeepAlives = true
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	// The oversized bodies go from a client that keeps connections alive, as a browser does. A
	// request that says Connection: close (DisableKeepAlives) makes net/http close the
	// connection as soon as it has replied, with the rest of the body unread, so the kernel
	// resets it and the client can see the reset before the refusal. A keep-alive request
	// takes the server's linger instead (a FIN, then 500 ms before the close), so the client
	// reads the refusal while it is still writing.
	refusing := http.DefaultTransport.(*http.Transport).Clone()
	defer refusing.CloseIdleConnections()
	sender := &http.Client{Transport: refusing, Timeout: 2 * time.Second}
	for _, chunked := range []bool{false, true} {
		req, _ := http.NewRequest("POST", base+"/body", strings.NewReader(strings.Repeat("x", 3<<20)))
		want := http.StatusRequestEntityTooLarge
		if chunked {
			req.ContentLength = -1
			req.TransferEncoding = []string{"chunked"}
			want = http.StatusBadRequest
		}
		res, err := sender.Do(req)
		if err != nil {
			t.Fatal("chunked", chunked, err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatal("oversized body, chunked", chunked, res.Status)
		}
	}
	if handled.Load() != 1 {
		t.Fatal("known oversized body reached handler", handled.Load())
	}
	req, _ := http.NewRequest("GET", base+"/health/live", nil)
	req.Header.Set("X-Large", strings.Repeat("x", 64<<10))
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 431 {
		t.Fatal(res.Status)
	}
	res, err = client.Post(base+"/body", "text/plain", strings.NewReader("small complete body"))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(body) != "read" || handled.Load() != 2 {
		t.Fatalf("follow-up POST: status=%s body=%q handled=%d err=%v", res.Status, body, handled.Load(), err)
	}
	res, err = client.Get(base + "/health/live")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("follow-up liveness failed", res.Status)
	}
}

func TestNativeProductionConfigurationAndDefaultProfile(t *testing.T) {
	t.Setenv("PROFILE", "matched")
	t.Setenv("PORT", "invalid-port")
	for _, bad := range []string{"0", "-1", "unlimited", "1.5"} {
		t.Setenv("MAX_CONNECTIONS", bad)
		if err := runGin(gin.New()); err == nil || !strings.Contains(err.Error(), "MAX_CONNECTIONS") {
			t.Fatalf("invalid connection setting %q: %v", bad, err)
		}
	}
	for _, bad := range []string{"", "*", "user@localhost", "localhost/", "localhost?", "localhost#", ":80", "localhost:bad", "localhost:70000"} {
		t.Setenv("HOSTS", bad)
		if configureProduction(gin.New()) == nil {
			t.Fatal("unsafe host configuration accepted", bad)
		}
	}
	t.Setenv("PROFILE", "defaults")
	t.Setenv("HOSTS", "*")
	r := gin.New()
	if err := configureProduction(r); err != nil {
		t.Fatal(err)
	}
	r.GET("/", func(c *gin.Context) { c.String(200, "native default") })
	req := httptest.NewRequest("GET", "http://unconfigured.invalid/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Content-Security-Policy") != "" || w.Header().Get("Content-Encoding") != "" {
		t.Fatal("default profile changed", w.Code, w.Header())
	}
}

func TestNativeProductionStreamPreserved(t *testing.T) {
	r := matchedRouter(t)
	live := newLivePrices()
	r.GET("/live/prices", live.stream)
	r.POST("/live/publish", live.publish)
	base := serveNativeProduction(t, r, 10, func(s *http.Server) { s.WriteTimeout = 50 * time.Millisecond })
	client := &http.Client{Timeout: 3 * time.Second}
	defer client.CloseIdleConnections()
	req, _ := http.NewRequest("GET", base+"/live/prices", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Encoding") != "" {
		t.Fatal("event stream compressed", res.Header)
	}
	reader := bufio.NewReader(res.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\n" {
			break
		}
	}
	time.Sleep(100 * time.Millisecond)
	published, err := client.Post(base+"/live/publish", "text/plain", strings.NewReader("native-event"))
	if err != nil {
		t.Fatal(err)
	}
	published.Body.Close()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal("native streaming lifecycle broke", err)
		}
		if strings.Contains(line, "native-event") {
			break
		}
	}
	res.Body.Close()
	end := time.Now().Add(2 * time.Second)
	for {
		live.mu.Lock()
		count := len(live.clients)
		live.mu.Unlock()
		if count == 0 {
			break
		}
		if time.Now().After(end) {
			t.Fatal(fmt.Sprintf("%d subscribers survived disconnect", count))
		}
		time.Sleep(time.Millisecond)
	}
}
