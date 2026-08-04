import { Connection } from './vendor/client/connection.js';
import { quickjsPlatform, sendTransport } from './quickjs-platform.js';

export { quickjsPlatform };

export function createConnection(): Connection {
  const connection = new Connection(quickjsPlatform);
  connection.onmessage = message => sendTransport(JSON.stringify(message));
  return connection;
}
