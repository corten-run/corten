defmodule NativeLive.Endpoint do
  use Phoenix.Endpoint, otp_app: :native_live

  @session [
    store: :cookie,
    key: "_native_live",
    signing_salt: "native-cookie",
    same_site: "Lax",
    http_only: true
  ]
  socket "/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session]],
    longpoll: false

  plug Plug.Static, at: "/", from: :native_live, only: ~w(client.js)
  plug Plug.RequestId

  plug Plug.Parsers,
    parsers: [:urlencoded, :json],
    pass: ["application/json"],
    json_decoder: Jason

  plug Plug.Head
  plug Plug.Session, @session
  plug NativeLive.Router
end
