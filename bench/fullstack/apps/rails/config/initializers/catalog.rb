# Parse fixture records once at boot, not on the first request.
Rails.application.config.after_initialize { CatalogSource.fixture }
