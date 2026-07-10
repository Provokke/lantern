import { MachineError, type Machine, type State } from './machine.js';
import type { AnyEvent } from './types.js';

export type Listener<C, E extends AnyEvent> = (state: State<C, E>) => void;

export class Interpreter<C, E extends AnyEvent> {
  private current: State<C, E> | null = null;
  private readonly listeners = new Set<Listener<C, E>>();
  private readonly queue: E[] = [];
  private draining = false;
  private stopped = false;

  constructor(private readonly machine: Machine<C, E>) {}

  get state(): State<C, E> {
    if (this.current === null) throw new MachineError('interpreter has not been started');
    return this.current;
  }

  get running(): boolean {
    return this.current !== null && !this.stopped;
  }

  start(): this {
    if (this.current !== null) return this;
    const initial = this.machine.initialState;
    this.current = initial;
    this.runEffects(initial);
    this.notify(initial);
    return this;
  }

  send(event: E): State<C, E> {
    if (this.current === null) throw new MachineError('interpreter has not been started');
    if (this.stopped) return this.current;
    this.queue.push(event);
    if (this.draining) return this.current;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const next = this.queue.shift()!;
        const state = this.machine.transition(this.current, next);
        this.current = state;
        this.runEffects(state);
        if (state.changed) this.notify(state);
      }
    } finally {
      this.draining = false;
    }
    return this.current;
  }

  subscribe(listener: Listener<C, E>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.listeners.clear();
  }

  private runEffects(state: State<C, E>): void {
    for (const pending of state.effects) pending.run(state.context, state.event);
  }

  private notify(state: State<C, E>): void {
    for (const listener of [...this.listeners]) listener(state);
  }
}

export function interpret<C, E extends AnyEvent>(machine: Machine<C, E>): Interpreter<C, E> {
  return new Interpreter(machine);
}

