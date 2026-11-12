defmodule ItemPageWeb.MarketplaceAlertLive do
  use ItemPageWeb, :live_view
  alias ItemPage.{Marketplace, MarketplaceAlerts, MarketplaceFormat}

  def mount(_params, session, socket) do
    {:ok,
     assign(socket,
       item_id: session["item_id"],
       locale: session["locale"],
       alert_session: session["alert_session"],
       message: session["message"],
       email: session["email"],
       target: session["target"],
       query: session["query"],
       t: MarketplaceFormat.labels(session["locale"]),
       csrf_token: session["csrf_token"]
     )}
  end

  def handle_event("save", params, socket) do
    record = Marketplace.get(socket.assigns.item_id) || raise ItemPageWeb.NotFound
    email = Map.get(params, "email", "")
    target = Map.get(params, "target_price", "")

    {message, minor} =
      MarketplaceFormat.alert_result(email, target, record["title"], socket.assigns.locale)

    if minor != nil do
      MarketplaceAlerts.append(socket.assigns.alert_session, %{
        item_id: record["id"],
        email: email,
        target_minor: minor
      })
    end

    {:noreply,
     assign(socket,
       message: message,
       email: if(is_binary(email), do: email, else: ""),
       target: if(is_binary(target), do: target, else: "")
     )}
  end

  def render(assigns) do
    ~H"""
    <section class="marketplace__alert">
      <h2>{@t["alert"]}</h2>
      <form method="post" action={~p"/marketplace/#{@locale}/#{@item_id}?#{@query}"} phx-submit="save">
        <input type="hidden" name="_csrf_token" value={@csrf_token} />
        <label>{@t["email"]} <input name="email" type="email" value={@email} /></label>
        <label>{@t["target"]}
        <input name="target_price" type="text" inputmode="decimal" value={@target} /></label>
        <button type="submit">{@t["submit"]}</button>
      </form>
      <p class="marketplace__message" aria-live="polite">{@message}</p>
    </section>
    """
  end
end
