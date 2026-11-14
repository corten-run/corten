defmodule ItemPage.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    # The fixture (ITEM_SOURCE=fixture) is loaded before the endpoint takes requests.
    :ok = ItemPage.Items.load_fixture()
    :ok = ItemPage.Catalog.load_fixture()
    :ok = ItemPage.Marketplace.load_fixture()

    children = [
      ItemPage.MarketplaceAlerts,
      ItemPageWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:item_page, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: ItemPage.PubSub},
      # The item API's client pool. Req's own starts with Finch's 50 connections per host; the
      # other apps' clients have no per-host cap, so this one holds more than the profile has in
      # flight (256 users in the closed phases, up to 1,000 in the fixed phase); only an app more
      # than 1,024 requests behind in the mixed phase, already a failed phase, could reach it.
      # Finch opens them only as they are needed.
      {Finch, name: ItemPage.Finch, pools: %{default: [size: 1024]}},
      # Start a worker by calling: ItemPage.Worker.start_link(arg)
      # {ItemPage.Worker, arg},
      # Start to serve requests, typically the last entry
      ItemPageWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: ItemPage.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    ItemPageWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
