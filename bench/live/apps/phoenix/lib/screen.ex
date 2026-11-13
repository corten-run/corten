defmodule NativeLive.Screen do
  use Phoenix.LiveView, layout: false
  alias NativeLive.Store

  def mount(_, %{"client" => client}, socket) do
    if connected?(socket), do: :ok = Store.call({:connect, self(), client})

    {:ok,
     socket
     |> assign(client: client, through: 0, count: 0)
     |> stream_configure(:rows, dom_id: & &1["id"])
     |> stream(:rows, [])}
  end

  def handle_event("start", %{"from" => from, "initial" => initial}, socket) do
    ready = Store.call({:subscribe, self(), from, initial})
    socket = push_event(socket, "parity", Map.put(ready, :kind, "ready"))

    if initial do
      {:noreply, snapshot(socket)}
    else
      state = Store.call({:client, socket.assigns.client})
      {:noreply, socket |> replace(state) |> push_event("parity", %{kind: "restore"})}
    end
  end

  def handle_event("snapshot", _, socket), do: {:noreply, snapshot(socket)}

  def handle_event("acknowledge", _, socket) do
    :ok = Store.call({:ack, self()})
    {:noreply, socket}
  end

  def handle_event("finish", _, socket) do
    :ok = Store.call({:finish, self(), socket.assigns.client})
    {:noreply, push_event(socket, "parity", %{kind: "finished"})}
  end

  def handle_info({:parity_event, event, disposition, state}, socket) do
    socket =
      if disposition == "applied" do
        socket = assign(socket, through: state.through, count: state.count)

        if event["op"] == "remove",
          do: stream_delete_by_dom_id(socket, :rows, event["key"]),
          else: stream_insert(socket, :rows, event["row"])
      else
        socket
      end

    {:noreply,
     push_event(socket, "parity", %{kind: "event", event: event, disposition: disposition})}
  end

  def handle_info({:parity_overflow, resources}, socket) do
    {:noreply,
     push_event(socket, "parity", %{kind: "overflow", outcome: "resnapshot", resources: resources})}
  end

  defp snapshot(socket) do
    {snapshot, state} = Store.call({:snapshot, self(), socket.assigns.client})
    socket |> replace(state) |> push_event("parity", %{kind: "snapshot", snapshot: snapshot})
  end

  defp replace(socket, state) do
    socket
    |> assign(through: state.through, count: state.count)
    |> stream(:rows, Map.values(state.rows), reset: true)
  end

  def render(assigns) do
    ~H"""
    <main id="native-screen">
      <div id="native-controls" phx-hook="Parity"></div>
      <h1>Native Phoenix LiveView</h1>
      <noscript>This live screen requires JavaScript and a native LiveView connection.</noscript>
      <output id="effects" data-through={@through}>{@count}</output>
      <table>
        <thead>
          <tr>
            <th>Version</th><th>Price</th><th>Quantity</th>
          </tr>
        </thead>
        <tbody id="rows" phx-update="stream">
          <tr :for={{id, row} <- @streams.rows} id={id}>
            <td>{row["version"]}</td><td>{row["priceCents"]}</td><td>{row["quantity"]}</td>
          </tr>
        </tbody>
      </table>
    </main>
    """
  end
end
