#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-backend', version: '0.1.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo a message and optional tags.',
    inputSchema: z.object({
      message: z.string(),
      tags: z.array(z.string()).optional(),
    }),
  },
  async ({ message, tags }) => ({
    content: [{ type: 'text' as const, text: `echo:${message}${tags && tags.length ? ` [${tags.join(',')}]` : ''}` }],
    structuredContent: { message, tags: tags ?? [] },
  }),
);

server.registerTool(
  'catalog',
  {
    description: 'Return a nested catalog payload for result-shaping tests.',
    annotations: {
      title: 'Catalog',
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      size: z.number().int().min(1).max(20).optional().default(5),
    }),
  },
  async ({ size }) => ({
    content: [{ type: 'text' as const, text: `catalog:${size}` }],
    structuredContent: {
      items: Array.from({ length: size }, (_value, index) => ({
        id: `item-${index + 1}`,
        name: `Item ${index + 1}`,
        tags: ['alpha', 'beta', `slot-${index + 1}`],
      })),
      summary: {
        total: size,
      },
    },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
