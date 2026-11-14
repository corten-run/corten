defmodule ItemPage.ServerRefreshTest do
  use ExUnit.Case, async: true

  test "HTML attributes reject injected names while valid values stay escaped" do
    for attributes <- [
          [{"title\" onfocus", "injected"}],
          [{"data", [{"label onfocus", "injected"}]}],
          [{"aria", [{"label\n", "injected"}]}]
        ] do
      assert_raise ArgumentError, fn -> Phoenix.HTML.attributes_escape(attributes) end
    end

    assert Phoenix.HTML.attributes_escape([{"title", "<script>\"x\"&"}])
           |> Phoenix.HTML.safe_to_string() ==
             " title=\"&lt;script&gt;&quot;x&quot;&amp;\""
  end

  test "crypto rejects wrong argument types without exposing key material" do
    key = String.duplicate("refresh-test-key-not-a-real-secret", 4)

    for operation <- [:sign, :verify, :encrypt, :decrypt] do
      try do
        apply(Plug.Crypto, operation, [key, :invalid_salt, "payload", []])
        flunk("wrong salt type was accepted by #{operation}")
      rescue
        error in ArgumentError ->
          refute Exception.format(:error, error, __STACKTRACE__) =~ key
      end
    end

    signed = Plug.Crypto.sign(key, "refresh", %{id: "item_1"})
    assert {:ok, %{id: "item_1"}} = Plug.Crypto.verify(key, "refresh", signed)
    encrypted = Plug.Crypto.encrypt(key, "refresh", %{id: "item_1"})
    assert {:ok, %{id: "item_1"}} = Plug.Crypto.decrypt(key, "refresh", encrypted)
  end
end
