import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'mcp-cli-fixture', version: '1.0.0' },
  { capabilities: { prompts: {}, resources: {}, tools: {} }, instructions: 'Fixture server instructions.' },
);

server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
  if (params?.cursor === 'tools-2') {
    return {
      tools: [
        {
          name: 'large',
          description: 'Return a large payload.',
          inputSchema: { type: 'object', additionalProperties: false },
        },
      ],
    };
  }
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echo JSON input.',
        inputSchema: { type: 'object', additionalProperties: true },
      },
    ],
    nextCursor: 'tools-2',
  };
});

server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  if (params.name === 'large') {
    return { content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }] };
  }
  if (params.name !== 'echo') throw new Error(`Unknown tool ${params.name}`);
  return { content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] };
});

server.setRequestHandler(ListResourcesRequestSchema, ({ params }) => ({
  resources:
    params?.cursor === 'resources-2'
      ? [{ uri: 'fixture://binary', name: 'binary', mimeType: 'application/octet-stream' }]
      : [{ uri: 'fixture://text', name: 'text', mimeType: 'text/plain' }],
  ...(params?.cursor ? {} : { nextCursor: 'resources-2' }),
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: [{ uriTemplate: 'fixture://item/{id}', name: 'item', mimeType: 'application/json' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => ({
  contents:
    params.uri === 'fixture://binary'
      ? [
          {
            uri: params.uri,
            mimeType: 'application/octet-stream',
            blob: Buffer.from([0, 1, 2, 255]).toString('base64'),
          },
        ]
      : [{ uri: params.uri, mimeType: 'text/plain', text: 'fixture text' }],
}));

server.setRequestHandler(ListPromptsRequestSchema, ({ params }) => ({
  prompts:
    params?.cursor === 'prompts-2'
      ? [{ name: 'second', description: 'Second page.' }]
      : [
          {
            name: 'explain',
            description: 'Explain a topic.',
            arguments: [{ name: 'topic', required: true }],
          },
        ],
  ...(params?.cursor ? {} : { nextCursor: 'prompts-2' }),
}));

server.setRequestHandler(GetPromptRequestSchema, ({ params }) => ({
  description: `Explain ${params.arguments?.topic ?? 'nothing'}`,
  messages: [
    { role: 'user', content: { type: 'text', text: `Explain ${params.arguments?.topic ?? 'nothing'}` } },
  ],
}));

await server.connect(new StdioServerTransport());
process.on('SIGTERM', () => void server.close());
