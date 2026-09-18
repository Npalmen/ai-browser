import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { resolveFixtureRoute } from './observation-fixture-routes';

export interface ObservationFixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startObservationFixtureServer(
  requestedPort = 0,
): Promise<ObservationFixtureServer> {
  const server = http.createServer(async (request, response) => {
    const resolved = resolveFixtureRoute(request.url ?? '/');
    if (!resolved) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }

    try {
      const body = await readFile(resolved.absolutePath);
      response.writeHead(200, { 'Content-Type': resolved.contentType });
      response.end(body);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    throw new Error('Failed to bind observation fixture server');
  }

  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function main(): Promise<void> {
  const portArg = process.argv[2];
  const requestedPort = portArg ? Number.parseInt(portArg, 10) : 0;
  const server = await startObservationFixtureServer(Number.isFinite(requestedPort) ? requestedPort : 0);
  console.log(`[observation-fixture] ${server.url}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('[observation-fixture] failed to start:', error);
    process.exit(1);
  });
}
