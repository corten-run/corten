// Native Express 5 server: compression, immutable /assets, then the React Router
// request handler (no request logging). The dispatcher follows the official custom-server template.
import compression from "compression";
import express from "express";
import { createRequestHandler } from "@react-router/express";

const build = await import("./build/server/index.js");
const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
app.use(express.static("build/client"));
app.use(createRequestHandler({ build, mode: "production" }));
const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => console.log(`react-router item page listening on ${port}`));
