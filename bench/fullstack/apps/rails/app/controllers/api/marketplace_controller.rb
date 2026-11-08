module Api
  class MarketplaceController < ApplicationController
    def show
      record = MarketplaceSource.get(params[:id]) or return head(:not_found)
      render json: record
    end
  end
end
