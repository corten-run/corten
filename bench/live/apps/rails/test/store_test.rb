require "minitest/autorun"
require_relative "../application"

class NativeStoreTest < Minitest::Test
  class Reader
    attr_reader :events, :overflows
    def initialize
      @events, @overflows = [], []
    end
    def deliver(event)
      @events << event
    end
    def overflow(resources)
      @overflows << resources
    end
  end

  def row(version = 0)
    { "id" => "row_1", "version" => version, "priceCents" => 100, "quantity" => 1 }
  end

  def event(seq)
    { "seq" => seq, "effectId" => "effect_#{seq}", "key" => "row_1", "op" => "upsert", "row" => row(seq) }
  end

  def setup
    NativeStore.configure("initial" => [row], "queueLimit" => 2, "historyLimit" => 4)
    @reader = Reader.new
    NativeStore.subscribe(@reader, "client", 0, true)
    NativeStore.replace_client("client", NativeStore.snapshot)
  end

  def teardown
    NativeStore.unsubscribe(@reader)
  end

  def test_rejected_publication_does_not_mutate_and_snapshot_is_authoritative
    assert_raises(ArgumentError) { NativeStore.publish(event(2)) }
    assert_raises(ArgumentError) { NativeStore.publish(event(1).merge("seq" => 1.0)) }
    assert_equal 0, NativeStore.snapshot[:through]
    NativeStore.publish(event(1))
    assert_equal [event(1)], @reader.events
    assert_equal [row(1)], NativeStore.snapshot[:rows]
    assert_equal [row(1)], NativeStore.snapshot[:rows]
  end

  def test_actual_native_turbo_templates_render_keyed_rows_and_counter
    html = ApplicationController.renderer.render(partial: "screen", locals: {
      state: { rows: { "row_1" => row }, count: 2, through: 3 }
    })
    assert_includes html, '<turbo-stream action="update" target="rows">'
    assert_includes html, '<tr id="row_1">'
    assert_includes html, 'data-through="3">2</output>'
  end

  def test_bulk_publisher_prevalidates_every_write_and_retains_real_acknowledgements
    assert_raises(ArgumentError) { NativeStore.publish_many([event(1), event(3)]) }
    assert_equal 0, NativeStore.snapshot[:through]
    assert_raises(ArgumentError) { NativeStore.publish_many([event(1), event(2).merge("op" => "bad")]) }
    assert_equal 0, NativeStore.snapshot[:through]
    response = Rack::MockRequest.new(Rails.application).post("/parity/publish",
      input: JSON.generate(event: event(1), events: [event(1)]), "CONTENT_TYPE" => "application/json")
    assert_equal 400, response.status
    assert_equal 0, NativeStore.snapshot[:through]
    response = Rack::MockRequest.new(Rails.application).post("/parity/publish",
      input: JSON.generate(events: [event(1), event(2)]), "CONTENT_TYPE" => "application/json")
    assert_equal 200, response.status
    acks = JSON.parse(response.body).fetch("acks")
    assert_equal [1, 2], acks.map { |ack| ack["seq"] }
    assert_equal [1, 2], acks.map { |ack| ack["resources"]["historyEvents"] }
    assert_equal 2, NativeStore.snapshot[:through]
    assert_equal [event(1)], @reader.events
    NativeStore.acknowledge(@reader)
    assert_equal [event(1), event(2)], @reader.events
  end

  def test_native_consumer_credit_and_real_saturated_queue
    response = Rack::MockRequest.new(Rails.application).post("/parity/control",
      input: JSON.generate(action: "hold"), "CONTENT_TYPE" => "application/json")
    assert_equal 200, response.status
    1.upto(3) { |seq| NativeStore.publish(event(seq)) }
    assert_empty @reader.events
    assert_equal 1, @reader.overflows.size
    assert_equal 2, @reader.overflows.first[:queueEvents]
    assert_equal 2, NativeStore.resources[:queuePeak]
    assert_equal 3, NativeStore.snapshot[:through]
  end

  def test_four_independent_native_readers_receive_the_same_publication
    others = Array.new(3) { Reader.new }
    others.each_with_index do |reader, index|
      NativeStore.subscribe(reader, "client_#{index}", 0, true)
      NativeStore.snapshot_client(reader, "client_#{index}")
      NativeStore.acknowledge(reader)
    end
    NativeStore.publish(event(1))
    ([@reader] + others).each { |reader| assert_equal [event(1)], reader.events }
  ensure
    others&.each { |reader| NativeStore.unsubscribe(reader) }
  end

  def test_duplicate_and_gap_do_not_apply_effects
    assert_equal "gap", NativeStore.apply("client", event(2)).first
    assert_equal "applied", NativeStore.apply("client", event(1)).first
    disposition, state = NativeStore.apply("client", event(1))
    assert_equal "duplicate", disposition
    assert_equal 1, state[:count]
    assert_equal 1, state[:through]
  end

  def test_history_is_bounded_and_cursor_expiry_is_real
    NativeStore.unsubscribe(@reader)
    1.upto(8) { |seq| NativeStore.publish(event(seq)) }
    result = NativeStore.subscribe(@reader, "client", 1, false)
    assert_equal "expired", result[:status]
    assert_equal 4, result[:resources][:historyEvents]
    assert_equal 4, result[:resources][:historyPeak]
    NativeStore.unsubscribe(@reader)
    result = NativeStore.subscribe(@reader, "client", 6, false)
    assert_equal "accepted", result[:status]
    NativeStore.pump(@reader)
    assert_equal [6], @reader.events.map { |e| e["seq"] }
    NativeStore.acknowledge(@reader)
    assert_equal [6, 7], @reader.events.map { |e| e["seq"] }
    NativeStore.acknowledge(@reader)
    assert_equal [6, 7, 8], @reader.events.map { |e| e["seq"] }
  end
end
