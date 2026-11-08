class MarketplaceController < ApplicationController
  def show
    return head(:bad_request) unless MarketplaceFormat::LOCALES.key?(params[:locale])
    @record = MarketplaceSource.get(params[:id]) or return head(:not_found)
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
      @format.alert(params[:email].to_s, params[:target_price].to_s, @record.fetch("title"))
    else
      ""
    end
    render :show, status: :ok
  end
end
