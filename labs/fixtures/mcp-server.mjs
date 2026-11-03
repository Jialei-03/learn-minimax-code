import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line); if (frame.id === undefined) continue;
  const send = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
  if (frame.method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'course-fixture', version: '1' } });
  else if (frame.method === 'tools/list') send({ tools: [{ name: 'echo', description: 'Echo synthetic text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  else if (frame.method === 'tools/call') send({ content: [{ type: 'text', text: frame.params.arguments.text }], isError: false });
  else if (frame.method === 'hang') continue;
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method' } }) + '\n');
}
