ENV["RAILS_ENV"] ||= "production"
require "bundler/setup"
require "rails"
require "action_controller/railtie"
require "action_view/railtie"
require "action_cable/engine"
Bundler.require(*Rails.groups)
require_relative "store"

module NativeLive
  class Application < Rails::Application
    config.load_defaults 8.1
    config.eager_load = true
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE") { SecureRandom.hex(64) }
    config.session_store :cookie_store, key: "_native_live", same_site: :lax, httponly: true
    config.hosts.clear
    config.logger = ActiveSupport::Logger.new($stdout)
    config.log_level = :warn
    config.action_cable.cable = { "adapter" => "async" }
    config.paths["app/views"] = ["views"]
    config.public_file_server.enabled = true
  end
end

class NativeConnection < ActionCable::Connection::Base
  identified_by :client_id
  def connect
    self.client_id = request.session[:client_id]
    reject_unauthorized_connection unless client_id
    NativeStore.connection(self)
  end
  def disconnect
    NativeStore.disconnection(self)
  end
end

class NativeChannel < ActionCable::Channel::Base
  def subscribed
    @client = connection.client_id
  end

  def start(data)
    ready = NativeStore.subscribe(self, @client, data["from"], data["initial"])
    transmit({ kind: "ready", **ready })
    if data["initial"]
      snapshot({})
    else
      # Materialize the actual last-applied client state, not the latest source.
      state = NativeStore.client(@client)
      transmit({ kind: "restore", html: screen(state) })
      NativeStore.pump(self) if ready[:status] == "accepted"
    end
  rescue ArgumentError => error
    transmit({ kind: "error", message: error.message })
  end

  def snapshot(_data)
    state = NativeStore.snapshot_client(self, @client)
    transmit({ kind: "snapshot", snapshot: state, html: screen(NativeStore.client(@client)) })
  end

  def acknowledge(_data)
    NativeStore.acknowledge(self)
  end

  def finish(_data)
    NativeStore.finish(self, @client)
    transmit({ kind: "finished" })
  end

  def deliver(event)
    disposition, state = NativeStore.apply(@client, event)
    html = if disposition == "applied"
      row = if event["op"] == "remove"
        ApplicationController.renderer.render(inline: '<%= turbo_stream.remove(key) %>', locals: { key: event["key"] })
      else
        action = state[:inserted] ? "append" : "replace"
        ApplicationController.renderer.render(partial: "change", locals: { action: action, event: event })
      end
      row + ApplicationController.renderer.render(partial: "counter", locals: { state: state })
    else
      ""
    end
    transmit({ kind: "event", event: event, disposition: disposition, html: html })
  end

  def overflow(resources)
    transmit({ kind: "overflow", outcome: "resnapshot", resources: resources })
  end

  def unsubscribed
    NativeStore.unsubscribe(self)
  end

  private

  def screen(state)
    ApplicationController.renderer.render(partial: "screen", locals: { state: state })
  end
end

class ApplicationController < ActionController::Base
  protect_from_forgery with: :exception
  def index
    session[:client_id] ||= SecureRandom.hex(32)
    render template: "index", formats: [:html], layout: false
  end
end

# Deliberately unauthenticated synthetic publisher/control API, separate from browser actions.
class ParityController < ActionController::API
  rescue_from ArgumentError, with: ->(e) { render json: { error: e.message }, status: :bad_request }
  def configure
    if NativeStore.resources[:connections] > 0
      render json: { error: "readers still connected" }, status: :conflict
    else
      NativeStore.configure(params.to_unsafe_h)
      render json: { configured: true, framework: "rails", version: Rails.version }
    end
  end
  def snapshot
    render json: NativeStore.snapshot
  end
  def resources
    render json: NativeStore.resources
  end
  def publish
    data = request.request_parameters
    raise ArgumentError, "supply event or events" unless data.key?("event") ^ data.key?("events")
    if data.key?("events")
      render json: { acks: NativeStore.publish_many(data["events"]) }
    else
      event = data["event"]
      NativeStore.publish(event)
      render json: { seq: event.fetch("seq"), resources: NativeStore.resources }
    end
  end
  def control
    NativeStore.control(request.request_parameters)
    render json: { resources: NativeStore.resources }
  end
end

NativeLive::Application.initialize!
ActionCable.server.config.connection_class = -> { NativeConnection }
Rails.application.routes.draw do
  root to: "application#index"
  mount ActionCable.server => "/cable"
  post "parity/configure", to: "parity#configure"
  get "parity/snapshot", to: "parity#snapshot"
  get "parity/resources", to: "parity#resources"
  post "parity/publish", to: "parity#publish"
  post "parity/control", to: "parity#control"
end
