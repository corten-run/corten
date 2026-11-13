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
    Store.call({:subscribe, self(), 0, true, nil})
    {snapshot, _} = Store.call({:snapshot, self(), client})
    ack(snapshot.through, 0)
  end

  defp observed(through, count),
    do: %{"through" => through, "effectCount" => count, "rowCount" => 1}

  defp ack(through, count), do: Store.call({:ack, self(), observed(through, count)})

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
    assert Store.call(:resources).inventory.nativeSocketBufferBytes == nil
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
    assert Store.call({:client, "browser"}).count == 0
    ack(1, 1)
    :ok = Store.call({:control, %{"action" => "duplicate"}})
    assert_receive {:parity_event, _, "duplicate", %{through: 1, count: 1}}
    ack(1, 1)
    Store.call({:control, %{"action" => "drop", "seq" => 2}})
    publish(2)
    publish(3)
    assert_receive {:parity_event, %{"seq" => 3}, "gap", %{through: 1, count: 1}}

    assert {%{through: 3}, %{count: 1}} =
             Store.call({:snapshot, self(), "browser", observed(1, 1)})
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

    assert {%{through: 3}, %{count: 0}} =
             Store.call({:snapshot, self(), "browser", observed(0, 0)})
  end

  test "overflow snapshot reconciles only acknowledged or staged browser observations" do
    reader()
    publish(1)
    assert_receive {:parity_event, _, "applied", %{through: 1, count: 1}}
    Store.call({:publish, %{"events" => Enum.map(2..4, &event/1)}})
    assert_receive {:parity_overflow, %{queueEvents: 2}}
    reads = Store.call(:resources).inventory.snapshotReads

    for forged <- [nil, observed(1, 99), observed(4, 4), Map.put(observed(1, 1), "rowCount", 2)] do
      assert {:error, _} = Store.call({:snapshot, self(), "browser", forged})
    end

    assert Store.call(:resources).inventory.snapshotReads == reads
    assert Store.call({:client, "browser"}).pending.count == 1

    assert {%{through: 4}, %{count: 1}} =
             Store.call({:snapshot, self(), "browser", observed(1, 1)})

    ack(4, 1)
    Store.call({:control, %{"action" => "duplicate"}})
    assert_receive {:parity_event, _, "duplicate", %{count: 1}}
    ack(4, 1)
    publish(5)
    assert_receive {:parity_event, _, "applied", %{count: 2}}
  end

  test "snapshot does not count a staged delivery the browser did not observe" do
    reader()
    publish(1)
    assert_receive {:parity_event, _, "applied", _}
    Store.call({:publish, %{"events" => Enum.map(2..4, &event/1)}})
    assert_receive {:parity_overflow, _}

    assert {%{through: 4}, %{count: 0}} =
             Store.call({:snapshot, self(), "browser", observed(0, 0)})

    ack(4, 0)
  end

  test "replay copy is history bounded and expired cursor is actually detected" do
    publish(1)
    reader()
    # Snapshot at sequence one was actually acknowledged before the outage.
    ack(1, 0)
    for n <- 2..6, do: publish(n)
    assert %{status: "expired"} = Store.call({:subscribe, self(), 1, false, observed(1, 0)})
    Store.call({:snapshot, self(), "browser", observed(1, 0)})
    ack(6, 0)
    publish(7)
    publish(8)
    assert %{status: "accepted"} = Store.call({:subscribe, self(), 6, false, observed(6, 0)})
    assert Store.call(:resources).inventory.replayCopyEvents == 3
    ack(6, 0)
    assert_receive {:parity_event, %{"seq" => 6}, "duplicate", _}
    assert Store.call(:resources).historyPeak == 4
    assert Store.call(:resources).historyEvents == 4
  end

  test "dropped native delivery replays against acknowledged state, not the staged effect" do
    reader()
    publish(1)
    assert_receive {:parity_event, _, "applied", %{count: 1}}
    assert Store.call({:client, "browser"}).count == 0
    assert {:error, _} = ack(1, 0)
    assert %{status: "accepted"} = Store.call({:subscribe, self(), 0, false, observed(0, 0)})
    ack(0, 0)
    assert_receive {:parity_event, _, "applied", %{count: 1}}
    ack(1, 1)
    assert Store.call({:client, "browser"}).count == 1
  end

  test "lost native acknowledgement reconciles the actual browser cursor and effect count" do
    reader()
    publish(1)
    assert_receive {:parity_event, _, "applied", %{count: 1}}
    assert %{status: "accepted"} = Store.call({:subscribe, self(), 1, false, observed(1, 1)})
    assert Store.call({:client, "browser"}).count == 1
    ack(1, 1)
    assert_receive {:parity_event, _, "duplicate", %{count: 1}}
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

  test "native publication credit pauses actual delivery without skipping the authoritative write" do
    reader()
    :ok = Store.call({:pause, self(), true})
    assert publish(1).seq == 1
    assert Store.call(:snapshot).through == 1
    assert Store.call(:resources).queueEvents == 1
    assert Store.call(:resources).inventory.pausedConsumers == 1
    refute_receive {:parity_event, _, _, _}, 20
    :ok = Store.call({:pause, self(), false})
    assert_receive {:parity_event, _, "applied", %{through: 1, count: 1}}
    assert Store.call({:client, "browser"}).count == 0
    ack(1, 1)
    assert Store.call({:client, "browser"}).count == 1
    assert Store.call(:resources).inventory.pausedConsumers == 0
  end

  test "per-consumer cleanup leaves a monitored peer connected and receiving" do
    parent = self()

    readers =
      for id <- ["one", "peer"] do
        spawn(fn ->
          reader(id)
          send(parent, {:ready, self()})

          receive do
            :stop ->
              :ok

            {:parity_event, event, disposition, state} ->
              send(parent, {:delivery, id, event, disposition, state.count})
              receive do: (:stop -> :ok)
          end
        end)
      end

    for pid <- readers, do: assert_receive({:ready, ^pid})
    [one, peer] = readers
    ref = Process.monitor(one)
    send(one, :stop)
    assert_receive {:DOWN, ^ref, :process, ^one, _}
    wait_consumer_empty("one", 100)
    resources = Store.call(:resources)
    assert resources.connections == 1
    assert resources.subscriptions == 1
    assert resources.inventory.consumers["peer"].connections == 1
    publish(1)
    assert_receive {:delivery, "peer", %{"seq" => 1}, "applied", 1}
    send(peer, :stop)
    wait_empty(100)
  end

  defp wait_consumer_empty(id, attempts) do
    owned = Store.call(:resources).inventory.consumers[id]

    if owned.connections > 0 do
      assert attempts > 0
      Process.sleep(5)
      wait_consumer_empty(id, attempts - 1)
    else
      assert owned.subscriptions == 0
      assert owned.pendingTasks == 0
      assert owned.queueEvents == 0
    end
  end
end
