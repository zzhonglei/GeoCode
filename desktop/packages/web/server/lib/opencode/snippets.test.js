import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KERNEL_PROJECT_DIR } from '../../geocode/kernel-roots.js'; // GeoCode: fixtures must carry the names the code now discovers
import {
  createSnippet,
  deleteSnippet,
  expandSnippets,
  getSnippet,
  listSnippets,
  updateSnippet,
} from './snippets.js';

let projectDir;

function writeSnippet(relativePath, content) {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('snippets', () => {
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-snippets-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('loads project snippets with aliases and description', () => {
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/review.md`, '---\naliases: [rev]\ndescription: Review helper\n---\nReview carefully.');

    expect(listSnippets(projectDir)).toContainEqual(
      expect.objectContaining({ name: 'review', aliases: ['rev'], description: 'Review helper', source: 'project' }),
    );
    expect(getSnippet('rev', projectDir)).toEqual(expect.objectContaining({ name: 'review' }));
  });

  test('snippet directory wins over snippets directory', () => {
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippets/same.md`, 'Old');
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/same.md`, 'New');

    expect(getSnippet('same', projectDir)?.content).toBe('New');
  });

  test('canonical snippet names take precedence over colliding aliases', () => {
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippets/review.md`, 'Review by name');
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/helper.md`, '---\naliases: [review, help]\n---\nReview by alias');

    expect(getSnippet('review', projectDir)).toEqual(expect.objectContaining({ name: 'review', content: 'Review by name' }));
    expect(getSnippet('help', projectDir)).toEqual(expect.objectContaining({ name: 'helper', content: 'Review by alias' }));
    expect(expandSnippets('Use #review and #help', projectDir)).toBe('Use Review by name and Review by alias');
  });

  test('canonical snippet names override earlier same-directory aliases', () => {
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/alias-first.md`, '---\naliases: [review, assist]\n---\nReview by alias');
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/review.md`, 'Review by name');

    const snippetDir = path.join(projectDir, KERNEL_PROJECT_DIR, 'snippet');
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function readdirSync(dir, ...args) {
      if (dir === snippetDir) return ['alias-first.md', 'review.md'];
      return originalReaddirSync.call(fs, dir, ...args);
    };

    try {
      expect(getSnippet('review', projectDir)).toEqual(expect.objectContaining({ name: 'review', content: 'Review by name' }));
      expect(getSnippet('assist', projectDir)).toEqual(expect.objectContaining({ name: 'alias-first', content: 'Review by alias' }));
      expect(expandSnippets('Use #review and #assist', projectDir)).toBe('Use Review by name and Review by alias');
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });

  test('creates updates and deletes snippets', () => {
    expect(createSnippet('custom-one', { content: 'Body', aliases: ['co'] }, projectDir, 'project')).toEqual(
      expect.objectContaining({ name: 'custom-one', content: 'Body', aliases: ['co'] }),
    );
    expect(updateSnippet('custom-one', { content: 'Updated' }, projectDir)).toEqual(
      expect.objectContaining({ name: 'custom-one', content: 'Updated', aliases: ['co'] }),
    );
    deleteSnippet('custom-one', projectDir);
    expect(getSnippet('custom-one', projectDir)).toBeNull();
  });

  test('expands snippets recursively with prepend and append blocks', () => {
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/base.md`, 'Base text');
    writeSnippet(`${KERNEL_PROJECT_DIR}/snippet/review.md`, '<prepend>Before</prepend>Review #base<append>After</append>');

    expect(expandSnippets('Please #review', projectDir)).toBe('Before\n\nPlease Review Base text\n\nAfter');
  });

  test('rejects invalid snippet names', () => {
    expect(() => createSnippet('../bad', { content: '' }, projectDir, 'project')).toThrow('Snippet name');
  });
});
