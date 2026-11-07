module Api
  class CatalogController < ActionController::API
    def show
      record = CatalogSource.get(params[:id])
      record ? render(json: record) : head(:not_found)
    end
  end
end
