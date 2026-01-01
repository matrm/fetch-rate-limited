# Fetch Rate Limited

A lightweight, zero-dependency TypeScript library for rate-limiting `fetch` calls. It ensures you stay within API limits by using a sliding-window algorithm, with full support for `AbortSignal` and dynamic configuration.

## Features
- **Sliding Window**: Precise rate limiting based on request history.
- **Dynamic Updates**: Change rate limits on the fly for currently queued and/or future requests.
- **AbortSignal Support**: Cancel queued requests cleanly without consuming rate-limit slots.
- **Queue Management**: Inspect queued request counts or flush/reject the entire queue.
- **Zero Dependencies**: Core logic with no external overhead.
- **Type Safe**: Written in TypeScript with full type definitions.

## Install
```bash
npm install fetch-rate-limited
```

## Quick Start
This example limits requests to **3 every 1 second**.

```javascript
import FetchRateLimited from 'fetch-rate-limited';

const limiter = new FetchRateLimited({ windowMs: 1000, limit: 3 });

const data = [1, 2, 3, 4, 5, 6, 7];
const urls = data.map(id => `https://jsonplaceholder.typicode.com/todos/${id}`);

// Requests are automatically throttled to 3 per second
const responses = await Promise.all(
	urls.map(url => limiter.fetch(url).catch(console.error))
);

const results = await Promise.all(responses.map(res => res?.json()));
console.log(results);
```

## API Reference

### `new FetchRateLimited(options)`
Creates a new limiter instance.
- `options.windowMs`: The time window in milliseconds.
- `options.limit`: Max number of requests allowed per window.

### `fetch(input, init?)`
The primary method, which matches the native `fetch` signature but automatically applies rate limiting. It is pre-bound, so it can be safely passed around as a standalone callback. Returns a `Promise<Response>`.

### `setRateLimitForNewRequests({ windowMs, limit })`
Updates the limit for future calls to `fetch`. Currently queued requests keep their original limits.

### `setRateLimitForAllRequests({ windowMs, limit })`
Updates the limit for currently queued and future calls to `fetch`.

### `getRateLimitForNewRequests()`
Returns the current `{ windowMs, limit }` configuration used for new requests.

### `getPendingCount()`
Returns the number of requests currently waiting in the queue. This does not include requests that have already been dispatched to fetch.

### `getTimeUntilNextPossibleNewFetchMs()`
Estimates how long (in ms) until the next request can be executed.

### `rejectPending()`
Cancels all queued requests, causing their promises to reject. This does not include requests that have already been dispatched to fetch.

### `resolvePending()`
Immediately executes all queued requests, ignoring rate limits.

## Advanced Usage

### Dynamic Rate Limiting
```javascript
// Change to 10 requests per 2 seconds for currently queued and future requests
limiter.setRateLimitForAllRequests({ windowMs: 2000, limit: 10 });
```

### AbortSignal Support
Full support for `AbortSignal` is provided.

1. **Queued Requests**: If a request is aborted while waiting in the queue, it is immediately removed and the promise rejects with the `AbortSignal.reason` (defaults to `AbortError`). It does *not* consume a rate-limit slot.
2. **In-Flight Requests**: If a request has already been dispatched, the signal is forwarded to the underlying `fetch` call. The promise will reject with the exact same `AbortSignal.reason`.

```javascript
const controller = new AbortController();
const signal = controller.signal;

// This request will wait in the queue
const fetchPromise = limiter.fetch('https://api.example.com/data', { signal });

// Cancel it before it starts
controller.abort();

try {
	await fetchPromise;
} catch (err) {
	console.log('Request aborted:', err.name);// 'AbortError'
}
```

## Requirements
- **Node.js**: 21.0.0 or higher (for native fetch support).
- **Environment**: Works in any environment with a global `fetch` and `performance.now()`.

## License
[MIT](./LICENSE.txt)