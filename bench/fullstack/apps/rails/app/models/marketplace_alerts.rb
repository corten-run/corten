class MarketplaceAlerts
  @mutex = Mutex.new
  @sessions = {}

  class << self
    def append(session_id, alert)
      @mutex.synchronize { (@sessions[session_id] ||= []) << alert.freeze }
    end

    def list(session_id)
      @mutex.synchronize { @sessions.fetch(session_id, []).dup }
    end
  end
end
