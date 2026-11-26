package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func recordSourceStatus(err error) int {
	if errors.Is(err, context.Canceled) {
		return http.StatusRequestTimeout
	}
	var timed net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timed) && timed.Timeout() {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

func abortRecordPage(c *gin.Context, err error) {
	status := recordSourceStatus(err)
	c.Header("Cache-Control", "no-store")
	_ = c.Error(err)
	c.Abort()
	render(c, status, sourceErrorPage(http.StatusText(status)))
}

// upstreamIdle is how long a connection to an upstream (the catalog, marketplace and item API
// fixtures, all Node HTTP servers) may sit idle in the pool before a request opens a new one
// instead. Each answers `Keep-Alive: timeout=5` and closes a connection idle for those 5 s plus
// Node's 1 s buffer; a request written to a pooled connection as it closes is lost (the transport's
// default keeps an idle connection 90 s). The pool drops one a second under what the upstream
// advertises. It adds no retry: each read is still one upstream GET.
const upstreamIdle = 4 * time.Second

func newRecordHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = transport.MaxIdleConns
	transport.IdleConnTimeout = upstreamIdle
	return &http.Client{
		Transport: transport,
		// Bounds the entire read, including response headers and JSON body decoding.
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func recordJSONMethods(r *gin.Engine) {
	r.HandleMethodNotAllowed = true
	r.NoMethod(func(c *gin.Context) {
		// Gin has already matched this path to a route for another method.
		if strings.HasPrefix(c.Request.URL.Path, "/api/catalog/") || strings.HasPrefix(c.Request.URL.Path, "/api/marketplace/") {
			c.Header("Allow", "GET, HEAD")
			c.Header("Cache-Control", "no-store")
			c.AbortWithStatusJSON(http.StatusMethodNotAllowed, gin.H{"error": "method not allowed"})
			return
		}
		// Preserve main's NoRoute representation for non-JSON routes.
		c.Header("Allow", "")
		render(c, http.StatusNotFound, notFoundPage())
	})
}
