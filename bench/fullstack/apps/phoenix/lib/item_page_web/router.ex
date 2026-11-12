defmodule ItemPageWeb.Router do
  use ItemPageWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {ItemPageWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :marketplace_api do
    plug :accepts, ["json", "html"]
  end

  pipeline :alerts_api do
    plug :accepts, ["json", "html"]
    plug :fetch_session
  end

  scope "/", ItemPageWeb do
    pipe_through :browser

    get "/catalog/:id", CatalogController, :show
    get "/marketplace/:locale/:id", MarketplaceController, :show
    post "/marketplace/:locale/:id", MarketplaceController, :show

    live_session :default do
      live "/", HomeLive
      live "/items/:id", ItemLive
    end
  end

  # The item as JSON for other services: the same data the page renders.
  scope "/api", ItemPageWeb do
    pipe_through :api
    get "/items/:id", ItemJSONController, :show
    get "/catalog/:id", CatalogController, :json_record
  end

  scope "/api", ItemPageWeb do
    pipe_through :marketplace_api
    get "/marketplace/:id", MarketplaceController, :json_record
  end

  # The live benchmark's publisher: the JSON body goes to every "prices" subscriber.
  scope "/api", ItemPageWeb do
    pipe_through :alerts_api
    get "/alerts", MarketplaceController, :alerts
  end

  scope "/live", ItemPageWeb do
    pipe_through :api
    post "/publish", LivePublishController, :publish
  end
end
