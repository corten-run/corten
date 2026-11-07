class CatalogController < ApplicationController
  def show
    @record = CatalogSource.get(params[:id]) or return head(:not_found)
    @prefix = params[:field].to_s
    @fields = @record.fields.select { |field| field.name.start_with?(@prefix) }
  end
end
