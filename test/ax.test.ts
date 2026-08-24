import { describe, it, expect } from 'vitest';
import { axTree } from '../src/index.js';

// Finder is always running on a Mac and has a deep, geometry-rich tree, which
// makes it the least flaky target available without shipping a fixture app.
const APP = 'Finder';
const T = 60_000;

describe('axTree()', () => {
  it(
    'returns a tree with geometry for a running app',
    async () => {
      const tree = await axTree({ app: APP, maxElements: 120 });
      expect(tree.app).toBe(APP);
      expect(tree.pid).toBeGreaterThan(0);
      expect(tree.nodes.length).toBeGreaterThan(0);
      expect(tree.source).toBe('ax');
    },
    T
  );

  it(
    'gives every node a four-number box and a role',
    async () => {
      const { nodes } = await axTree({ app: APP, maxElements: 120 });
      for (const n of nodes) {
        expect(n.box).toHaveLength(4);
        for (const v of n.box) expect(Number.isFinite(v)).toBe(true);
        expect(n.box[2]).toBeGreaterThan(0); // width
        expect(n.box[3]).toBeGreaterThan(0); // height
        expect(typeof n.role).toBe('string');
        expect(n.role.startsWith('AX')).toBe(false); // prefix stripped
      }
    },
    T
  );

  it(
    'reports the budget honestly instead of truncating silently',
    async () => {
      const tree = await axTree({ app: APP, maxElements: 10 });
      expect(tree.budget.elements).toBe(tree.nodes.length);
      expect(tree.budget.elements).toBeLessThanOrEqual(10);
      expect(tree.budget.capped).toBe(true);
      expect(tree.budget.elapsedMs).toBeGreaterThanOrEqual(0);
    },
    T
  );

  it(
    'keeps parent ids resolvable within the returned set',
    async () => {
      const { nodes } = await axTree({ app: APP, maxElements: 200 });
      const ids = new Set(nodes.map((n) => n.id));
      // The root carries no `parent` key at all — Swift omits nil rather than
      // encoding null, and that saves a key on every root.
      const roots = nodes.filter((n) => n.parent === undefined);
      expect(roots.length).toBeGreaterThan(0);
      for (const n of nodes) {
        if (n.parent !== undefined) expect(ids.has(n.parent)).toBe(true);
      }
    },
    T
  );

  it(
    'detail:content is a subset of detail:full',
    async () => {
      const full = await axTree({ app: APP, maxElements: 300, detail: 'full' });
      const content = await axTree({ app: APP, maxElements: 300, detail: 'content' });
      expect(content.nodes.length).toBeLessThanOrEqual(full.nodes.length);
      // Pruning drops unlabelled structure, so what survives should be
      // overwhelmingly nodes that carry meaning.
      const meaningful = content.nodes.filter((n) => n.label || n.value || n.role === 'Window');
      expect(meaningful.length).toBeGreaterThan(content.nodes.length / 2);
    },
    T
  );

  it(
    'omits enabled when true and focused when false, to keep the payload small',
    async () => {
      const { nodes } = await axTree({ app: APP, maxElements: 200 });
      for (const n of nodes) {
        expect(n.enabled).not.toBe(true); // present only when false
        expect(n.focused).not.toBe(false); // present only when true
      }
    },
    T
  );

  it('rejects a call with neither app nor pid', async () => {
    await expect(axTree({})).rejects.toThrow(/app or pid/);
  });

  it(
    'reports a missing application clearly',
    async () => {
      await expect(axTree({ app: 'NoSuchApplication12345' })).rejects.toThrow(
        /no running application/
      );
    },
    T
  );
});

describe('axTree() window targeting', () => {
  it(
    'fails loudly when the window index is out of range',
    async () => {
      // Falling back to the application element would walk a larger tree and
      // report no window frame — a different answer to the question asked.
      await expect(axTree({ app: APP, window: 99 })).rejects.toThrow(/window 99 not found/);
    },
    T
  );
});
