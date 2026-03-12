/**
 * Tool definitions for the editor MCPL server.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_document',
    description: 'Get the full markdown document content. Optionally retrieve a historical version by checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        atCheckpoint: {
          type: 'string',
          description: 'Optional checkpoint ID (e.g., "seq_42") to retrieve a historical version.',
        },
      },
    },
  },
  {
    name: 'edit_document',
    description: 'Edit the markdown document. Applies operations in order and returns the new checkpoint.',
    inputSchema: {
      type: 'object',
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['replace_all', 'replace_range', 'insert_after'],
              },
              text: {
                type: 'string',
                description: 'The text to insert or replace with.',
              },
              startLine: {
                type: 'number',
                description: 'Start line (1-indexed, inclusive). For replace_range.',
              },
              endLine: {
                type: 'number',
                description: 'End line (1-indexed, inclusive). For replace_range.',
              },
              line: {
                type: 'number',
                description: 'Line number to insert after (1-indexed). For insert_after. Use 0 to insert at the beginning.',
              },
            },
            required: ['type', 'text'],
          },
        },
      },
    },
  },
  {
    name: 'get_outline',
    description: 'Get the document outline (heading structure with line numbers).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
