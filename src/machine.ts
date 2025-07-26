import type {
  Action,
  AnyEvent,
  Guard,
  InitEvent,
  MachineConfig,
  PendingEffect,
  StateConfig,
  TransitionConfig,
  TransitionInput
} from './types.js';

const MAX_EAGER_STEPS = 100;

export class MachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineError';
  }
}

interface Node<C, E extends AnyEvent> {
  readonly key: string;
  readonly path: string;
  readonly parent: Node<C, E> | null;
  readonly depth: number;
  readonly config: StateConfig<C, E>;
  readonly children: Map<string, Node<C, E>>;
  readonly initial: string | null;
}

interface Resolved<C, E extends AnyEvent> {
  readonly source: Node<C, E>;
  readonly target: Node<C, E> | null;
  readonly config: TransitionConfig<C, E>;
}

export class State<C, E extends AnyEvent> {
  constructor(
    readonly value: string,
    readonly context: C,
    readonly event: E | InitEvent,
    readonly changed: boolean,
    readonly done: boolean,
    readonly effects: readonly PendingEffect<C, E>[],
    private readonly machine: Machine<C, E>
  ) {}

  matches(path: string): boolean {
    return this.value === path || this.value.startsWith(`${path}.`);
  }

  get nextEvents(): string[] {
    return this.machine.eventsFor(this.value);
  }

  can(event: E): boolean {
    return this.machine.transition(this, event).changed;
  }
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

export class Machine<C, E extends AnyEvent> {
  readonly id: string;
  private readonly config: MachineConfig<C, E>;
  private readonly root: Node<C, E>;
  private readonly nodes = new Map<string, Node<C, E>>();

  constructor(config: MachineConfig<C, E>) {
    this.id = config.id;
    this.config = config;
    this.root = this.build('', null, { initial: config.initial, states: config.states });
    this.validate();
  }

  private build(key: string, parent: Node<C, E> | null, config: StateConfig<C, E>): Node<C, E> {
    const path = parent === null || parent.path === '' ? key : `${parent.path}.${key}`;
    const states = config.states ?? {};
    const keys = Object.keys(states);
    if (keys.length > 0 && (config.initial === undefined || !(config.initial in states))) {
      throw new MachineError(`state "${path || this.id}" needs an initial that names one of its children`);
    }
    if (keys.length === 0 && config.initial !== undefined) {
      throw new MachineError(`state "${path}" has an initial but no children`);
    }
    if (config.type === 'final' && keys.length > 0) throw new MachineError(`final state "${path}" cannot have children`);
    const node: Node<C, E> = {
      key,
      path,
      parent,
      depth: parent === null ? 0 : parent.depth + 1,
      config,
      children: new Map(),
      initial: config.initial ?? null
    };
    for (const [childKey, childConfig] of Object.entries(states)) {
      if (childKey.includes('.')) throw new MachineError(`state name "${childKey}" cannot contain a dot`);
      node.children.set(childKey, this.build(childKey, node, childConfig));
    }
    if (parent !== null) this.nodes.set(path, node);
    return node;
  }

  private validate(): void {
    for (const node of this.nodes.values()) {
      for (const [, input] of Object.entries(node.config.on ?? {})) {
        for (const config of this.normalise(input as TransitionInput<C, E>)) this.checkTransition(node, config);
      }
      for (const config of this.normalise(node.config.always)) this.checkTransition(node, config);
    }
  }

  private checkTransition(node: Node<C, E>, config: TransitionConfig<C, E>): void {
    if (config.target !== undefined) this.resolveTarget(node, config.target);
    if (typeof config.guard === 'string' && !this.config.guards?.[config.guard]) {
      throw new MachineError(`unknown guard "${config.guard}" on "${node.path}"`);
    }
  }

  private normalise(input: TransitionInput<C, E> | undefined): TransitionConfig<C, E>[] {
    return toArray(input).map((item) => (typeof item === 'string' ? { target: item } : item));
  }

  private resolveTarget(source: Node<C, E>, target: string): Node<C, E> {
    let found: Node<C, E> | undefined;
    if (target.startsWith('#')) {
      found = this.nodes.get(target.slice(1));
    } else if (target.startsWith('.')) {
      found = this.nodes.get(source.path === '' ? target.slice(1) : `${source.path}${target}`);
    } else {
      for (let scope: Node<C, E> | null = source; scope !== null && found === undefined; scope = scope.parent) {
        const parent = scope.parent;
        if (parent === null) break;
        const prefix = parent.path === '' ? '' : `${parent.path}.`;
        found = this.nodes.get(`${prefix}${target}`);
      }
    }
    if (!found) throw new MachineError(`cannot resolve target "${target}" from "${source.path}"`);
    return found;
  }

  private settle(node: Node<C, E>): Node<C, E> {
    let current = node;
    while (current.initial !== null) current = current.children.get(current.initial)!;
    return current;
  }

  private chain(leaf: Node<C, E>): Node<C, E>[] {
    const out: Node<C, E>[] = [];
    for (let node: Node<C, E> | null = leaf; node !== null && node.parent !== null; node = node.parent) out.push(node);
    return out;
  }

  private runGuard(guard: TransitionConfig<C, E>['guard'], context: C, event: E): boolean {
    if (guard === undefined) return true;
    const fn: Guard<C, E> | undefined = typeof guard === 'string' ? this.config.guards?.[guard] : guard;
    if (!fn) throw new MachineError(`unknown guard "${String(guard)}"`);
    return fn(context, event);
  }

  private select(leaf: Node<C, E>, event: E, context: C): Resolved<C, E> | null {
    for (const node of this.chain(leaf)) {
      const handlers = node.config.on as Record<string, TransitionInput<C, E>> | undefined;
      const candidates = [...this.normalise(handlers?.[event.type]), ...this.normalise(handlers?.['*'])];
      for (const config of candidates) {
        if (this.runGuard(config.guard, context, event)) {
          const target = config.target === undefined ? null : this.resolveTarget(node, config.target);
          return { source: node, target, config };
        }
      }
    }
    return null;
  }

  private selectAlways(leaf: Node<C, E>, event: E, context: C): Resolved<C, E> | null {
    for (const node of this.chain(leaf)) {
      for (const config of this.normalise(node.config.always)) {
        if (this.runGuard(config.guard, context, event)) {
          const target = config.target === undefined ? null : this.resolveTarget(node, config.target);
          return { source: node, target, config };
        }
      }
    }
    return null;
  }

  private isDescendant(node: Node<C, E>, ancestor: Node<C, E>): boolean {
    for (let current = node.parent; current !== null; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }

  private lowestCommonAncestor(source: Node<C, E>, target: Node<C, E>): Node<C, E> {
    if (this.isDescendant(target, source)) return source;
    let candidate = source.parent!;
    while (candidate !== this.root && !this.isDescendant(target, candidate)) candidate = candidate.parent!;
    return candidate;
  }

  private applyActions(
    actions: readonly Action<C, E>[],
    context: C,
    event: E,
    effects: PendingEffect<C, E>[]
  ): C {
    let current = context;
    for (const raw of actions) {
      const action = typeof raw === 'string' ? this.config.actions?.[raw] : raw;
      if (action === undefined) throw new MachineError(`unknown action "${String(raw)}"`);
      if (typeof action === 'string') throw new MachineError(`action "${action}" cannot refer to another name`);
      if (typeof action === 'function') {
        effects.push({ name: action.name || 'anonymous', run: (ctx, ev) => action(ctx, ev as E) });
      } else if (action.kind === 'assign') {
        current = { ...current, ...action.apply(current, event) };
      } else {
        effects.push({ name: action.name, run: (ctx, ev) => action.run(ctx, ev as E) });
      }
    }
    return current;
  }

  private step(leaf: Node<C, E>, context: C, event: E, picked: Resolved<C, E>, effects: PendingEffect<C, E>[]) {
    const { source, target, config } = picked;
    let ctx = context;
    if (target === null) {
      ctx = this.applyActions(toArray(config.actions), ctx, event, effects);
      return { leaf, context: ctx, moved: false };
    }
    const lca = this.lowestCommonAncestor(source, target);
    for (const node of this.chain(leaf)) {
      if (node === lca) break;
      ctx = this.applyActions(toArray(node.config.exit), ctx, event, effects);
      if (node.parent === lca) break;
    }
    ctx = this.applyActions(toArray(config.actions), ctx, event, effects);
    const entering: Node<C, E>[] = [];
    for (let node: Node<C, E> | null = target; node !== null && node !== lca; node = node.parent) entering.unshift(node);
    const destination = this.settle(target);
    for (let node = destination; node !== target; node = node.parent!) entering.push(node);
    const seen = new Set<Node<C, E>>();
    const ordered = [...entering].sort((a, b) => a.depth - b.depth).filter((n) => !seen.has(n) && seen.add(n));
    for (const node of ordered) ctx = this.applyActions(toArray(node.config.entry), ctx, event, effects);
    return { leaf: destination, context: ctx, moved: true };
  }

  eventsFor(value: string): string[] {
    const leaf = this.nodes.get(value);
    if (!leaf) return [];
    const out = new Set<string>();
    for (const node of this.chain(leaf)) {
      for (const key of Object.keys(node.config.on ?? {})) out.add(key);
    }
    return [...out].sort();
  }

  get initialState(): State<C, E> {
    const event: InitEvent = { type: 'lantern.init' };
    const effects: PendingEffect<C, E>[] = [];
    const destination = this.settle(this.root);
    let context = this.config.context;
    const entering: Node<C, E>[] = [];
    for (let node: Node<C, E> | null = destination; node !== null && node !== this.root; node = node.parent) {
      entering.unshift(node);
    }
    for (const node of entering) context = this.applyActions(toArray(node.config.entry), context, event as unknown as E, effects);
    return this.settleEager(destination, context, event as unknown as E, effects, false);
  }

  private settleEager(
    start: Node<C, E>,
    startContext: C,
    event: E,
    effects: PendingEffect<C, E>[],
    changed: boolean
  ): State<C, E> {
    let leaf = start;
    let context = startContext;
    let moved = changed;
    for (let steps = 0; ; steps += 1) {
      const picked = this.selectAlways(leaf, event, context);
      if (!picked) break;
      if (steps >= MAX_EAGER_STEPS) throw new MachineError(`more than ${MAX_EAGER_STEPS} eventless transitions in a row, probably a loop`);
      const next = this.step(leaf, context, event, picked, effects);
      leaf = next.leaf;
      context = next.context;
      moved = moved || next.moved;
    }
    const done = leaf.config.type === 'final' && leaf.depth === 1;
    return new State(leaf.path, context, event, moved, done, effects, this);
  }

  transition(state: State<C, E>, event: E): State<C, E> {
    const leaf = this.nodes.get(state.value);
    if (!leaf) throw new MachineError(`unknown state "${state.value}"`);
    if (state.done) return new State(state.value, state.context, event, false, true, [], this);
    const picked = this.select(leaf, event, state.context);
    if (!picked) return new State(state.value, state.context, event, false, false, [], this);
    const effects: PendingEffect<C, E>[] = [];
    const next = this.step(leaf, state.context, event, picked, effects);
    const settled = this.settleEager(next.leaf, next.context, event, effects, next.moved);
    const changed = settled.changed || settled.context !== state.context || effects.length > 0;
    return new State(settled.value, settled.context, event, changed, settled.done, effects, this);
  }
}

export function createMachine<C, E extends AnyEvent>(config: MachineConfig<C, E>): Machine<C, E> {
  return new Machine(config);
}
