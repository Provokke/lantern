import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, createMachine, effect, MachineError, type Action } from '../src/index.js';

type Light = { type: 'TIMER' } | { type: 'POWER_OUT' } | { type: 'RESTORE' };

const light = createMachine<{ cycles: number }, Light>({
  id: 'light',
  initial: 'green',
  context: { cycles: 0 },
  states: {
    green: { on: { TIMER: 'yellow', POWER_OUT: 'off' } },
    yellow: { on: { TIMER: 'red', POWER_OUT: 'off' } },
    red: {
      on: { TIMER: { target: 'green', actions: assign<{ cycles: number }>((c) => ({ cycles: c.cycles + 1 })) }, POWER_OUT: 'off' }
    },
    off: { on: { RESTORE: 'green' } }
  }
});

test('starts in the initial state with the initial context', () => {
  assert.equal(light.initialState.value, 'green');
  assert.deepEqual(light.initialState.context, { cycles: 0 });
});

test('transitions are pure and leave the old state untouched', () => {
  const a = light.initialState;
  const b = light.transition(a, { type: 'TIMER' });
  assert.equal(a.value, 'green');
  assert.equal(b.value, 'yellow');
  assert.equal(b.changed, true);
});

test('events with no handler leave the state unchanged', () => {
  const next = light.transition(light.initialState, { type: 'RESTORE' });
  assert.equal(next.value, 'green');
  assert.equal(next.changed, false);
});

test('assign updates context immutably', () => {
  let s = light.initialState;
  const before = s.context;
  for (let i = 0; i < 3; i += 1) s = light.transition(s, { type: 'TIMER' });
  assert.equal(s.value, 'green');
  assert.equal(s.context.cycles, 1);
  assert.deepEqual(before, { cycles: 0 });
});

test('can and nextEvents report what a state accepts', () => {
  const s = light.initialState;
  assert.ok(s.can({ type: 'TIMER' }));
  assert.ok(!s.can({ type: 'RESTORE' }));
  assert.deepEqual(s.nextEvents, ['POWER_OUT', 'TIMER']);
});

test('typed events reject unknown event names at compile time', () => {
  type Ev = { type: 'GO' };
  createMachine<null, Ev>({
    id: 'typed',
    initial: 'a',
    context: null,
    states: {
      a: {
        on: {
          GO: 'a',
          // @ts-expect-error NOPE is not an event type
          NOPE: 'a'
        }
      }
    }
  });
  assert.ok(true);
});

type CounterEvent = { type: 'ADD'; amount: number } | { type: 'RESET' };

const addAmount = assign<{ total: number }, { type: 'ADD'; amount: number }>((c, e) => ({ total: c.total + e.amount }));

test('guards see context and the matching event, first passing one wins', () => {
  const m = createMachine<{ total: number }, CounterEvent>({
    id: 'guarded',
    initial: 'open',
    context: { total: 0 },
    states: {
      open: {
        on: {
          ADD: [
            { guard: (_c, e) => e.amount < 0, target: 'rejected' },
            { guard: (c, e) => c.total + e.amount > 10, target: 'full', actions: addAmount },
            { actions: addAmount }
          ]
        }
      },
      full: {},
      rejected: {}
    }
  });
  let s = m.initialState;
  s = m.transition(s, { type: 'ADD', amount: 4 });
  assert.deepEqual([s.value, s.context.total], ['open', 4]);
  s = m.transition(s, { type: 'ADD', amount: 8 });
  assert.deepEqual([s.value, s.context.total], ['full', 12]);
  assert.equal(m.transition(m.initialState, { type: 'ADD', amount: -1 }).value, 'rejected');
});

test('named guards and actions come from the options', () => {
  const log: string[] = [];
  const m = createMachine<{ n: number }, CounterEvent>({
    id: 'named',
    initial: 'a',
    context: { n: 0 },
    guards: { positive: (_c, e) => e.type === 'ADD' && e.amount > 0 },
    actions: {
      bump: assign<{ n: number }, CounterEvent>((c) => ({ n: c.n + 1 })),
      note: effect('note', () => log.push('noted'))
    },
    states: {
      a: { on: { ADD: { guard: 'positive', target: 'b', actions: ['bump', 'note'] } } },
      b: {}
    }
  });
  assert.equal(m.transition(m.initialState, { type: 'ADD', amount: -1 }).value, 'a');
  const next = m.transition(m.initialState, { type: 'ADD', amount: 1 });
  assert.equal(next.value, 'b');
  assert.equal(next.context.n, 1);
  assert.deepEqual(next.effects.map((e) => e.name), ['note']);
});

test('wildcard handlers catch anything not handled more specifically', () => {
  const m = createMachine<null, CounterEvent>({
    id: 'wild',
    initial: 'a',
    context: null,
    states: { a: { on: { RESET: 'b', '*': 'c' } }, b: {}, c: {} }
  });
  assert.equal(m.transition(m.initialState, { type: 'RESET' }).value, 'b');
  assert.equal(m.transition(m.initialState, { type: 'ADD', amount: 1 }).value, 'c');
});

test('validation: unknown targets, guards, missing initial and bad names throw at creation', () => {
  const make = (states: Record<string, object>, extra: object = {}) => () =>
    createMachine<null, { type: 'X' }>({ id: 'bad', initial: 'a', context: null, states: states as never, ...extra });
  assert.throws(make({ a: { on: { X: 'nowhere' } } }), /cannot resolve target "nowhere"/);
  assert.throws(make({ a: { on: { X: { guard: 'missing', target: 'a' } } } }), /unknown guard "missing"/);
  assert.throws(make({ a: { states: { b: {} } } }), /needs an initial/);
  assert.throws(make({ a: { initial: 'zzz', states: { b: {} } } }), /needs an initial/);
  assert.throws(make({ a: { initial: 'b' } }), /initial but no children/);
  assert.throws(make({ a: { type: 'final', initial: 'b', states: { b: {} } } }), MachineError);
  assert.throws(make({ 'a.b': {} }, { initial: 'a.b' }), /cannot contain a dot/);
});

test('unknown named actions throw when run', () => {
  const m = createMachine<null, { type: 'X' }>({
    id: 'x',
    initial: 'a',
    context: null,
    states: { a: { on: { X: { actions: 'ghost' } } } }
  });
  assert.throws(() => m.transition(m.initialState, { type: 'X' }), /unknown action "ghost"/);
});

test('plain functions become effects without touching context', () => {
  const calls: string[] = [];
  const log: Action<null, { type: 'X' }> = (_c, e) => {
    calls.push(e.type);
  };
  const m = createMachine<null, { type: 'X' }>({
    id: 'x',
    initial: 'a',
    context: null,
    states: { a: { on: { X: { actions: log } } } }
  });
  const next = m.transition(m.initialState, { type: 'X' });
  assert.equal(next.effects.length, 1);
  assert.deepEqual(calls, []);
  next.effects[0]!.run(next.context, next.event);
  assert.deepEqual(calls, ['X']);
});
