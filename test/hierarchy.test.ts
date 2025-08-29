import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, effect, MachineError, type StateConfig } from '../src/index.js';

type Ev = { type: 'PLAY' } | { type: 'PAUSE' } | { type: 'STOP' } | { type: 'NEXT' } | { type: 'EJECT' } | { type: 'PING' };

function build(log: string[]) {
  const trace = (name: string) => effect<null, Ev>(name, () => log.push(name));
  const states: Record<string, StateConfig<null, Ev>> = {
    stopped: { entry: trace('enter stopped'), exit: trace('exit stopped'), on: { PLAY: 'active' } },
    active: {
      initial: 'playing',
      entry: trace('enter active'),
      exit: trace('exit active'),
      on: { STOP: 'stopped', EJECT: '#ejected' },
      states: {
        playing: {
          entry: trace('enter playing'),
          exit: trace('exit playing'),
          on: { PAUSE: 'paused', NEXT: { actions: trace('next') } }
        },
        paused: { entry: trace('enter paused'), exit: trace('exit paused'), on: { PLAY: 'playing' } }
      }
    },
    ejected: {}
  };
  return createMachine<null, Ev>({ id: 'player', initial: 'stopped', context: null, states });
}

function names(state: { effects: readonly { name: string }[] }): string[] {
  return state.effects.map((e) => e.name);
}

test('entering a compound state descends to its initial child', () => {
  const m = build([]);
  const s = m.transition(m.initialState, { type: 'PLAY' });
  assert.equal(s.value, 'active.playing');
  assert.deepEqual(names(s), ['exit stopped', 'enter active', 'enter playing']);
});

test('initial state runs entry actions from the outside in', () => {
  const m = createMachine<null, Ev>({
    id: 'init',
    initial: 'outer',
    context: null,
    states: {
      outer: {
        initial: 'inner',
        entry: effect('outer', () => {}),
        states: { inner: { entry: effect('inner', () => {}) } }
      }
    }
  });
  assert.equal(m.initialState.value, 'outer.inner');
  assert.deepEqual(names(m.initialState), ['outer', 'inner']);
});

test('matches works on whole path segments only', () => {
  const m = build([]);
  const s = m.transition(m.initialState, { type: 'PLAY' });
  assert.ok(s.matches('active'));
  assert.ok(s.matches('active.playing'));
  assert.ok(!s.matches('active.play'));
  assert.ok(!s.matches('act'));
});

test('siblings inside a compound state do not exit the parent', () => {
  const m = build([]);
  let s = m.transition(m.initialState, { type: 'PLAY' });
  s = m.transition(s, { type: 'PAUSE' });
  assert.equal(s.value, 'active.paused');
  assert.deepEqual(names(s), ['exit playing', 'enter paused']);
});

test('events bubble up from the leaf to an ancestor handler', () => {
  const m = build([]);
  let s = m.transition(m.initialState, { type: 'PLAY' });
  s = m.transition(s, { type: 'PAUSE' });
  s = m.transition(s, { type: 'STOP' });
  assert.equal(s.value, 'stopped');
  assert.deepEqual(names(s), ['exit paused', 'exit active', 'enter stopped']);
});

test('absolute targets with a hash resolve from the root', () => {
  const m = build([]);
  const s = m.transition(m.transition(m.initialState, { type: 'PLAY' }), { type: 'EJECT' });
  assert.equal(s.value, 'ejected');
});

test('a leaf handler wins over an ancestor handler for the same event', () => {
  const m = createMachine<null, Ev>({
    id: 'priority',
    initial: 'parent',
    context: null,
    states: {
      parent: {
        initial: 'child',
        on: { PING: 'other' },
        states: { child: { on: { PING: 'sibling' } }, sibling: {} }
      },
      other: {}
    }
  });
  assert.equal(m.transition(m.initialState, { type: 'PING' }).value, 'parent.sibling');
});

test('a failing guard on the leaf lets the ancestor handle the event', () => {
  const m = createMachine<null, Ev>({
    id: 'fallthrough',
    initial: 'parent',
    context: null,
    states: {
      parent: {
        initial: 'child',
        on: { PING: 'other' },
        states: { child: { on: { PING: { guard: () => false, target: 'sibling' } } }, sibling: {} }
      },
      other: {}
    }
  });
  assert.equal(m.transition(m.initialState, { type: 'PING' }).value, 'other');
});

test('targetless transitions run actions without exiting or entering', () => {
  const m = build([]);
  const s = m.transition(m.transition(m.initialState, { type: 'PLAY' }), { type: 'NEXT' });
  assert.equal(s.value, 'active.playing');
  assert.deepEqual(names(s), ['next']);
});

test('a self transition with a target exits and re-enters', () => {
  const m = createMachine<null, Ev>({
    id: 'self',
    initial: 'a',
    context: null,
    states: {
      a: { entry: effect('in', () => {}), exit: effect('out', () => {}), on: { PING: 'a' } }
    }
  });
  const s = m.transition(m.initialState, { type: 'PING' });
  assert.deepEqual(names(s), ['out', 'in']);
});

test('dot targets move to a child without leaving the source', () => {
  const m = createMachine<null, Ev>({
    id: 'internal',
    initial: 'parent',
    context: null,
    states: {
      parent: {
        initial: 'one',
        entry: effect('enter parent', () => {}),
        exit: effect('exit parent', () => {}),
        on: { NEXT: '.two' },
        states: { one: {}, two: { entry: effect('enter two', () => {}) } }
      }
    }
  });
  const s = m.transition(m.initialState, { type: 'NEXT' });
  assert.equal(s.value, 'parent.two');
  assert.deepEqual(names(s), ['enter two']);
});

test('targets resolve against siblings of the source or of its ancestors', () => {
  const m = createMachine<null, Ev>({
    id: 'scope',
    initial: 'a',
    context: null,
    states: {
      a: { initial: 'x', states: { x: { on: { PING: 'y' } }, y: {} } },
      b: { initial: 'x', states: { x: { on: { PING: 'a' } } } }
    }
  });
  assert.equal(m.transition(m.initialState, { type: 'PING' }).value, 'a.y');
  assert.throws(
    () =>
      createMachine<null, Ev>({
        id: 'bad',
        initial: 'a',
        context: null,
        states: { a: { initial: 'x', states: { x: { on: { PING: 'zzz' } } } } }
      }),
    MachineError
  );
});

test('final states mark the machine done and ignore further events', () => {
  const m = createMachine<null, Ev>({
    id: 'job',
    initial: 'working',
    context: null,
    states: { working: { on: { STOP: 'finished' } }, finished: { type: 'final', on: { PLAY: 'working' } } }
  });
  const done = m.transition(m.initialState, { type: 'STOP' });
  assert.equal(done.done, true);
  const after = m.transition(done, { type: 'PLAY' });
  assert.equal(after.value, 'finished');
  assert.equal(after.changed, false);
  assert.equal(m.initialState.done, false);
});

test('always transitions fire straight after entering a state', () => {
  const m = createMachine<{ n: number }, Ev>({
    id: 'eager',
    initial: 'idle',
    context: { n: 0 },
    states: {
      idle: { on: { PLAY: 'check' } },
      check: { always: [{ guard: (c) => c.n > 0, target: 'high' }, { target: 'low' }] },
      low: {},
      high: {}
    }
  });
  assert.equal(m.transition(m.initialState, { type: 'PLAY' }).value, 'low');
  const withN = createMachine<{ n: number }, Ev>({
    id: 'eager2',
    initial: 'idle',
    context: { n: 5 },
    states: {
      idle: { on: { PLAY: 'check' } },
      check: { always: [{ guard: (c) => c.n > 0, target: 'high' }] },
      high: {}
    }
  });
  assert.equal(withN.transition(withN.initialState, { type: 'PLAY' }).value, 'high');
});

test('an always loop is detected instead of hanging', () => {
  const m = createMachine<null, Ev>({
    id: 'loop',
    initial: 'idle',
    context: null,
    states: { idle: { on: { PLAY: 'a' } }, a: { always: 'b' }, b: { always: 'a' } }
  });
  assert.throws(() => m.transition(m.initialState, { type: 'PLAY' }), /eventless transitions/);
});
