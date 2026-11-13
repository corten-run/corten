defmodule NativeLive.Session do
  import Plug.Conn
  def init(options), do: options

  def call(conn, _),
    do:
      put_session(
        conn,
        "client",
        Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
      )
end

defmodule NativeLive.Router do
  use Phoenix.Router
  import Plug.Conn
  import Phoenix.Controller
  import Phoenix.LiveView.Router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug NativeLive.Session
    plug :put_root_layout, html: {NativeLive.Layouts, :root}
  end

  scope "/" do
    pipe_through :browser
    live "/", NativeLive.Screen
  end

  # Synthetic publisher controls are not browser session actions.
  scope "/parity" do
    get "/snapshot", NativeLive.API, :snapshot
    get "/resources", NativeLive.API, :resources
    post "/configure", NativeLive.API, :configure
    post "/publish", NativeLive.API, :publish
    post "/control", NativeLive.API, :control
  end
end

defmodule NativeLive.API do
  use Phoenix.Controller, formats: [:json]
  import Plug.Conn
  plug :uncached

  defp uncached(conn, _), do: put_resp_header(conn, "cache-control", "no-store")

  def configure(conn, params) do
    case NativeLive.Store.call({:configure, params}) do
      :ok ->
        json(conn, %{
          configured: true,
          framework: "phoenix",
          version: Application.spec(:phoenix, :vsn) |> to_string()
        })

      error ->
        reply(conn, error)
    end
  end

  def snapshot(conn, _), do: reply(conn, NativeLive.Store.call(:snapshot))
  def resources(conn, _), do: reply(conn, NativeLive.Store.call(:resources))
  def publish(conn, params), do: reply(conn, NativeLive.Store.call({:publish, params}))

  def control(conn, params) do
    case NativeLive.Store.call({:control, params}) do
      :ok -> json(conn, %{resources: NativeLive.Store.call(:resources)})
      error -> reply(conn, error)
    end
  end

  defp reply(conn, {:error, reason}), do: conn |> put_status(400) |> json(%{error: reason})
  defp reply(conn, data), do: json(conn, data)
end

defmodule NativeLive.Layouts do
  use Phoenix.Component

  def root(assigns) do
    ~H"""
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="csrf-token" content={Plug.CSRFProtection.get_csrf_token()} />
        <title>Native Phoenix LiveView</title>
        <script defer type="module" src="/client.js">
        </script>
      </head>
      <body>{@inner_content}</body>
    </html>
    """
  end
end

defmodule NativeLive.ErrorHTML do
  def render(template, _), do: Phoenix.Controller.status_message_from_template(template)
end

defmodule NativeLive.ErrorJSON do
  def render(template, _), do: %{error: Phoenix.Controller.status_message_from_template(template)}
end
