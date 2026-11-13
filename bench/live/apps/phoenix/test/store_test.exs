ExUnit.start()

defmodule NativeLive.StoreTest do
  use ExUnit.Case, async: false
  alias NativeLive.Store
  import Plug.Conn

  defp row(id \\ "a"), do: %{"id" => id, "version" => 1, "priceCents" => 100, "quantity" => 2}

  defp event(seq),
    do: %{
      "seq" => seq,
      "effectId" => "write-#{seq}",
      "key" => "a",
      "op" => "upsert",
      "row" => %{row() | "version" => seq}
    }

  defp publish(seq), do: Store.call({:publish, %{"event" => event(seq)}})

  defp reader(client \\ "browser") do
    :ok = Store.call({:connect, self(), client})
    Store.call({:subscribe, self(), 0, true})
    Store.call({:snapshot, self(), client})
    Store.call({:ack, self()})
  end

  setup do
    # The previous test's monitored process is dead before the next configuration.
    wait_empty(100)

    :ok =
      Store.call({:configure, %{"initial" => [row()], "queueLimit" => 2, "historyLimit" => 4}})

    :ok
  end

  defp wait_empty(0), do: assert(Store.call(:resources).connections == 0)

  defp wait_empty(n) do
    if Store.call(:resources).connections > 0 do
      Process.sleep(5)
      wait_empty(n - 1)
    end
  end

  test "authoritative independent snapshots count actual reads without resetting rows" do
    assert publish(1).seq == 1

    assert %{through: 1, rows: [%{"version" => 1}], work: %{reads: 1, rows: 1}} =
             Store.call(:snapshot)

    assert Store.call(:snapshot).through == 1
    assert Store.call(:resources).inventory.snapshotReads == 2
  end

  test "invalid single and complete bulk validation precede every mutation" do
    for data <- [
          %{"event" => event(2)},
          %{"event" => %{event(1) | "seq" => 1.0}},
          %{"events" => []},
          %{"event" => event(1), "events" => [event(1)]},
          %{"events" => [event(1), event(3)]},
          %{"events" => [event(1), Map.put(event(2), "row", %{})]}
        ] do
      assert {:error, _} = Store.call({:publish, data})
      assert Store.call(:snapshot).through == 0
      assert Store.call(:resources).historyEvents == 0
    end

    assert %{acks: [%{seq: 1}, %{seq: 2}]} =
             Store.call({:publish, %{"events" => [event(1), event(2)]}})

    assert Store.call(:snapshot).through == 2
  end

  test "concurrent native publishers serialize and reject duplicate sequence without extra work" do
    results =
      1..20
      |> Task.async_stream(fn _ -> publish(1) end, max_concurrency: 20)
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(results, &match?(%{seq: 1}, &1)) == 1
    assert Enum.count(results, &match?({:error, _}, &1)) == 19
    assert Store.call(:resources).historyEvents == 1
    assert Store.call(:snapshot).through == 1
  end

  test "native application state suppresses duplicate and gap effects, resnapshot preserves counter" do
    reader()
    publish(1)
    assert_receive {:parity_event, _, "applied", %{through: 1, count: 1}}
    Store.call({:ack, self()})
    :ok = Store.call({:control, %{"action" => "duplicate"}})
    assert_receive {:parity_event, _, "duplicate", %{through: 1, count: 1}}
    Store.call({:ack, self()})
    Store.call({:control, %{"action" => "drop", "seq" => 2}})
    publish(2)
    publish(3)
    assert_receive {:parity_event, %{"seq" => 3}, "gap", %{through: 1, count: 1}}
    assert {%{through: 3}, %{count: 1}} = Store.call({:snapshot, self(), "browser"})
  end

  test "held actual consumer reaches bounded queue and reports saturation before resnapshot" do
    reader()
    Store.call({:control, %{"action" => "hold"}})
    publish(1)
    assert publish(2).resources.queueEvents == 2
    publish(3)
    assert_receive {:parity_overflow, %{queueEvents: 2, queuePeak: 2}}
    assert Store.call(:resources).queueEvents == 0
    assert Store.call(:resources).queuePeak == 2
    assert {%{through: 3}, %{count: 0}} = Store.call({:snapshot, self(), "browser"})
  end

  test "replay copy is history bounded and expired cursor is actually detected" do
    for n <- 1..6, do: publish(n)
    :ok = Store.call({:connect, self(), "browser"})
    assert %{status: "expired"} = Store.call({:subscribe, self(), 1, false})
    assert %{status: "accepted"} = Store.call({:subscribe, self(), 4, false})
    assert Store.call(:resources).inventory.replayCopyEvents == 3
    Store.call({:ack, self()})
    assert_receive {:parity_event, %{"seq" => 4}, "gap", _}
    assert Store.call(:resources).historyPeak == 4
    assert Store.call(:resources).historyEvents == 4
  end

  test "four independently monitored native readers retain separate application state and clean up" do
    parent = self()

    readers =
      for n <- 1..4 do
        spawn(fn ->
          reader("browser-#{n}")
          send(parent, {:ready, self()})

          receive do
            {:parity_event, %{"seq" => 1}, "applied", %{count: 1}} ->
              send(parent, {:applied, self()})
          end

          receive do
            :stop -> :ok
          end
        end)
      end

    for pid <- readers, do: assert_receive({:ready, ^pid})
    assert Store.call(:resources).connections == 4
    publish(1)
    for pid <- readers, do: assert_receive({:applied, ^pid})
    for pid <- readers, do: send(pid, :stop)
    wait_empty(100)
    assert Store.call(:resources).subscriptions == 0
    assert Store.call(:resources).pendingTasks == 0
  end

  test "actual Phoenix HTTP routes reject malformed publication, accept bulk and render native stream markup" do
    request = fn method, path, data ->
      Phoenix.ConnTest.build_conn()
      |> put_req_header("content-type", "application/json")
      |> Phoenix.ConnTest.dispatch(NativeLive.Endpoint, method, path, Jason.encode!(data))
    end

    assert request.(:post, "/parity/publish", %{"events" => [event(1), event(3)]}).status == 400
    response = request.(:post, "/parity/publish", %{"events" => [event(1), event(2)]})
    assert response.status == 200
    assert %{"acks" => [%{"seq" => 1}, %{"seq" => 2}]} = Jason.decode!(response.resp_body)
    assert request.(:post, "/parity/control", %{"action" => "hold"}).status == 200

    home =
      Phoenix.ConnTest.dispatch(
        Phoenix.ConnTest.build_conn(),
        NativeLive.Endpoint,
        :get,
        "/",
        nil
      )

    assert home.status == 200
    assert home.resp_body =~ "phx-update=\"stream\""
    assert home.resp_body =~ "data-phx-session="
    assert home.resp_body =~ "csrf-token"
  end
end
