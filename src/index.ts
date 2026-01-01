/**
 * Represents a queued fetch request waiting to be processed.
 */
type QueueItem = {
	resolve: (value: Response | PromiseLike<Response>) => void;
	reject: (reason?: any) => void;
	input: RequestInfo | URL;
	init?: RequestInit;
	abortHandler?: () => void;
	/**
	 * Capture config at call-time so setRateLimitForNewRequests doesn't affect already queued items.
	 */
	windowMs: number;
	limit: number;
};

/**
 * Validates that the window size is a non-negative finite number.
 * @param windowMs The time window in milliseconds.
 * @throws {Error} If validation fails.
 */
function verifyWindowMs(windowMs: any): number {
	if (!Number.isFinite(windowMs)) {
		throw new Error(`windowMs (${windowMs}) must be a finite number`);
	}
	if (windowMs < 0) {
		throw new Error(`windowMs (${windowMs}) must be non-negative`);
	}
	return windowMs;
}

/**
 * Validates that the rate limit is a positive integer.
 * @param limit The maximum number of requests allowed within the window.
 * @throws {Error} If validation fails.
 */
function verifyLimit(limit: any): number {
	if (!Number.isSafeInteger(limit)) {
		throw new Error(`limit (${limit}) must be a safe integer`);
	}
	if (limit <= 0) {
		throw new Error(`limit (${limit}) must be positive`);
	}
	return limit;
}

/**
 * A utility class to rate-limit fetch requests.
 * It ensures that no more than `limit` requests are executed within any `windowMs` time window.
 * It uses a sliding window algorithm based on the history of request execution timestamps.
 */
export default class FetchRateLimited {
	private _windowMs: number;// The window size currently applied to new incoming requests.
	private _limit: number;// The max requests allowed per window for new incoming requests.

	/**
	 * A FIFO queue of requests waiting for their turn.
	 */
	private _queue: QueueItem[] = [];

	/**
	 * A sorted history of timestamps when past requests were actually executed.
	 *
	 * RATIONALE: To enforce a sliding window rate limit, we must remember when previous
	 * requests happened. If "limit" requests have occurred within the last "windowMs",
	 * we must wait.
	 *
	 * MEMORY MANAGEMENT: This array is pruned periodically (see _pruneHistory) to prevent
	 * it from growing infinitely. The challenge is knowing *how much* history to keep
	 * when different requests have different window sizes.
	 */
	private _history: number[] = [];

	/**
	 * The setTimeout for the next scheduled processing of the queue, if any.
	 */
	private _timer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * The maximum windowMs requirement currently present among all queued items.
	 *
	 * RATIONALE: When pruning history, we must be conservative. If we have a request
	 * in the queue that requires a 10-minute window, we cannot prune timestamps
	 * from 5 minutes ago, even if the current global config only requires a 1-minute window.
	 *
	 * This variable defines the "Safe Pruning Horizon".
	 */
	private _maxQueueWindowMs: number = 0;

	/**
	 * Tracks how many items in the queue use each windowMs and limit.
	 * Used to precisely update _maxQueueWindowMs and check for homogeneity in O(1).
	 */
	private _queueWindowCounts = new Map<number, number>();
	private _queueLimitCounts = new Map<number, number>();

	/**
	 * Creates a new FetchRateLimited instance.
	 *
	 * @param options Configuration object.
	 * @param options.windowMs The time window in milliseconds for the rate limit.
	 * @param options.limit The maximum number of requests allowed per window.
	 */
	constructor({ windowMs, limit }: {
		windowMs: number;
		limit: number;
	}) {
		this._windowMs = verifyWindowMs(windowMs);
		this._limit = verifyLimit(limit);
	}

	/**
	 * Updates the rate limit configuration for *future* requests only.
	 * Existing queued requests will retain the configuration they were submitted with.
	 *
	 * @param options New configuration object.
	 * @param options.windowMs The time window in milliseconds for the rate limit.
	 * @param options.limit The maximum number of requests allowed per window.
	 */
	setRateLimitForNewRequests = ({ windowMs, limit }: { windowMs: number; limit: number }): void => {
		this._windowMs = verifyWindowMs(windowMs);
		this._limit = verifyLimit(limit);
	}

	/**
	 * Updates the rate limit configuration for *all* requests, including those currently queued.
	 * This may reschedule the queue processing.
	 *
	 * @param options New configuration object.
	 * @param options.windowMs The time window in milliseconds for the rate limit.
	 * @param options.limit The maximum number of requests allowed per window.
	 */
	setRateLimitForAllRequests = ({ windowMs, limit }: { windowMs: number; limit: number }): void => {
		this._windowMs = verifyWindowMs(windowMs);
		this._limit = verifyLimit(limit);

		for (const item of this._queue) {
			item.windowMs = this._windowMs;
			item.limit = this._limit;
		}
		this._queueWindowCounts.clear();
		this._queueLimitCounts.clear();
		if (this._queue.length > 0) {
			this._queueWindowCounts.set(this._windowMs, this._queue.length);
			this._queueLimitCounts.set(this._limit, this._queue.length);
			this._maxQueueWindowMs = this._windowMs;
		} else {
			this._maxQueueWindowMs = 0;
		}

		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._processQueue();
	}

	/**
	 * Cancels multiple queued requests.
	 * Clears the queue and rejects all pending promises with a specific error.
	 * This does not include requests that have already been dispatched to fetch.
	 */
	rejectPending = (): void => {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}

		const queue = this._queue;
		this._queue = [];
		this._maxQueueWindowMs = 0;
		this._queueWindowCounts.clear();
		this._queueLimitCounts.clear();

		for (const item of queue) {
			this._cleanupItem(item);
			item.reject(new Error('Fetch request was rejected because rejectPending() was called'));
		}
	}

	/**
	 * Immediately processes all queued requests, ignoring rate limits.
	 * Useful for flushing the queue during shutdown or testing.
	 */
	resolvePending = (): void => {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}

		const now = performance.now();
		const queue = this._queue;
		this._queue = [];
		this._maxQueueWindowMs = 0;
		this._queueWindowCounts.clear();
		this._queueLimitCounts.clear();

		for (const item of queue) {
			this._cleanupItem(item);
			this._history.push(now);
			fetch(item.input, item.init).then(item.resolve, item.reject);
		}
	}

	/**
	 * Gets the current rate limit configuration used for new requests.
	 */
	getRateLimitForNewRequests = (): { windowMs: number, limit: number } => {
		return { windowMs: this._windowMs, limit: this._limit };
	}

	/**
	 * Calculates the time in milliseconds until a new request *could* be executed
	 * given the current history and queue, without actually queuing one.
	 *
	 * Use this for estimation/UI purposes.
	 *
	 * @returns Estimated milliseconds to wait (0 if capacity is available immediately).
	 */
	getTimeUntilNextPossibleNewFetchMs = (): number => {
		const now = performance.now();

		// Optimization: If the queue is homogeneous AND matches current config,
		// use O(1) estimation instead of O(N) loop.
		const isQueueHomogeneous = this._queueWindowCounts.size <= 1 && this._queueLimitCounts.size <= 1;
		const matchesCurrentConfig = this._queue.length === 0 || (
			this._queueWindowCounts.has(this._windowMs) && this._queueLimitCounts.has(this._limit)
		);

		if (isQueueHomogeneous && matchesCurrentConfig) {
			const limit = this._limit;
			const windowMs = this._windowMs;

			// The new request would be at index `this._history.length + this._queue.length`.
			// It is blocked by the item `limit` places before it.
			let blockingIndex = (this._history.length + this._queue.length) - limit;

			// If blockingIndex is negative, it means we haven't even filled the first 'limit' slots yet.
			if (blockingIndex < 0) {
				return 0;
			}

			let cycles = 0;
			// Trace back the chain of dependencies.
			// If blockingIndex is in the queue (>= history.length), it is blocked by an earlier item.
			// We subtract 'limit' to jump to that earlier item.
			// Each jump adds one 'windowMs' delay.
			if (blockingIndex >= this._history.length) {
				const dist = blockingIndex - this._history.length;
				const jumps = Math.floor(dist / limit) + 1;

				cycles += jumps;
				blockingIndex -= jumps * limit;
			}

			// Now blockingIndex < this._history.length.
			// If blockingIndex >= 0, we are blocked by a history item.
			// If blockingIndex < 0, the chain started in the queue but had no history blocker (unconstrained).

			if (blockingIndex >= 0) {
				const baseTime = this._history[blockingIndex];
				// cycles jumps from queue -> queue/history + 1 jump for the new request itself
				const nextAllowedTime = baseTime + (cycles + 1) * windowMs;
				return Math.max(0, nextAllowedTime - now);
			} else {
				// The chain root was unblocked (effectively at 'now' or earlier).
				// We just add the window delays for the chain length.
				// cycles represents the number of full windows from the "unblocked" start.
				const nextAllowedTime = now + cycles * windowMs;
				return Math.max(0, nextAllowedTime - now);
			}
		}

		// Fallback for heterogeneous queues (copy history, simulate)
		let simulatedHistory = [...this._history];
		const maxWindowMs = this._getMaxWindowMs();
		const threshold = now - maxWindowMs;
		simulatedHistory = simulatedHistory.filter(t => t > threshold);

		let futureNow = now;
		for (const item of this._queue) {
			const wait = this._calculateWaitTimeForHistory(simulatedHistory, futureNow, item.windowMs, item.limit);
			futureNow += wait;
			simulatedHistory.push(futureNow);
		}

		const finalWait = this._calculateWaitTimeForHistory(simulatedHistory, futureNow, this._windowMs, this._limit);
		return Math.max(0, (futureNow + finalWait) - now);
	}
	/**
	 * Returns the number of requests currently waiting in the queue.
	 * This does not include requests that have already been dispatched to fetch.
	 */
	getPendingCount = (): number => {
		return this._queue.length;
	}

	/**
	 * Executes a fetch request, delaying it if necessary to conform to the rate limit.
	 *
	 * If an `AbortSignal` is provided in `init`, it is respected both while the request
	 * is queued (removing it from the queue) and after it has been dispatched (cancelling
	 * the in-flight network request).
	 * 
	 * In both cases, the returned promise will reject with the `AbortSignal.reason`
	 * (which defaults to an `AbortError` DOMException), ensuring consistent error
	 * handling regardless of the request's state.
	 *
	 * @param input The resource to fetch.
	 * @param init Fetch options, including AbortSignal.
	 * @returns A promise resolving to the Fetch Response.
	 */
	fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (init?.signal?.aborted) {
			return Promise.reject(init.signal.reason);
		}

		return new Promise<Response>((resolve, reject) => {
			const item: QueueItem = {
				resolve,
				reject,
				input,
				init,
				windowMs: this._windowMs,
				limit: this._limit
			};

			if (init?.signal) {
				item.abortHandler = () => {
					this._removeFromQueue(item);
					item.reject(init.signal!.reason);
				};
				init.signal.addEventListener('abort', item.abortHandler, { once: true });
			}

			this._queue.push(item);
			this._addWindowToTracking(item.windowMs, item.limit);
			this._processQueue();
		});
	}

	/**
	 * Removes a specific item from the queue and cleans up its handlers.
	 */
	private _removeFromQueue = (item: QueueItem) => {
		const index = this._queue.indexOf(item);
		if (index !== -1) {
			this._queue.splice(index, 1);
			this._cleanupItem(item);
			this._removeWindowFromTracking(item.windowMs, item.limit);
		}
	}

	/**
	 * Cleans up resources associated with a queue item, such as event listeners.
	 */
	private _cleanupItem = (item: QueueItem) => {
		if (item.init?.signal && item.abortHandler) {
			item.init.signal.removeEventListener('abort', item.abortHandler);
		}
	}

	/**
	 * The main loop. checks the queue and history to decide whether to:
	 * 1. Execute the next request immediately.
	 * 2. Schedule a timer for when the next slot is available.
	 * 3. Do nothing if the queue is empty or a timer is already running.
	 */
	private _processQueue = () => {
		if (this._timer) return;

		const startNow = performance.now();
		const maxWindowMs = this._getMaxWindowMs();
		this._pruneHistory(startNow, maxWindowMs);

		while (this._queue.length > 0) {
			const now = performance.now();
			const headItem = this._queue[0];
			const waitTime = this._calculateWaitTimeForHistory(this._history, now, headItem.windowMs, headItem.limit);

			if (waitTime <= 0) {
				const item = this._queue.shift();
				if (!item) break;

				this._cleanupItem(item);
				this._removeWindowFromTracking(item.windowMs, item.limit);
				this._history.push(now);

				fetch(item.input, item.init).then(item.resolve, item.reject);
			} else {
				this._timer = setTimeout(() => {
					this._timer = null;
					this._processQueue();
				}, waitTime);
				break;
			}
		}
	}

	/**
	 * Calculates how long to wait before executing a request, based on the history of past executions.
	 *
	 * @param history The list of past execution timestamps.
	 * @param now The current timestamp (performance.now()).
	 * @param windowMs The time window size.
	 * @param limit The max requests allowed in the window.
	 * @returns The wait time in milliseconds (0 if can execute immediately).
	 */
	private _calculateWaitTimeForHistory = (history: number[], now: number, windowMs: number, limit: number): number => {
		if (history.length < limit) {
			return 0;
		}
		const blockingTimestamp = history[history.length - limit];
		const nextAllowedTime = blockingTimestamp + windowMs;
		return Math.max(0, nextAllowedTime - now);
	}

	/**
	 * Removes timestamps from history that are older than the "maximum relevant window".
	 *
	 * To ensure the sliding window logic remains correct, we must retain at least
	 * enough history to satisfy the largest windowMs of any item in the queue
	 * OR the current configuration for future requests.
	 *
	 * Uses binary search for O(log n) performance since history is always sorted.
	 */
	private _pruneHistory = (now: number, windowMs: number): void => {
		const threshold = now - windowMs;
		const history = this._history;
		const len = history.length;

		if (len === 0 || history[len - 1] <= threshold) {
			this._history = [];
			return;
		}

		if (history[0] > threshold) {
			return;// All entries are valid
		}

		// Binary search: find the first index where history[i] > threshold
		let low = 0;
		let high = len;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (history[mid] > threshold) {
				high = mid;
			} else {
				low = mid + 1;
			}
		}

		if (low > 0) {
			this._history.splice(0, low);
		}
	}


	/**
	 * Tracks a new windowMs requirement in the queue.
	 */
	private _addWindowToTracking = (windowMs: number, limit: number) => {
		const wCount = this._queueWindowCounts.get(windowMs) ?? 0;
		this._queueWindowCounts.set(windowMs, wCount + 1);

		const lCount = this._queueLimitCounts.get(limit) ?? 0;
		this._queueLimitCounts.set(limit, lCount + 1);

		this._maxQueueWindowMs = Math.max(this._maxQueueWindowMs, windowMs);
	}

	/**
	 * Removes a windowMs requirement from tracking.
	 * If the count reaches zero, recalculates the maximum window size in the queue.
	 */
	private _removeWindowFromTracking = (windowMs: number, limit: number) => {
		const wCount = this._queueWindowCounts.get(windowMs);
		if (wCount !== undefined) {
			if (wCount > 1) {
				this._queueWindowCounts.set(windowMs, wCount - 1);
			} else {
				this._queueWindowCounts.delete(windowMs);
				if (windowMs === this._maxQueueWindowMs) {
					this._maxQueueWindowMs = this._queueWindowCounts.size === 0
						? 0
						: Math.max(...this._queueWindowCounts.keys());
				}
			}
		}

		const lCount = this._queueLimitCounts.get(limit);
		if (lCount !== undefined) {
			if (lCount > 1) {
				this._queueLimitCounts.set(limit, lCount - 1);
			} else {
				this._queueLimitCounts.delete(limit);
			}
		}
	}

	/**
	 * Determines the "Safe Pruning Horizon" — the maximum window size we must
	 * respect to avoid deleting timestamps still needed by queued or future requests.
	 *
	 * It considers BOTH:
	 * 1. The current configuration (this._windowMs) for future requests.
	 * 2. The requirements of all items currently in the queue (this._maxQueueWindowMs).
	 *
	 * This ensures that history pruning is always safe and never breaks the
	 * rate limiting logic for any pending request.
	 */
	private _getMaxWindowMs = (): number => {
		return Math.max(this._windowMs, this._maxQueueWindowMs);
	}
}
