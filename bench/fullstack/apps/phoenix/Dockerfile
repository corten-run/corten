# Modeled on `mix phx.gen.release --docker`: build a release, run it on a slim Debian.
# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM elixir:1.20.5-otp-29@sha256:028a755eef5692f4f64b06c68104b7a326e0f610646e9d8faa8d3a651f1060f3 AS tools
WORKDIR /app
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force

FROM tools AS build
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod
COPY config config
RUN mix deps.compile
COPY lib lib
COPY priv priv
COPY assets assets
RUN mix compile && mix esbuild.install --if-missing && mix assets.deploy && mix release

FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libstdc++6 openssl libncurses6 locales ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/* \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen >/dev/null
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 MIX_ENV=prod PHX_SERVER=true PORT=8080
WORKDIR /app
COPY --from=build /app/_build/prod/rel/item_page ./
EXPOSE 8080
CMD ["/app/bin/item_page", "start"]
