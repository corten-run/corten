defmodule ItemPage.MarketplaceAlerts do
  use Agent

  def start_link(_), do: Agent.start_link(fn -> %{} end, name: __MODULE__)

  def append(session_id, alert) do
    Agent.update(__MODULE__, fn sessions ->
      Map.update(sessions, session_id, [alert], &[alert | &1])
    end)
  end

  def list(session_id) do
    Agent.get(__MODULE__, fn sessions -> sessions |> Map.get(session_id, []) |> Enum.reverse() end)
  end
end
