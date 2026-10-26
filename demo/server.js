import { Chemical } from "chemicaljs";
import { createRelay } from "dlpcc";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const env = process.env;
// DLPCC_NGINX=1 when nginx owns 443 (nginx/dlpcc-stream.conf). Otherwise the
// relay shares this server's port, whatever host and port it's reached on.
const nginx = env.DLPCC_NGINX === "1";

const relay = createRelay({
  enabled: env.DLPCC_ENABLED !== "false",
  secret: env.DLPCC_SECRET, // optional here: made up per run if unset
  relayIp: env.DLPCC_RELAY_IP, // optional: detected if unset
  hosts: env.DLPCC_HOSTS?.split(","),
  allowPrivatePeers: env.DLPCC_ALLOW_PRIVATE_PEERS === "1",
  logLevel: env.DLPCC_LOG_LEVEL,
});

const chemical = new Chemical({ port: Number(env.PORT ?? 8080), staticDir: "dist" });
// TLS_CERT and TLS_KEY serve https, and with it turns: on the same port.
if (env.TLS_CERT && env.TLS_KEY) {
  chemical.server = createServer({ cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) }, chemical.app);
}
if (!nginx) relay.attach(chemical.server);
// Registered before start() so it runs ahead of Chemical's own routes.
chemical.app.use((req, res, next) => {
  if (!relay.routeRequest(req, res)) next();
});
await relay.start();
await chemical.start();

const shutdown = async () => {
  chemical.stop();
  await relay.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
