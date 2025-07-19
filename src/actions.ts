import type { AnyEvent, AssignAction, EffectAction } from './types.js';

export function assign<C, E extends AnyEvent = AnyEvent>(
  patch: Partial<C> | ((context: C, event: E) => Partial<C>)
): AssignAction<C, E> {
  return {
    kind: 'assign',
    apply: typeof patch === 'function' ? patch : () => patch
  };
}

export function effect<C, E extends AnyEvent = AnyEvent>(
  name: string,
  run: (context: C, event: E) => void
): EffectAction<C, E> {
  return { kind: 'effect', name, run };
}
