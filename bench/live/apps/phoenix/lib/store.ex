defmodule NativeLive.Store do
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  def call(message), do: GenServer.call(__MODULE__, message)
  def init(_), do: {:ok, fresh()}

  defp fresh do
    %{
      rows: %{},
      through: 0,
      history: :queue.new(),
      history_count: 0,
      history_limit: 4,
      history_peak: 0,
      queue_limit: 2,
      queue_peak: 0,
      clients: %{},
      readers: %{},
      connections: %{},
      reads: 0,
      held: false,
      drop: nil
    }
  end

  def valid_row?(%{"id" => id} = row) when is_binary(id) do
    Regex.match?(~r/\A[a-zA-Z0-9_-]{1,100}\z/, id) &&
      Enum.all?(~w(version priceCents quantity), &is_integer(row[&1]))
  end

  def valid_row?(_), do: false

  defp valid_event?(
         %{"seq" => seq, "effectId" => effect, "key" => key, "op" => op} = event,
         expected
       ) do
    is_integer(seq) && seq == expected && is_binary(effect) && is_binary(key) &&
      Regex.match?(~r/\A[a-zA-Z0-9_-]{1,100}\z/, key) &&
      (op == "remove" || (op == "upsert" && valid_row?(event["row"]) && event["row"]["id"] == key))
  end

  defp valid_event?(_, _), do: false

  def handle_call(
        {:configure, %{"initial" => rows, "queueLimit" => q, "historyLimit" => h}},
        _,
        s
      ) do
    cond do
      map_size(s.connections) > 0 ->
        {:reply, {:error, "active readers"}, s}

      not is_list(rows) || length(rows) > 1000 || {q, h} not in [{2, 4}, {1024, 1025}] ->
        {:reply, {:error, "invalid configuration"}, s}

      not Enum.all?(rows, &valid_row?/1) || length(Enum.uniq_by(rows, & &1["id"])) != length(rows) ->
        {:reply, {:error, "invalid initial rows"}, s}

      true ->
        {:reply, :ok,
         %{fresh() | rows: Map.new(rows, &{&1["id"], &1}), queue_limit: q, history_limit: h}}
    end
  end

  def handle_call({:configure, _}, _, s), do: {:reply, {:error, "invalid configuration"}, s}

  def handle_call({:connect, pid, client}, _, s) do
    if map_size(s.connections) >= 16 ||
         (not Map.has_key?(s.clients, client) && map_size(s.clients) >= 16) do
      {:reply, {:error, "reader limit reached"}, s}
    else
      ref = Process.monitor(pid)
      s = put_in(s.connections[pid], %{ref: ref, client: client})
      s = update_in(s.clients, &Map.put_new(&1, client, %{through: 0, rows: %{}, count: 0}))
      {:reply, :ok, s}
    end
  end

  def handle_call({:subscribe, pid, from, initial}, _, s) do
    if Map.has_key?(s.connections, pid) && is_integer(from) && from >= 0 && from <= s.through do
      history = :queue.to_list(s.history)
      expired = from < s.through && (history == [] || from < hd(history)["seq"] - 1)
      replay = if initial || expired, do: [], else: Enum.filter(history, &(&1["seq"] >= from))

      reader = %{
        queue: :queue.new(),
        count: 0,
        replay: :queue.from_list(replay),
        inflight: false,
        overflowed: false
      }

      s = put_in(s.readers[pid], reader)

      {:reply,
       %{
         from: from,
         status: if(expired, do: "expired", else: "accepted"),
         resources: resources(s)
       }, s}
    else
      {:reply, {:error, "invalid reader or cursor"}, s}
    end
  end

  def handle_call({:client, client}, _, s), do: {:reply, Map.fetch!(s.clients, client), s}

  def handle_call(:snapshot, _, s) do
    {:reply, snapshot(s), %{s | reads: s.reads + 1}}
  end

  def handle_call({:snapshot, pid, client}, _, s) do
    snap = snapshot(s)
    state = %{Map.fetch!(s.clients, client) | through: s.through, rows: s.rows}
    s = put_in(s.clients[client], state)
    reader = Map.fetch!(s.readers, pid)

    s =
      put_in(s.readers[pid], %{
        reader
        | queue: :queue.new(),
          count: 0,
          replay: :queue.new(),
          inflight: true,
          overflowed: false
      })

    {:reply, {snap, state}, %{s | reads: s.reads + 1}}
  end

  def handle_call({:ack, pid}, _, s) do
    s = if Map.has_key?(s.readers, pid), do: put_in(s.readers[pid].inflight, false), else: s
    {:reply, :ok, pump(s, pid)}
  end

  def handle_call({:finish, pid, client}, _, s) do
    {:reply, :ok,
     %{s | readers: Map.delete(s.readers, pid), clients: Map.delete(s.clients, client)}}
  end

  def handle_call({:publish, data}, _, s) do
    events =
      case data do
        %{"event" => event} when not is_map_key(data, "events") -> [event]
        %{"events" => events} when not is_map_key(data, "event") -> events
        _ -> nil
      end

    valid =
      is_list(events) && length(events) in 1..1044 &&
        Enum.all?(Enum.with_index(events, 1), fn {event, index} ->
          valid_event?(event, s.through + index)
        end)

    if valid do
      {acks, next} =
        Enum.map_reduce(events, s, fn event, state ->
          state = publish(state, event)
          {%{seq: event["seq"], resources: resources(state)}, state}
        end)

      {:reply, if(Map.has_key?(data, "event"), do: hd(acks), else: %{acks: acks}), next}
    else
      {:reply, {:error, "invalid or nonconsecutive events"}, s}
    end
  end

  def handle_call({:control, %{"action" => "hold"}}, _, s), do: {:reply, :ok, %{s | held: true}}

  def handle_call({:control, %{"action" => "drop", "seq" => seq}}, _, s)
      when is_integer(seq) and seq > 0,
      do: {:reply, :ok, %{s | drop: seq}}

  def handle_call({:control, %{"action" => "duplicate"}}, _, s) do
    case :queue.peek_r(s.history) do
      {:value, event} -> {:reply, :ok, enqueue(s, event)}
      :empty -> {:reply, {:error, "no event"}, s}
    end
  end

  def handle_call({:control, _}, _, s), do: {:reply, {:error, "unknown control"}, s}
  def handle_call(:resources, _, s), do: {:reply, resources(s), s}

  def handle_info({:DOWN, ref, :process, pid, _reason}, s) do
    case s.connections[pid] do
      %{ref: ^ref} ->
        {:noreply,
         %{s | connections: Map.delete(s.connections, pid), readers: Map.delete(s.readers, pid)}}

      _ ->
        {:noreply, s}
    end
  end

  defp snapshot(s),
    do: %{through: s.through, rows: Map.values(s.rows), work: %{reads: 1, rows: map_size(s.rows)}}

  defp publish(s, event) do
    rows =
      if event["op"] == "remove",
        do: Map.delete(s.rows, event["key"]),
        else: Map.put(s.rows, event["key"], event["row"])

    history = if s.history_count == s.history_limit, do: :queue.drop(s.history), else: s.history
    count = min(s.history_count + 1, s.history_limit)

    s = %{
      s
      | rows: rows,
        through: event["seq"],
        history: :queue.in(event, history),
        history_count: count,
        history_peak: max(s.history_peak, count)
    }

    if event["seq"] == s.drop, do: s, else: enqueue(s, event)
  end

  defp enqueue(s, event) do
    s =
      Enum.reduce(Map.keys(s.readers), s, fn pid, state ->
        reader = state.readers[pid]

        cond do
          reader.overflowed ->
            state

          reader.count == state.queue_limit ->
            send(pid, {:parity_overflow, resources(state)})

            put_in(%{state | held: false}.readers[pid], %{
              reader
              | queue: :queue.new(),
                count: 0,
                replay: :queue.new(),
                inflight: true,
                overflowed: true
            })

          true ->
            state =
              put_in(state.readers[pid], %{
                reader
                | queue: :queue.in(event, reader.queue),
                  count: reader.count + 1
              })

            %{state | queue_peak: max(state.queue_peak, reader.count + 1)}
        end
      end)

    Enum.reduce(Map.keys(s.readers), s, &pump(&2, &1))
  end

  defp pump(s, pid) do
    case s.readers[pid] do
      %{inflight: false, overflowed: false} = reader when not s.held ->
        {event, reader} =
          case :queue.out(reader.replay) do
            {{:value, event}, rest} ->
              {event, %{reader | replay: rest}}

            {:empty, _} ->
              case :queue.out(reader.queue) do
                {{:value, event}, rest} ->
                  {event, %{reader | queue: rest, count: reader.count - 1}}

                {:empty, _} ->
                  {nil, reader}
              end
          end

        if event do
          client = s.connections[pid].client
          old = s.clients[client]

          {disposition, state} =
            cond do
              event["seq"] <= old.through ->
                {"duplicate", old}

              event["seq"] != old.through + 1 ->
                {"gap", old}

              true ->
                rows =
                  if event["op"] == "remove",
                    do: Map.delete(old.rows, event["key"]),
                    else: Map.put(old.rows, event["key"], event["row"])

                {"applied", %{old | through: event["seq"], rows: rows, count: old.count + 1}}
            end

          send(pid, {:parity_event, event, disposition, state})
          s = put_in(s.clients[client], state)
          put_in(s.readers[pid], %{reader | inflight: true})
        else
          s
        end

      _ ->
        s
    end
  end

  defp resources(s) do
    readers = Map.values(s.readers)

    %{
      subscriptions: map_size(s.readers),
      connections: map_size(s.connections),
      pendingTasks: map_size(s.readers),
      queueLimit: s.queue_limit,
      queueEvents: Enum.sum(Enum.map(readers, & &1.count)),
      queuePeak: s.queue_peak,
      historyLimit: s.history_limit,
      historyEvents: s.history_count,
      historyPeak: s.history_peak,
      process: %{
        osPid: System.pid(),
        otp: System.otp_release(),
        memoryBytes: :erlang.memory(:total),
        runtimeMilliseconds: elem(:erlang.statistics(:runtime), 0),
        processes: :erlang.system_info(:process_count)
      },
      inventory: %{
        inflightEvents: Enum.count(readers, & &1.inflight),
        inflightLimitPerReader: 1,
        overflowSlotsLimit: 1,
        replayCopyEvents: Enum.sum(Enum.map(readers, &:queue.len(&1.replay))),
        replayCopyLimitEvents: s.history_limit,
        snapshotReads: s.reads,
        sourceRows: map_size(s.rows),
        retainedClients: map_size(s.clients),
        retainedClientLimit: 16,
        retainedClientRows: Enum.sum(Enum.map(Map.values(s.clients), &map_size(&1.rows))),
        storeMailboxMessages: elem(Process.info(self(), :message_queue_len), 1),
        nativeSocketBufferBytes: "not-observable-through-LiveView-public-API"
      }
    }
  end
end
