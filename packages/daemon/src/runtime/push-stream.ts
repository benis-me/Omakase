/**
 * A single-producer / single-consumer async stream backed by a buffer. Used to
 * adapt Node's event-emitter stdio (and the fake transport's scripted output)
 * into an `AsyncIterable<string>` that consumers can drive with `for await`.
 */
export interface PushStream<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
  readonly iterable: AsyncIterable<T>;
}

type Pending<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};

export function createPushStream<T>(): PushStream<T> {
  const values: T[] = [];
  const waiters: Pending<T>[] = [];
  let closed = false;
  let failure: { error: unknown } | undefined;

  const doneResult: IteratorResult<T> = {
    value: undefined as never,
    done: true,
  };

  const pump = (): void => {
    while (waiters.length > 0) {
      if (values.length > 0) {
        waiters.shift()!.resolve({ value: values.shift() as T, done: false });
        continue;
      }
      if (failure) {
        waiters.shift()!.reject(failure.error);
        continue;
      }
      if (closed) {
        waiters.shift()!.resolve(doneResult);
        continue;
      }
      break;
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift() as T, done: false });
          }
          if (failure) return Promise.reject(failure.error);
          if (closed) return Promise.resolve(doneResult);
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          return Promise.resolve(doneResult);
        },
      };
    },
  };

  return {
    push(value: T): void {
      if (closed || failure) return;
      values.push(value);
      pump();
    },
    end(): void {
      if (closed) return;
      closed = true;
      pump();
    },
    fail(error: unknown): void {
      if (failure || closed) return;
      failure = { error };
      pump();
    },
    iterable,
  };
}
