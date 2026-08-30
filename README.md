<div align="center">

# lantern

A typed finite state machine and statechart library for TypeScript. Guards, actions, hierarchical states and a pure transition function you can test without running anything.

![License](https://img.shields.io/badge/LICENSE-MIT-blue?style=for-the-badge)  ![Language](https://img.shields.io/badge/TYPESCRIPT-3178c6?style=for-the-badge&logo=typescript&logoColor=white)  ![Tests](https://img.shields.io/badge/TESTS-36-brightgreen?style=for-the-badge)

Refer to [LICENSE](LICENSE) for the legal bits.

</div>

## What's in it

- **Typed events.** Handlers are keyed by your event union's `type`, so a typo in an event name is a compile error and guards receive the matching event, not the whole union.
- **Hierarchical states.** Compound states with an `initial` child, entry and exit actions in the right order, and events that bubble from the active leaf up through its ancestors.
- **Guards.** Inline functions or names looked up in `guards`. A transition with several candidates takes the first one whose guard passes, and a failing leaf guard lets an ancestor handle the event.
- **Actions.** `assign` updates context immutably. `effect` (or a plain function) is a side effect that is recorded on the state and only run by the interpreter, so `transition` stays pure.
- **Target resolution.** `'sibling'` (also finds siblings of ancestors), `'.child'` for an internal move into a child, and `'#a.b'` for an absolute path.
- **Final states, wildcard `'*'` handlers and eventless `always` transitions** with loop detection.
- **Validation up front.** Unknown targets, guards and missing initial states throw when the machine is created, not at 2am in production.
- **An interpreter** with `start`, `send`, `subscribe` and `stop`. Events sent from inside effects are queued and handled in order.

```ts
const machine = createMachine<Ctx, Ev>({
  id: 'upload',
  initial: 'idle',
  context: { attempts: 0 },
  states: {
    idle: { on: { SUBMIT: 'busy' } },
    busy: {
      initial: 'sending',
      on: { CANCEL: 'idle' },
      states: {
        sending: {
          entry: assign<Ctx, Ev>((c) => ({ attempts: c.attempts + 1 })),
          on: {
            OK: '#done',
            FAIL: [{ guard: (c) => c.attempts < 3, target: 'sending' }, { target: '#failed' }]
          }
        }
      }
    },
    done: { type: 'final' },
    failed: {}
  }
});
```

## 🏗️ Architecture

```
 createMachine(config)
   │  builds the state tree, validates targets and guards
   ▼
 Machine<C, E>
   ├─ initialState ──► State { value: 'busy.sending', context, effects[], done }
   └─ transition(state, event)   (pure)
        1. select   leaf ─► ancestors, first handler whose guard passes
        2. resolve  target ─► node, lowest common ancestor
        3. run      exits (inner first) ─► transition actions ─► entries (outer first)
        4. settle   descend to the initial leaf, follow `always` transitions
   ▼
 Interpreter ── send(event) ──► queue ──► transition ──► run effects ──► notify subscribers
```

- `src/machine.ts` holds the tree, target resolution and the transition algorithm.
- `src/actions.ts` has the `assign` and `effect` helpers.
- `src/interpreter.ts` runs a machine: effects, subscriptions and the event queue.
- `src/types.ts` has the config and event types.

## 🚀 Quick start

```
npm install
npm run typecheck
npm test
```

A quick taste, driving the machine above with a subscriber:

```ts
const service = interpret(machine).start();
service.subscribe((s) => console.log(s.value, s.context));
for (const type of ['SUBMIT', 'FAIL', 'FAIL', 'FAIL'] as const) service.send({ type });
```

Which prints:

```
busy.sending { attempts: 1 }
busy.sending { attempts: 2 }
busy.sending { attempts: 3 }
failed { attempts: 3 }
```

Without the interpreter, `machine.transition(state, event)` gives you the next state and the effects it wants run, which is handy for testing.

## 🧪 Testing

36 tests, all passing, and `tsc --noEmit` is clean under `strict`:

- Machine (12): initial state, purity, unhandled events, `assign`, `can` and `nextEvents`, the compile-time check that unknown event names are rejected, guard ordering, named guards and actions, wildcards, creation-time validation, unknown action errors, effects as data.
- Hierarchy (15): initial descent, entry and exit order, `matches` on whole segments, sibling moves, bubbling, leaf versus ancestor priority, guard fall-through, targetless transitions, self transitions, `.child` targets, scope resolution, final states, `always` transitions and loop detection.
- Interpreter (9): start and idempotence, sending before start, effects with updated context, subscriptions, queued events sent from effects, stopping, return values and context identity.
