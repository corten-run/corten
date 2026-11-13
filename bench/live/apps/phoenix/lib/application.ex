defmodule NativeLive.Application do
  use Application

  def start(_type, _args) do
    Supervisor.start_link(
      [
        {Phoenix.PubSub, name: NativeLive.PubSub},
        NativeLive.Store,
        NativeLive.Endpoint
      ],
      strategy: :one_for_one,
      name: NativeLive.Supervisor
    )
  end
end
