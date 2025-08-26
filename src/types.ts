export interface AnyEvent {
  readonly type: string;
}

export type Guard<C, E extends AnyEvent> = (context: C, event: E) => boolean;

export interface AssignAction<C, E extends AnyEvent> {
  readonly kind: 'assign';
  apply(context: C, event: E): Partial<C>;
}

export interface EffectAction<C, E extends AnyEvent> {
  readonly kind: 'effect';
  readonly name: string;
  run(context: C, event: E): void;
}

export type Action<C, E extends AnyEvent> = string | EffectAction<C, E> | AssignAction<C, E> | ((context: C, event: E) => void);

export interface TransitionConfig<C, E extends AnyEvent> {
  readonly target?: string;
  readonly guard?: Guard<C, E> | string;
  readonly actions?: Action<C, E> | readonly Action<C, E>[];
}

export type TransitionInput<C, E extends AnyEvent> = string | TransitionConfig<C, E> | readonly (string | TransitionConfig<C, E>)[];

export type EventHandlers<C, E extends AnyEvent> = {
  readonly [K in E['type']]?: TransitionInput<C, Extract<E, { type: K }>>;
} & { readonly '*'?: TransitionInput<C, E> };

export interface StateConfig<C, E extends AnyEvent> {
  readonly initial?: string;
  readonly type?: 'final';
  readonly states?: Readonly<Record<string, StateConfig<C, E>>>;
  readonly on?: EventHandlers<C, E>;
  readonly always?: TransitionInput<C, E>;
  readonly entry?: Action<C, E> | readonly Action<C, E>[];
  readonly exit?: Action<C, E> | readonly Action<C, E>[];
}

export interface MachineOptions<C, E extends AnyEvent> {
  readonly guards?: Readonly<Record<string, Guard<C, E>>>;
  readonly actions?: Readonly<Record<string, Action<C, E>>>;
}

export interface MachineConfig<C, E extends AnyEvent> extends MachineOptions<C, E> {
  readonly id: string;
  readonly initial: string;
  readonly context: C;
  readonly states: Readonly<Record<string, StateConfig<C, E>>>;
}

export interface PendingEffect<C, E extends AnyEvent> {
  readonly name: string;
  readonly run: (context: C, event: E | InitEvent) => void;
}

export interface InitEvent {
  readonly type: 'lantern.init';
}
