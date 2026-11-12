import Document, { Html, Head, Main, NextScript, type DocumentContext, type DocumentInitialProps } from "next/document";
type Props = DocumentInitialProps & { nonce?: string };

export default class MarketplaceDocument extends Document<Props> {
  static async getInitialProps(ctx: DocumentContext): Promise<Props> {
    const initialProps = await Document.getInitialProps(ctx);
    const nonce = ctx.req?.headers["x-nonce"];
    return { ...initialProps, nonce: typeof nonce === "string" ? nonce : undefined };
  }

  render() {
    return <Html lang={this.props.__NEXT_DATA__.props.pageProps.locale ?? "en"}>
      <Head nonce={this.props.nonce} />
      <body><Main /><NextScript nonce={this.props.nonce} /></body>
    </Html>;
  }
}
