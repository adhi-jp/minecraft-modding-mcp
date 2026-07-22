import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  deadlineAt?: number;
  signal?: AbortSignal;
};

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}
