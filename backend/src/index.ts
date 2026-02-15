import { buildServer } from './server.js';

const app = buildServer();

const start = async (): Promise<void> => {
  try {
    await app.listen({ host: '0.0.0.0', port: 8080 });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
