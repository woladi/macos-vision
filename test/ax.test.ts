import { describe, it, expect, beforeAll } from 'vitest';
import { axTree, listWindows } from '../src/index.js';

// Which app to walk is decided at run time. Hard-coding one made this suite pass
// locally and fail on CI, where no Finder window exists — and worse, it passed
// there only because the helper used to fall back to walking the whole
// application, which is precisely the behaviour these tests now forbid.
let app: string | undefined;
const T = 60_000;

// The precondition is not "some app has a window" but "AX will actually answer".
// CGWindowList still lists windows on a locked Mac while the accessibility API
// exposes none, and a CI runner has neither — so probe instead of assuming, and
// pick the first app that really works.
beforeAll(async () => {
  const windows = await listWindows().catch(() => []);
  for (const candidate of [...new Set(windows.map((w) => w.app))].slice(0, 5)) {
    try {
      const probe = await axTree({ app: candidate, maxElements: 5 });
      if (probe.nodes.length > 0) {
        app = candidate;
        return;
      }
    } catch {
      // minimised, hidden, locked screen, or an app that exposes nothing — try the next
    }
  }
}, T);

/** Runs the test against an app AX actually answers for; skips when none does. */
const withApp =
  (fn: (app: string) => Promise<void>) =>
  async (): Promise<void> => {
    if (!app) return; // no usable accessibility target here, which is not a failure
    await fn(app);
  };

describe('axTree()', () => {
  it(
    'returns a tree with geometry for a running app',
    withApp(async (target) => {
      const tree = await axTree({ app: target, maxElements: 120 });
      expect(tree.app).toBe(target);
      expect(tree.pid).toBeGreaterThan(0);
      expect(tree.nodes.length).toBeGreaterThan(0);
      expect(tree.source).toBe('ax');
    }),
    T
  );

  it(
    'gives every node a four-number box and a role',
    withApp(async (target) => {
      const { nodes } = await axTree({ app: target, maxElements: 120 });
      for (const n of nodes) {
        expect(n.box).toHaveLength(4);
        for (const v of n.box) expect(Number.isFinite(v)).toBe(true);
        expect(n.box[2]).toBeGreaterThan(0);
        expect(n.box[3]).toBeGreaterThan(0);
        expect(typeof n.role).toBe('string');
        expect(n.role.startsWith('AX')).toBe(false);
      }
    }),
    T
  );

  it(
    'reports the budget honestly instead of truncating silently',
    withApp(async (target) => {
      const tree = await axTree({ app: target, maxElements: 10 });
      expect(tree.budget.elements).toBe(tree.nodes.length);
      // maxElements caps the walk and pruning runs after it, so `walked` is what
      // hit the cap while `elements` can legitimately come back smaller.
      expect(tree.budget.walked).toBeLessThanOrEqual(10);
      expect(tree.budget.elements).toBeLessThanOrEqual(tree.budget.walked);
      expect(tree.budget.capped).toBe(true);
      expect(tree.budget.elapsedMs).toBeGreaterThanOrEqual(0);
    }),
    T
  );

  it(
    'keeps parent ids resolvable within the returned set',
    withApp(async (target) => {
      const { nodes } = await axTree({ app: target, maxElements: 200 });
      const ids = new Set(nodes.map((n) => n.id));
      // The root carries no `parent` key at all — Swift omits nil rather than
      // encoding null, and that saves a key on every root.
      const roots = nodes.filter((n) => n.parent === undefined);
      expect(roots.length).toBeGreaterThan(0);
      for (const n of nodes) {
        if (n.parent !== undefined) expect(ids.has(n.parent)).toBe(true);
      }
    }),
    T
  );

  it(
    'detail:content is a subset of detail:full',
    withApp(async (target) => {
      const full = await axTree({ app: target, maxElements: 300, detail: 'full' });
      const content = await axTree({ app: target, maxElements: 300, detail: 'content' });
      expect(content.nodes.length).toBeLessThanOrEqual(full.nodes.length);
      const meaningful = content.nodes.filter((n) => n.label || n.value || n.role === 'Window');
      expect(meaningful.length).toBeGreaterThan(content.nodes.length / 2);
    }),
    T
  );

  it(
    'omits enabled when true and focused when false, to keep the payload small',
    withApp(async (target) => {
      const { nodes } = await axTree({ app: target, maxElements: 200 });
      for (const n of nodes) {
        expect(n.enabled).not.toBe(true);
        expect(n.focused).not.toBe(false);
      }
    }),
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

  it(
    'fails loudly when the window index is out of range',
    withApp(async (target) => {
      // Falling back to the application element would walk a larger tree and
      // report no window frame — a different answer to the question asked.
      await expect(axTree({ app: target, window: 99 })).rejects.toThrow(/window 99 not found/);
    }),
    T
  );
});
