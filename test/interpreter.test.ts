import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, createMachine, effect, interpret, MachineError } from '../src/index.js';

type Ev = { type: 'INC' } | { type: 'TOGGLE' } | { type: 'DOUBLE' };
type Ctx = { count: number };

function make(log: string[] = []) {
  return createMachine<Ctx, Ev>({
    id: 'counter',
    initial: 'off',
    context: { count: 0 },
    states: {
      off: { entry: effect('off', () => log.push('entered off')), on: { TOGGLE: 'on' } },
      on: {
        on: {
          TOGGLE: 'off',
          INC: { actions: [assign<Ctx, Ev>((c) => ({ count: c.count + 1 })), effect('log', (c) => log.push(`count ${c.count}`))] }
        }
      }
    }
  });
}

test('start runs initial effects and exposes the state', () => {
  const log: string[] = [];
  const service = interpret(make(log)).start();
  assert.equal(service.state.value, 'off');
  assert.deepEqual(log, ['entered off']);
  assert.ok(service.running);
});

test('sending before start is an error', () => {
  const service = interpret(make());
  assert.throws(() => service.send({ type: 'INC' }), MachineError);
  assert.throws(() => service.state, MachineError);
});

test('send runs effects with the updated context', () => {
  const log: string[] = [];
  const service = interpret(make(log)).start();
  service.send({ type: 'TOGGLE' });
  service.send({ type: 'INC' });
  service.send({ type: 'INC' });
  assert.deepEqual(log, ['entered off', 'count 1', 'count 2']);
  assert.equal(service.state.context.count, 2);
});

test('listeners are notified on change and can unsubscribe', () => {
  const service = interpret(make()).start();
  const seen: string[] = [];
  const off = service.subscribe((s) => seen.push(s.value));
  service.send({ type: 'INC' });
  service.send({ type: 'TOGGLE' });
  off();
  service.send({ type: 'TOGGLE' });
  assert.deepEqual(seen, ['on']);
});

test('start is idempotent', () => {
  const log: string[] = [];
  const service = interpret(make(log));
  service.start();
  service.start();
  assert.deepEqual(log, ['entered off']);
});

test('events sent from effects are queued and processed in order', () => {
  const order: string[] = [];
  let service: ReturnType<typeof interpret<Ctx, Ev>>;
  const m = createMachine<Ctx, Ev>({
    id: 'chain',
    initial: 'a',
    context: { count: 0 },
    states: {
      a: {
        on: {
          TOGGLE: {
            target: 'b',
            actions: effect('chain', () => {
              order.push('effect start');
              service.send({ type: 'INC' });
              order.push('effect end');
            })
          }
        }
      },
      b: { on: { INC: { target: 'c', actions: effect('inc', () => order.push('inc handled')) } } },
      c: {}
    }
  });
  service = interpret(m).start();
  service.send({ type: 'TOGGLE' });
  assert.deepEqual(order, ['effect start', 'effect end', 'inc handled']);
  assert.equal(service.state.value, 'c');
});

test('a stopped interpreter ignores events and drops listeners', () => {
  const service = interpret(make()).start();
  let calls = 0;
  service.subscribe(() => {
    calls += 1;
  });
  service.stop();
  const state = service.send({ type: 'TOGGLE' });
  assert.equal(state.value, 'off');
  assert.equal(calls, 0);
  assert.ok(!service.running);
});

test('send returns the resulting state', () => {
  const service = interpret(make()).start();
  assert.equal(service.send({ type: 'TOGGLE' }).value, 'on');
});

test('context object identity is kept when nothing assigns', () => {
  const m = make();
  const s0 = m.initialState;
  const s1 = m.transition(s0, { type: 'TOGGLE' });
  assert.equal(s1.context, s0.context);
});
