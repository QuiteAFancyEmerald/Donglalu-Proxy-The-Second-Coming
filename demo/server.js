import { Chemical } from "chemicaljs";
import { createRelay } from "dlpcc";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const env = process.env;
// DLPCC_NGINX=1 when nginx owns 443 (nginx/dlpcc-stream.conf). Otherwise the
// relay shares this server's port, whatever host and port it's reached on.
const nginx = env.DLPCC_NGINX === "1";

function num(name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The wrapper reads every DLPCC_* variable itself (DLPCC_SECRET,
// DLPCC_RELAY_IP, DLPCC_HOSTS, DLPCC_RATE_LIMIT, ...), so the demo only adds
// the two it runs stricter than the library defaults: a public instance
// shouldn't be farmable as a free relay, so minting is capped across all
// visitors and the relay carries a limited number of streams at once.
const relay = createRelay({
  rateLimitGlobal: num("DLPCC_RATE_LIMIT_GLOBAL", 120),
  maxAllocs: num("DLPCC_MAX_ALLOCS", 100),
});

const chemical = new Chemical({ port: Number(env.PORT ?? 8080), staticDir: "dist" });
// TLS_CERT and TLS_KEY serve https, and with it turns: on the same port.
if (env.TLS_CERT && env.TLS_KEY) {
  chemical.server = createServer({ cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) }, chemical.app);
}
// Behind nginx every request reaches Node from 127.0.0.1, so the wrapper's
// per-IP rate limits need X-Forwarded-For trusted to see real visitors.
if (nginx) chemical.app.set("trust proxy", 1);
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