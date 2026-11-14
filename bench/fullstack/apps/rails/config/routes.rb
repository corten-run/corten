Rails.application.routes.draw do
  get "api/alerts", to: "marketplace#alerts"
  get "marketplace/:locale/:id", to: "marketplace#show", as: :marketplace
  post "marketplace/:locale/:id", to: "marketplace#show"
  get "api/marketplace/:id", to: "api/marketplace#show"
  root "items#home"
  get "items/:id", to: "items#show", as: :item
  post "items/:id", to: "items#alert"
  # The item as JSON for other services: the same data the page renders.
  get "api/items/:id", to: "api/items#show"
  get "catalog/:id", to: "catalog#show", as: :catalog
  get "api/catalog/:id", to: "api/catalog#show"
  # The live benchmark (bench/live): Action Cable serves /cable; this broadcasts to it.
  post "live/publish", to: "live#publish"
end
