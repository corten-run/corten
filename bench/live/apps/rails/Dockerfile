FROM ruby:4.0.9-slim@sha256:d8cb2c0714bdaba0f318af897a01d2dbde3cfa8e62d47e99cea55feb13c0e90d AS build
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends build-essential libyaml-dev >/dev/null && rm -rf /var/lib/apt/lists/*
ENV BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
COPY Gemfile Gemfile.lock ./
RUN gem install bundler --version 4.0.24 --no-document && bundle _4.0.24_ install --jobs 2 --retry 2
COPY . .
RUN bundle exec ruby assets.rb

FROM ruby:4.0.9-slim@sha256:d8cb2c0714bdaba0f318af897a01d2dbde3cfa8e62d47e99cea55feb13c0e90d
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libyaml-0-2 >/dev/null && rm -rf /var/lib/apt/lists/* && useradd --create-home app && chown app:app /app
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build --chown=app:app /app /app
ENV RAILS_ENV=production BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
USER app
EXPOSE 8080
CMD ["bundle", "exec", "puma", "--bind", "tcp://0.0.0.0:8080", "--threads", "1:4", "--workers", "0"]
