FROM elixir:1.20.5-otp-29@sha256:028a755eef5692f4f64b06c68104b7a326e0f610646e9d8faa8d3a651f1060f3 AS tools
WORKDIR /app
ENV ERL_FLAGS="+S 2:2 +SDcpu 1 +SDio 1" MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force

FROM tools AS build
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod
COPY config config
RUN mix deps.compile
COPY lib lib
COPY client.js ./
RUN mix compile --warnings-as-errors && mix esbuild.install --if-missing && mix esbuild native_live --minify && mix release
COPY test test

FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libstdc++6 openssl libncurses6 ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 app
ENV ERL_FLAGS="+S 2:2 +SDcpu 1 +SDio 1" LANG=C.UTF-8 MIX_ENV=prod PHX_SERVER=true PORT=8080
WORKDIR /app
COPY --from=build --chown=app:app /app/_build/prod/rel/native_live ./
USER app
EXPOSE 8080
CMD ["/app/bin/native_live", "start"]
