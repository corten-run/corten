import Config

if config_env() == :prod do
  config :native_live, NativeLive.Endpoint,
    server: System.get_env("PHX_SERVER") == "true",
    url: [host: System.get_env("PHX_HOST", "127.0.0.1")],
    http: [ip: {0, 0, 0, 0}, port: String.to_integer(System.get_env("PORT", "8080"))],
    secret_key_base:
      System.get_env("SECRET_KEY_BASE") || Base.encode64(:crypto.strong_rand_bytes(64))
end
