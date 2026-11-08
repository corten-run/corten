package main

import (
	"context"
	"log"
	"net/http"

	"github.com/a-h/templ"
	"github.com/gin-gonic/gin"
)

// A templ component as a Gin render.
type page struct {
	ctx       context.Context
	component templ.Component
}

func (p page) Render(w http.ResponseWriter) error {
	return p.component.Render(p.ctx, w)
}

func (p page) WriteContentType(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
}

func render(c *gin.Context, status int, component templ.Component) {
	c.Render(status, page{c.Request.Context(), component})
}

func main() {
	// Load the fixture before the first request.
	items, err := newItemSource()
	if err != nil {
		log.Fatal(err)
	}
	live := newLivePrices()
	catalog, err := newCatalogSource()
	if err != nil {
		log.Fatal(err)
	}
	marketplace, err := newMarketplaceSource()
	if err != nil {
		log.Fatal(err)
	}

	r := gin.Default()
	r.StaticFile("/catalog.css", "static/catalog.css")
	catalog.routes(r)
	marketplace.routes(r)
	for _, name := range []string{"style.css", "components.css", "htmx.min.js", "item.js"} {
		r.StaticFile("/"+name, "static/"+name)
	}
	r.GET("/", func(c *gin.Context) {
		render(c, http.StatusOK, homePage(items.shelf()))
	})
	r.GET("/items/:id", func(c *gin.Context) {
		item, err := items.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusInternalServerError, err)
			return
		}
		if item == nil {
			render(c, http.StatusNotFound, notFoundPage())
			return
		}
		render(c, http.StatusOK, itemPage(item, c.Query("offers") == "all", ""))
	})
	r.POST("/items/:id", func(c *gin.Context) {
		item, err := items.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusInternalServerError, err)
			return
		}
		if item == nil {
			render(c, http.StatusNotFound, notFoundPage())
			return
		}
		message := alertMessage(c.PostForm("title"), c.PostForm("email"), c.PostForm("target_price"))
		// htmx swaps only the message; without JavaScript the whole page comes back.
		if c.GetHeader("HX-Request") != "" {
			render(c, http.StatusOK, alertMessageView(message))
			return
		}
		render(c, http.StatusOK, itemPage(item, false, message))
	})
	// The item as JSON for other services: the same data the page renders.
	r.GET("/api/items/:id", func(c *gin.Context) {
		item, err := items.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusInternalServerError, err)
			return
		}
		if item == nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.JSON(http.StatusOK, item)
	})
	// The live benchmark (bench/live): server-sent events, and the publisher that feeds them.
	r.GET("/live/prices", live.stream)
	r.POST("/live/publish", live.publish)
	r.NoRoute(func(c *gin.Context) {
		render(c, http.StatusNotFound, notFoundPage())
	})
	if err := r.Run(":" + envOr("PORT", "8080")); err != nil {
		log.Fatal(err)
	}
}
