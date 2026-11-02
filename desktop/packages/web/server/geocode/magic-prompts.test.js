import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { createMagicPromptService } from '../lib/magic-prompts/service.js';

// The walkthrough reads its instructions through the service itself, not through the closed endpoint.
const service = createMagicPromptService({
  path,
  runtime: { readPromptState: async () => ({ overrides: { 'walkthrough.instructions': 'From the global file' } }) },
  projectRuntime: { readProjectState: async () => ({ status: 'ok', overrides: { 'walkthrough.instructions': 'From the repository' } }) },
  listProjects: async () => [{ id: 'p1', path: '/repo' }],
  ownerOfDirectory: async () => ({ id: 'p1', path: '/repo' }),
});

// Guards against custom prompts, the global file's or a downloaded repository's, reaching what the server tells a model.
describe('GeoCode: magic prompts on the server', () => {
  it('give the walkthrough no overrides', async () => {
    expect(await service.overridesForDirectory('/repo/src')).toEqual({});
  });
});
