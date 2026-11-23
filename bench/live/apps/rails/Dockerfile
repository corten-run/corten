FROM ruby:4.0.10-slim@sha256:dc488b2df1731a1523a24a845fc38627b3edde052473c4e7bef06ae4d649fd25 AS build
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends build-essential libyaml-dev >/dev/null && rm -rf /var/lib/apt/lists/*
ENV BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
COPY Gemfile Gemfile.lock ./
RUN gem install bundler --version 4.0.24 --no-document && bundle _4.0.24_ install --jobs 2 --retry 2
COPY . .
RUN bundle exec ruby assets.rb

FROM ruby:4.0.10-slim@sha256:dc488b2df1731a1523a24a845fc38627b3edde052473c4e7bef06ae4d649fd25
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libyaml-0-2 >/dev/null && rm -rf /var/lib/apt/lists/* && useradd --create-home app && chown app:app /app
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build --chown=app:app /app /app
ENV RAILS_ENV=production BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
USER app
EXPOSE 8080
CMD ["bundle", "exec", "puma", "--bind", "tcp://0.0.0.0:8080", "--threads", "1:4", "--workers", "0"]
