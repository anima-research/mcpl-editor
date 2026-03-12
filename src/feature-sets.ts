/**
 * Feature set declarations for the editor MCPL server.
 */

import type { FeatureSetDeclaration } from '@connectome/mcpl-core';

export const featureSets: Record<string, FeatureSetDeclaration> = {
  'editor.observe': {
    name: 'editor.observe',
    description: 'Receive notifications when the document changes',
    uses: ['pushEvents', 'stateUpdate'],
    rollback: false,
    hostState: false,
  },
  'editor.read': {
    name: 'editor.read',
    description: 'Read document content and structure',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  'editor.write': {
    name: 'editor.write',
    description: 'Edit the document',
    uses: ['tools'],
    rollback: true,
    hostState: false,
  },
  'editor.chat': {
    name: 'editor.chat',
    description: 'Chat with the human editing the document',
    uses: ['channels.publish', 'channels.observe'],
    rollback: false,
    hostState: false,
  },
  'editor.branches': {
    name: 'editor.branches',
    description: 'Manage host branches from the editor UI',
    uses: ['branches'],
    rollback: false,
    hostState: false,
  },
};

/** Check if a feature set is enabled (supports wildcard like editor.*). */
export function isEnabled(name: string, enabled: Set<string>): boolean {
  if (enabled.has(name)) return true;
  // Wildcard: editor.* matches editor.read, editor.write, etc.
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabled.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set name for a tool. */
export function featureSetForTool(toolName: string): string {
  switch (toolName) {
    case 'get_document':
    case 'get_outline':
      return 'editor.read';
    case 'edit_document':
      return 'editor.write';
    default:
      return 'editor.read';
  }
}
