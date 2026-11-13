import { createApplication } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const runtime = await createApplication(config);
runtime.app.listen({ hostname: config.hostname, port: config.port, maxRequestBodySize: 262144 });
console.log(`Tessera listening on ${config.hostname}:${config.port}`);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void runtime.close().then(() => process.exit(0), () => process.exit(1));
  });
}
