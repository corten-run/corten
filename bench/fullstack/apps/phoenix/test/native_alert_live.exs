# Focused native component regression; can run against the compiled release with
# bin/item_page eval 'Code.eval_file("/checks/native_alert_live.exs")'.
{:ok, _} = Application.ensure_all_started(:item_page)
alias ItemPage.{MarketplaceAlerts, MarketplaceFormat}
alias ItemPageWeb.MarketplaceAlertLive

session_id = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

socket = %Phoenix.LiveView.Socket{
  assigns: %{
    __changed__: %{},
    item_id: "item_1",
    locale: "fr-FR",
    alert_session: session_id,
    email: "",
    target: "",
    message: ""
  }
}

{:noreply, saved} =
  MarketplaceAlertLive.handle_event(
    "save",
    %{"email" => "native@example.test", "target_price" => "12,50"},
    socket
  )

unless saved.assigns.email == "native@example.test" and saved.assigns.target == "12,50",
  do: raise("native LiveView discarded submitted form state")

expected = [%{item_id: "item_1", email: "native@example.test", target_minor: 1250}]
unless MarketplaceAlerts.list(session_id) == expected, do: raise("wrong native accepted readback")

{:noreply, rejected} =
  MarketplaceAlertLive.handle_event(
    "save",
    %{"email" => saved.assigns.email, "target_price" => "0"},
    saved
  )

unless rejected.assigns.message == MarketplaceFormat.labels("fr-FR")["invalid_price"] and
         rejected.assigns.email == saved.assigns.email and rejected.assigns.target == "0",
       do: raise("native LiveView did not retain rejected form state")

unless MarketplaceAlerts.list(session_id) == expected, do: raise("rejected native action mutated")
IO.puts("Native LiveView accepted/rejected form-state and independent readback regression passed")
