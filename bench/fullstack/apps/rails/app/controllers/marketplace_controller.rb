class MarketplaceController < ApplicationController
  self.forgery_protection_origin_check = true
  before_action :reject_cross_site_write

  def show
    return head(:bad_request) unless MarketplaceFormat::LOCALES.key?(params[:locale])
    @record = MarketplaceSource.get(params[:id]) or return head(:not_found)
    if request.post? && [params[:email], params[:target_price]].any? { |value| !value.nil? && !value.is_a?(String) }
      return head(:bad_request)
    end
    session[:marketplace_alerts_id] ||= SecureRandom.hex(32)
    @locale = params[:locale]
    @format = MarketplaceFormat.new(@locale)
    @labels = @format.labels
    @prefix = request.query_parameters.fetch("seller", "").to_s
    @order = request.query_parameters["sort"] == "desc" ? "desc" : "asc"
    @show_all = request.query_parameters["offers"] == "all"
    @listings = @record.fetch("listings").each_with_index
      .select { |row, _| row.fetch("seller").start_with?(@prefix) }
      .sort_by { |row, index| [row["price_minor"].nil? ? 1 : 0, (row["price_minor"] || 0) * (@order == "desc" ? -1 : 1), index] }
      .map(&:first)
    @offers = @show_all ? @record.fetch("offers") : @record.fetch("offers").first(5)
    @message = if request.post?
      email = params[:email].to_s
      message, minor = @format.alert_result(email, params[:target_price].to_s, @record.fetch("title"))
      if minor
        MarketplaceAlerts.append(session[:marketplace_alerts_id], { item_id: @record.fetch("id"), email: email, target_minor: minor })
      end
      message
    else
      ""
    end
    render :show, status: :ok
  end

  def alerts
    response.headers["Cache-Control"] = "private, no-store"
    render json: MarketplaceAlerts.list(session[:marketplace_alerts_id])
  end

  private

  def reject_cross_site_write
    head :forbidden if request.post? && request.headers["Sec-Fetch-Site"] == "cross-site"
  end
end
