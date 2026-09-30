import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BridgeClient } from './client.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export function createBridgeServer(): McpServer {
  const server = new McpServer({ name: 'assetweave', version: '0.1.0' });
  const client = new BridgeClient();
  registerTools(server, client);
  registerResources(server, client);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(createBridgeServer);
  process.once('SIGINT', () => { void handle.close(); });
  process.once('SIGTERM', () => { void handle.close(); });
  console.error('AssetWeave MCP bridge ready on stdio. Start the local Nest service separately before using tools or resources.');
}
