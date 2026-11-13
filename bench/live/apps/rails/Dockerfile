FROM ruby:3.4.11-slim AS build
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends build-essential libyaml-dev >/dev/null && rm -rf /var/lib/apt/lists/*
ENV BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
COPY Gemfile Gemfile.lock ./
RUN bundle install --jobs 2 --retry 2
COPY . .
RUN bundle exec ruby assets.rb

FROM ruby:3.4.11-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libyaml-0-2 >/dev/null && rm -rf /var/lib/apt/lists/* && useradd --create-home app && chown app:app /app
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build --chown=app:app /app /app
ENV RAILS_ENV=production BUNDLE_WITHOUT=development BUNDLE_DEPLOYMENT=1
USER app
EXPOSE 8080
CMD ["bundle", "exec", "puma", "--bind", "tcp://0.0.0.0:8080", "--threads", "1:4", "--workers", "0"]
