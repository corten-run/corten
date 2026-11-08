import Config

config :item_page, ItemPageWeb.Endpoint,
  server: false,
  secret_key_base: String.duplicate("marketplace-test-", 8)

config :logger, level: :warning
