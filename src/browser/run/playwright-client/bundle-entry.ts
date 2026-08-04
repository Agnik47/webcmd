import { Connection } from './vendor/client/connection.js';
import { convertInputFiles } from './vendor/client/elementHandle.js';
import { tBinary } from './vendor/protocol/validatorPrimitives.js';
import { quickjsPlatform, sendTransport } from './quickjs-platform.js';

export { convertInputFiles, quickjsPlatform, tBinary };

export function createConnection(): Connection {
  const connection = new Connection(quickjsPlatform);
  connection.markAsRemote();
  connection.onmessage = message => sendTransport(JSON.stringify(message));
  return connection;
}
