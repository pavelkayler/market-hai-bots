import { buildServer, getRuntimeHandles } from './server.js';
import { registerHandlers } from './services/shutdownManager.js';

const app = buildServer();

const isDemoConfigured = (): boolean => {
  const apiKey = (process.env.DEMO_API_KEY ?? '').trim();
  const apiSecret = (process.env.DEMO_API_SECRET ?? '').trim();
  return apiKey.length > 0 && apiSecret.length > 0;
};

const start = async (): Promise<void> => {
  try {
    const runtime = getRuntimeHandles(app);
    const unregisterShutdownHandlers = registerHandlers({
      ...runtime,
      logger: app.log
    });

    app.addHook('onClose', async () => {
      unregisterShutdownHandlers();
    });

    await app.ready();
    app.log.info(
      {
        demoConfigured: isDemoConfigured(),
        bybitRestBaseUrl: process.env.BYBIT_REST ?? 'https://api.bybit.com',
        bybitDemoRestBaseUrl: process.env.BYBIT_DEMO_REST ?? 'https://api-demo.bybit.com'
      },
      'Startup config'
    );
    await app.listen({ host: '0.0.0.0', port: 8080 });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
