// Node 20 lacks a few APIs that pdf.js 6 uses and that Chrome 148+ (our minimum) has natively.
// Only loaded by Vitest and Node tooling; never shipped in the extension.

type WithResolvers = <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e?: unknown) => void };

const P = Promise as unknown as { withResolvers?: WithResolvers };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = <T>() => {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
