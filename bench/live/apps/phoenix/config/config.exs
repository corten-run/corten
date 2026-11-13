import Config

config :native_live, NativeLive.Endpoint,
  url: [host: "127.0.0.1"],
  adapter: Bandit.PhoenixAdapter,
  pubsub_server: NativeLive.PubSub,
  live_view: [signing_salt: "native-live-session"],
  render_errors: [
    formats: [html: NativeLive.ErrorHTML, json: NativeLive.ErrorJSON],
    layout: false
  ],
  server: false,
  secret_key_base: String.duplicate("native-live-test-only-", 4)

config :phoenix, :json_library, Jason
config :logger, level: :warning

config :esbuild,
  version: "0.25.4",
  native_live: [
    args: ~w(client.js --bundle --target=es2022 --outfile=priv/static/client.js),
    cd: Path.expand("..", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]
