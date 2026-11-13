defmodule NativeLive.MixProject do
  use Mix.Project

  def project do
    [
      app: :native_live,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      compilers: [:phoenix_live_view] ++ Mix.compilers(),
      deps: [
        {:phoenix, "~> 1.8.16"},
        {:phoenix_html, "~> 4.1"},
        {:phoenix_live_view, "~> 1.2.0"},
        {:jason, "~> 1.4"},
        {:bandit, "~> 1.5"},
        {:esbuild, "~> 0.10", runtime: false}
      ]
    ]
  end

  def application,
    do: [mod: {NativeLive.Application, []}, extra_applications: [:logger, :runtime_tools]]
end
