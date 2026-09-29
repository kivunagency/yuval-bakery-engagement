'use client';

import { startTransition, useActionState } from 'react';

// useActionState, but submitted through onSubmit so React does not reset the
// form after the action: on an error the customer's typed values stay put
// (React 19 resets uncontrolled fields after a <form action={fn}> submit).
export function useFormAction<S>(action: (prev: Awaited<S>, form: FormData) => Promise<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initial);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(() => dispatch(form));
  };
  return [state, onSubmit, pending] as const;
}
