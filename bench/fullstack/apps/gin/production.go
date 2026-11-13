package main

import (
	"compress/gzip"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/netutil"
)

const productionBodyLimit = 2 << 20

type allowedAuthority struct{ host, port string }

func parseAuthority(value string) (allowedAuthority, error) {
	u, err := url.Parse("http://" + value)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Path != "" || strings.ContainsAny(value, "*/?#\\ \t\r\n") || strings.HasSuffix(value, ":") {
		return allowedAuthority{}, fmt.Errorf("invalid host authority")
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return allowedAuthority{}, fmt.Errorf("invalid host port")
		}
	}
	return allowedAuthority{strings.ToLower(strings.TrimSuffix(u.Hostname(), ".")), u.Port()}, nil
}

func configureProduction(r *gin.Engine) error {
	if os.Getenv("PROFILE") != "matched" {
		return nil
	}
	configured, present := os.LookupEnv("HOSTS")
	if !present {
		configured = "localhost,127.0.0.1,[::1]"
	}
	var hosts []allowedAuthority
	for _, value := range strings.Split(configured, ",") {
		host, err := parseAuthority(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("HOSTS: %w", err)
		}
		hosts = append(hosts, host)
	}
	if err := r.SetTrustedProxies(nil); err != nil {
		return err
	}
	r.Use(func(c *gin.Context) {
		c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Cross-Origin-Opener-Policy", "same-origin")
		c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		c.Header("Cache-Control", "no-store")
		requested, err := parseAuthority(c.Request.Host)
		allowed := false
		if err == nil {
			for _, host := range hosts {
				if requested.host == host.host && (host.port == "" || requested.port == host.port) {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			c.AbortWithStatus(http.StatusMisdirectedRequest)
			return
		}
		if c.Request.ContentLength > productionBodyLimit {
			c.AbortWithStatus(http.StatusRequestEntityTooLarge)
			return
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, productionBodyLimit)
		}
		c.Next()
	}, productionGzip())
	r.GET("/health/live", func(c *gin.Context) { c.String(http.StatusOK, "ok\n") })
	return nil
}

func productionHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
}

func runGin(r *gin.Engine) error {
	addr := ":" + envOr("PORT", "8080")
	if os.Getenv("PROFILE") != "matched" {
		return r.Run(addr)
	}
	limit, err := strconv.Atoi(envOr("MAX_CONNECTIONS", "1000"))
	if err != nil || limit < 1 {
		return fmt.Errorf("MAX_CONNECTIONS must be a positive integer")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	return productionHTTPServer(addr, r).Serve(netutil.LimitListener(listener, limit))
}

func acceptsGzip(value string) bool {
	explicit, wildcard := -1.0, -1.0
	for _, item := range strings.Split(value, ",") {
		encoding, params, err := mime.ParseMediaType(strings.TrimSpace(item))
		if err != nil {
			continue
		}
		quality := 1.0
		if text, ok := params["q"]; ok {
			quality, err = strconv.ParseFloat(text, 64)
			if err != nil || !(quality >= 0 && quality <= 1) {
				continue
			}
		}
		switch strings.ToLower(encoding) {
		case "gzip":
			explicit = quality
		case "*":
			wildcard = quality
		}
	}
	if explicit >= 0 {
		return explicit > 0
	}
	return wildcard > 0
}

type gzipResponse struct {
	gin.ResponseWriter
	compressed *gzip.Writer
	started    bool
}

func (w *gzipResponse) prepare(data []byte) {
	if w.started {
		return
	}
	w.started = true
	if w.Written() || w.Status() < 200 || w.Status() == 204 || w.Status() == 304 || w.Header().Get("Content-Encoding") != "" {
		return
	}
	contentType := w.Header().Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(data)
		w.Header().Set("Content-Type", contentType)
	}
	media, _, _ := mime.ParseMediaType(contentType)
	if media == "text/event-stream" || !(strings.HasPrefix(media, "text/") || media == "application/json" || media == "application/javascript") {
		return
	}
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Encoding", "gzip")
	w.compressed = gzip.NewWriter(w.ResponseWriter)
}
func (w *gzipResponse) Write(data []byte) (int, error) {
	w.prepare(data)
	if w.compressed != nil {
		return w.compressed.Write(data)
	}
	return w.ResponseWriter.Write(data)
}
func (w *gzipResponse) WriteString(data string) (int, error) { return w.Write([]byte(data)) }
func (w *gzipResponse) WriteHeaderNow()                      { w.prepare(nil); w.ResponseWriter.WriteHeaderNow() }
func (w *gzipResponse) Flush() {
	w.prepare(nil)
	if w.compressed != nil {
		_ = w.compressed.Flush()
	}
	w.ResponseWriter.Flush()
}
func (w *gzipResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func productionGzip() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Add("Vary", "Accept-Encoding")
		if !acceptsGzip(c.GetHeader("Accept-Encoding")) || c.Request.Method == http.MethodHead || c.GetHeader("Range") != "" || c.GetHeader("Upgrade") != "" {
			c.Next()
			return
		}
		original := c.Writer
		writer := &gzipResponse{ResponseWriter: original}
		c.Writer = writer
		defer func() {
			if writer.compressed != nil {
				_ = writer.compressed.Close()
			}
			c.Writer = original
		}()
		c.Next()
	}
}
