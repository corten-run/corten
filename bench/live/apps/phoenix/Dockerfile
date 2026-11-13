FROM elixir:1.20.5-otp-29@sha256:1b850191faeaae55678b782cd8b34d391f793672f3175b1956d024f794ca321b AS tools
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

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libstdc++6 openssl libncurses6 ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 app
ENV ERL_FLAGS="+S 2:2 +SDcpu 1 +SDio 1" LANG=C.UTF-8 MIX_ENV=prod PHX_SERVER=true PORT=8080
WORKDIR /app
COPY --from=build --chown=app:app /app/_build/prod/rel/native_live ./
USER app
EXPOSE 8080
CMD ["/app/bin/native_live", "start"]
