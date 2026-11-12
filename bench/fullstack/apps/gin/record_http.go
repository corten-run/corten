package main

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func newRecordHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = transport.MaxIdleConns
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
