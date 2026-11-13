require "thread"

module NativeStore
  @mutex = Mutex.new
  @publication = Mutex.new
  @rows = {}
  @clients = {}
  @readers = {}
  @connections = {}
  @history = []
  @through = @queue_peak = @history_peak = @reads = 0
  @queue_limit, @history_limit = 2, 4
  @held = false
  @drop = nil

  class << self
    def configure(data)
      initial = data["initial"]
      bounds = [data["queueLimit"], data["historyLimit"]]
      raise ArgumentError, "invalid configuration" unless initial.is_a?(Array) && initial.size <= 1000 && [[2, 4], [1024, 1025]].include?(bounds)
      raise ArgumentError, "invalid rows" unless initial.all? { |row| valid_row?(row) } && initial.map { |r| r["id"] }.uniq.size == initial.size
      @mutex.synchronize do
        raise ArgumentError, "active readers" unless @connections.empty? && @readers.empty?
        @rows = initial.to_h { |row| [row["id"], row.freeze] }
        @history, @clients = [], {}
        @through = @queue_peak = @history_peak = @reads = 0
        @queue_limit, @history_limit = bounds
        @held, @drop = false, nil
      end
    end

    def valid_row?(row)
      row.is_a?(Hash) && row["id"].is_a?(String) && row["id"].match?(/\A[a-zA-Z0-9_-]{1,100}\z/) && %w[version priceCents quantity].all? { |key| row[key].is_a?(Integer) }
    end

    def connection(connection)
      @mutex.synchronize { @connections[connection] = true }
    end

    def disconnection(connection)
      @mutex.synchronize { @connections.delete(connection) }
    end

    def subscribe(channel, client, from, initial)
      @mutex.synchronize do
        raise ArgumentError, "invalid cursor" unless from.is_a?(Integer) && from.between?(0, @through)
        raise ArgumentError, "reader limit reached" if @readers.size >= 16
        raise ArgumentError, "retained client limit reached" unless @clients.key?(client) || @clients.size < 16
        expired = from < @through && (@history.empty? || from < @history.first["seq"] - 1)
        replay = initial || expired ? [] : @history.select { |event| event["seq"] >= from }
        @readers[channel] = { queue: [], replay: replay, inflight: false, overflowed: false }
        @clients[client] ||= { through: 0, rows: {}, count: 0 }
        { from: from, status: expired ? "expired" : "accepted", resources: resources_locked }
      end
    end

    def unsubscribe(channel)
      @mutex.synchronize { @readers.delete(channel) }
    end

    def finish(channel, client)
      @mutex.synchronize do
        @readers.delete(channel)
        @clients.delete(client)
      end
    end

    def client(client)
      @mutex.synchronize { @clients.fetch(client).then { |s| s.merge(rows: s[:rows].dup) } }
    end

    def snapshot
      @mutex.synchronize do
        @reads += 1
        { through: @through, rows: @rows.values, work: { reads: 1, rows: @rows.size } }
      end
    end

    def replace_client(client, snapshot)
      @mutex.synchronize do
        state = @clients.fetch(client)
        state[:rows] = snapshot[:rows].to_h { |row| [row["id"], row] }
        state[:through] = snapshot[:through]
      end
    end

    def snapshot_client(channel, client)
      @mutex.synchronize do
        @reads += 1
        snapshot = { through: @through, rows: @rows.values, work: { reads: 1, rows: @rows.size } }
        @clients.fetch(client).merge!(through: @through, rows: @rows.dup)
        reader = @readers.fetch(channel)
        reader[:queue].clear
        reader[:replay].clear
        reader[:inflight] = true
        reader[:overflowed] = false
        snapshot
      end
    end

    def apply(client, event)
      @mutex.synchronize do
        state = @clients.fetch(client)
        disposition = if event["seq"] <= state[:through]
          "duplicate"
        elsif event["seq"] != state[:through] + 1
          "gap"
        else
          inserted = !state[:rows].key?(event["key"])
          event["op"] == "remove" ? state[:rows].delete(event["key"]) : state[:rows][event["key"]] = event["row"]
          state[:through] = event["seq"]
          state[:count] += 1
          state[:inserted] = inserted
          "applied"
        end
        [disposition, state.merge(rows: state[:rows].dup)]
      end
    end

    def publish(event)
      @publication.synchronize { publish_serial(event) }
    end

    def valid_event?(event, expected)
      event.is_a?(Hash) && event["seq"].is_a?(Integer) && event["seq"] == expected &&
        event["effectId"].is_a?(String) && event["key"].is_a?(String) &&
        %w[remove upsert].include?(event["op"]) &&
        (event["op"] == "remove" || valid_row?(event["row"]) && event["row"]["id"] == event["key"])
    end

    def publish_many(events)
      @publication.synchronize do
        @mutex.synchronize do
          raise ArgumentError, "invalid events" unless events.is_a?(Array) && events.size.between?(1, 1044) &&
            events.each_with_index.all? { |event, index| valid_event?(event, @through + index + 1) }
        end
        events.map do |event|
          publish_serial(event)
          { seq: event.fetch("seq"), resources: resources }
        end
      end
    end

    def publish_serial(event)
      @mutex.synchronize do
        raise ArgumentError, "invalid event" unless valid_event?(event, @through + 1)
        event.freeze
        @through = event["seq"]
        event["op"] == "remove" ? @rows.delete(event["key"]) : @rows[event["key"]] = event["row"].freeze
        @history.shift if @history.size == @history_limit
        @history << event
        @history_peak = [@history_peak, @history.size].max
      end
      enqueue(event) unless event["seq"] == @drop
    end

    def enqueue(event)
      overflow = []
      channels = @mutex.synchronize do
        @readers.each do |channel, reader|
          next if reader[:overflowed]
          if reader[:queue].size == @queue_limit
            overflow << [channel, resources_locked]
            reader[:queue].clear
            reader[:replay].clear
            reader[:inflight] = true
            reader[:overflowed] = true
            @held = false
          else
            reader[:queue] << event
            @queue_peak = [@queue_peak, reader[:queue].size].max
          end
        end
        @readers.keys
      end
      overflow.each { |channel, resource| channel.overflow(resource) }
      channels.each { |channel| pump(channel) }
    end

    def pump(channel)
      event = @mutex.synchronize do
        reader = @readers[channel]
        next unless reader && !@held && !reader[:inflight]
        pending = reader[:replay].shift || reader[:queue].shift
        reader[:inflight] = true if pending
        pending
      end
      channel.deliver(event) if event
    end

    def acknowledge(channel)
      @mutex.synchronize { @readers[channel][:inflight] = false if @readers[channel] }
      pump(channel)
    end

    def control(data)
      case data["action"]
      when "hold" then @mutex.synchronize { @held = true }
      when "drop" then @mutex.synchronize { @drop = data.fetch("seq") }
      when "duplicate"
        event = @mutex.synchronize { @history.last }
        raise ArgumentError, "no event" unless event
        enqueue(event)
      else raise ArgumentError, "unknown action"
      end
    end

    def resources
      @mutex.synchronize { resources_locked }
    end

    def resources_locked
      { subscriptions: @readers.size, connections: @connections.size, pendingTasks: @readers.size,
        queueLimit: @queue_limit, queueEvents: @readers.values.sum { |r| r[:queue].size }, queuePeak: @queue_peak,
        historyLimit: @history_limit, historyEvents: @history.size, historyPeak: @history_peak,
        process: { pid: Process.pid, ruby: RUBY_VERSION, cpu: Process.times.to_h, gc: GC.stat },
        inventory: { applicationQueues: @readers.size, inflightEvents: @readers.values.count { |r| r[:inflight] },
          inflightLimitPerReader: 1, overflowSlotsLimit: 1, replayCopyEvents: @readers.values.sum { |r| r[:replay].size },
          replayCopyLimitEvents: @history_limit, snapshotReads: @reads, sourceRows: @rows.size,
          retainedClientRows: @clients.values.sum { |c| c[:rows].size }, retainedClients: @clients.size, retainedClientLimit: 16,
          nativeActionCableWorkerPool: ActionCable.server.config.worker_pool_size,
          nativeSocketBufferBytes: "not-observable-through-ActionCable-public-API" } }
    end
  end
end
