import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import FetchRateLimited from '../src/index';

describe('FetchRateLimited', () => {
	// Mock global fetch
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (url) => {
			const urlStr = url.toString();
			const id = urlStr.split('/').pop();
			return {
				json: async () => ({ id, title: `Title ${id}` }),
				ok: true
			};
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Initialization & Validation', () => {
		it('should throw errors for invalid constructor arguments', () => {
			expect(() => new FetchRateLimited({ windowMs: -1, limit: 1 })).toThrow(Error);
			expect(() => new FetchRateLimited({ windowMs: 1000, limit: 0 })).toThrow(Error);
			expect(() => new FetchRateLimited({ windowMs: 1000, limit: -5 })).toThrow(Error);
			expect(() => new FetchRateLimited({ windowMs: 1000, limit: 1.5 })).toThrow(Error);
			expect(() => new FetchRateLimited({ windowMs: 1000, limit: Infinity })).toThrow(Error);
			expect(() => new FetchRateLimited({ windowMs: 1000, limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(Error);
			// @ts-ignore
			expect(() => new FetchRateLimited({ windowMs: '1000', limit: 1 })).toThrow(Error);
		});

		it('should throw errors for invalid setRateLimitForNewRequests arguments', () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			// @ts-ignore
			expect(() => limiter.setRateLimitForNewRequests({ windowMs: -1, limit: 1 })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 0 })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 1.5 })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: NaN })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: Math.pow(2, 53) })).toThrow(Error);
		});

		it('should throw errors for invalid setRateLimitForAllRequests arguments', () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			// @ts-ignore
			expect(() => limiter.setRateLimitForAllRequests({ windowMs: -1, limit: 1 })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 0 })).toThrow(Error);
			// @ts-ignore
			expect(() => limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: NaN })).toThrow(Error);
		});
	});

	describe('Standard Fetching Behavior', () => {
		it('should work when passed as a callback (binding check)', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			class Consumer {
				async doFetch(fn: Function) {
					const res = await fn('https://api/1');
					return res.json();
				}
			}
			const consumer = new Consumer();
			const res = await consumer.doFetch(limiter.fetch);
			expect(res).toEqual({ id: '1', title: 'Title 1' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('should work when passed as a callback (standalone function check)', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			async function executeCallback(fetchFn: Function) {
				const res = await fetchFn('https://api/1');
				return await res.json();
			}
			const res = await executeCallback(limiter.fetch);
			expect(res).toEqual({ id: '1', title: 'Title 1' });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('should pass through all fetch options (method, headers, body) correctly', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 10 });
			const body = JSON.stringify({ foo: 'bar' });
			const headers = { 'Content-Type': 'application/json' };
			const method = 'POST';

			await limiter.fetch('https://api.com/post', { method, headers, body });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.com/post');
			expect(init).toMatchObject({ method, headers, body });
		});

		it('should handle burst requests within rate limits', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 3 });
			const completionTimes: Record<number, number> = {};
			const requests: Promise<any>[] = [];
			const start = performance.now();

			for (let i = 1; i <= 10; i++) {
				const p = limiter.fetch(`https://api/${i}`).then(() => {
					completionTimes[i] = performance.now() - start;
				});
				requests.push(p);
			}

			await vi.runAllTimersAsync();
			await Promise.all(requests);

			expect(completionTimes[1]).toBeLessThan(50);
			expect(completionTimes[2]).toBeLessThan(50);
			expect(completionTimes[3]).toBeLessThan(50);
			expect(completionTimes[4]).toBeGreaterThan(950);
			expect(completionTimes[7]).toBeGreaterThan(1950);
			expect(completionTimes[10]).toBeGreaterThan(2950);
		});

		it('should handle windowMs=0 as effectively no rate limit', async () => {
			const limiter = new FetchRateLimited({ windowMs: 0, limit: 1 });
			const p1 = limiter.fetch('https://api.com/1');
			const p2 = limiter.fetch('https://api.com/2');
			const p3 = limiter.fetch('https://api.com/3');

			await vi.runAllTimersAsync();
			await Promise.all([p1, p2, p3]);
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it('should maintain FIFO order with recursive/chained fetches', async () => {
			const limiter = new FetchRateLimited({ windowMs: 100, limit: 1 });
			const log: string[] = [];

			// A -> triggers C
			const pA = limiter.fetch('https://api/A').then(async () => {
				log.push('Finish A');
				await limiter.fetch('https://api/C').then(() => log.push('Finish C'));
			});

			// B (queued immediately after A)
			const pB = limiter.fetch('https://api/B').then(() => log.push('Finish B'));

			await vi.runAllTimersAsync();
			await Promise.all([pA, pB]);

			expect(log).toEqual(['Finish A', 'Finish B', 'Finish C']);
		});
	});

	describe('Queue & Abort Management', () => {
		describe('Manual Control (resolve/reject)', () => {
			it('rejectPending() should reject requests waiting in queue', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const logs: string[] = [];
				const requests: Promise<any>[] = [];
				for (let i = 1; i <= 6; i++) {
					const p = limiter.fetch(`https://api/${i}`)
						.then(() => logs.push(`success:${i}`))
						.catch((e) => logs.push(`error:${i}:${e.message}`));
					requests.push(p);
				}

				await vi.advanceTimersByTimeAsync(3800);
				expect(limiter.getPendingCount()).toBe(2);
				limiter.rejectPending();

				await vi.runAllTimersAsync();
				await Promise.all(requests);

				expect(logs).toContain('success:1');
				expect(logs).toContain('success:4');
				expect(logs.find(l => l.startsWith('error:5'))).toBeDefined();
				expect(logs.find(l => l.startsWith('error:6'))).toBeDefined();
			});

			it('resolvePending() should immediately execute pending requests', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const logs: string[] = [];
				const requests: Promise<any>[] = [];
				for (let i = 1; i <= 6; i++) {
					const p = limiter.fetch(`https://api/${i}`)
						.then(() => logs.push(`success:${i}`))
						.catch(e => logs.push(`error:${i}:${e.message}`));
					requests.push(p);
				}

				await vi.advanceTimersByTimeAsync(3800);
				expect(limiter.getPendingCount()).toBe(2);
				limiter.resolvePending();

				await vi.runAllTimersAsync();
				await Promise.all(requests);

				for (let i = 1; i <= 6; i++) expect(logs).toContain(`success:${i}`);
			});

			it('should handle resolve/reject on empty queue safely', () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				expect(() => limiter.rejectPending()).not.toThrow();
				expect(() => limiter.resolvePending()).not.toThrow();
				expect(limiter.getPendingCount()).toBe(0);
			});

			it('should continue to work normally after rejectPending() is called', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('https://api.com/1').catch(() => { });
				limiter.fetch('https://api.com/2').catch(() => { });
				expect(limiter.getPendingCount()).toBe(1);

				limiter.rejectPending();
				expect(limiter.getPendingCount()).toBe(0);

				const p = limiter.fetch('https://api.com/3');
				await vi.runAllTimersAsync();
				await p;
				expect(fetchMock).toHaveBeenCalledTimes(2);// Req 1 and Req 3
			});
		});

		describe('Abort Handling', () => {
			it('should support AbortController', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const logs: string[] = [];
				const controllers = Array(6).fill(null).map(() => new AbortController());
				const requests: Promise<any>[] = [];
				for (let i = 1; i <= 6; i++) {
					const p = limiter.fetch(`https://api/${i}`, { signal: controllers[i - 1].signal })
						.then(() => logs.push(`success:${i}`))
						.catch(e => logs.push(`error:${i}:${e.name}`));
					requests.push(p);
				}

				await vi.advanceTimersByTimeAsync(2800);
				controllers[3].abort();// Req 4

				await vi.runAllTimersAsync();
				await Promise.all(requests);

				expect(logs).toContain('success:1');
				expect(logs).toContain('error:4:AbortError');
				expect(logs).toContain('success:6');
			});

			it('should reject immediately if the signal is already aborted', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const controller = new AbortController();
				controller.abort('already aborted');

				const p = limiter.fetch('https://api/1', { signal: controller.signal });
				await expect(p).rejects.toBe('already aborted');
				expect(limiter.getPendingCount()).toBe(0);
				expect(fetchMock).not.toHaveBeenCalled();
			});

			it('should handle a single AbortSignal shared across multiple requests', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const controller = new AbortController();
				const signal = controller.signal;

				const p1 = limiter.fetch('https://api.com/1', { signal });
				const p2 = limiter.fetch('https://api.com/2', { signal });
				const p3 = limiter.fetch('https://api.com/3', { signal });

				await vi.advanceTimersByTimeAsync(500);
				const p2Expect = expect(p2).rejects.toThrow(/aborted/i);
				const p3Expect = expect(p3).rejects.toThrow(/aborted/i);

				controller.abort();
				await Promise.all([p2Expect, p3Expect]);
				expect(limiter.getPendingCount()).toBe(0);
			});

			it('should fill the time gap when a pending request is aborted', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const completionTimes: Record<string, number> = {};
				const start = performance.now();

				limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
				const controller = new AbortController();
				limiter.fetch('https://api/2', { signal: controller.signal }).catch(() => completionTimes['2'] = -1);
				limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);

				await vi.advanceTimersByTimeAsync(500);
				controller.abort();

				await vi.runAllTimersAsync();
				expect(completionTimes['3']).toBeLessThan(1050);// Should run at T=1000
			});

			it('should preserve FIFO order of pending requests after an abort', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const log: string[] = [];
				limiter.fetch('https://api/1').then(() => log.push('1'));
				const controller2 = new AbortController();
				limiter.fetch('https://api/2', { signal: controller2.signal }).catch(() => log.push('2-aborted'));
				limiter.fetch('https://api/3').then(() => log.push('3'));
				limiter.fetch('https://api/4').then(() => log.push('4'));

				await vi.advanceTimersByTimeAsync(500);
				controller2.abort();

				await vi.runAllTimersAsync();
				expect(log).toEqual(['1', '2-aborted', '3', '4']);
			});

			it('should handle aborts correctly after setRateLimitForAllRequests reshuffles the queue', async () => {
				const limiter = new FetchRateLimited({ windowMs: 10000, limit: 1 });
				const completionTimes: Record<string, number> = {};
				const start = performance.now();
				const controller2 = new AbortController();

				limiter.fetch('https://api/1');
				limiter.fetch('https://api/2', { signal: controller2.signal }).catch(() => completionTimes['2'] = -1);
				limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);

				await vi.advanceTimersByTimeAsync(2000);
				limiter.setRateLimitForAllRequests({ windowMs: 5000, limit: 1 });
				controller2.abort();

				await vi.runAllTimersAsync();
				expect(completionTimes['3']).toBeLessThan(5050);
			});

			it('should not crash if abort is triggered after request has started (race condition simulation)', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const controller = new AbortController();

				limiter.fetch('https://api.com/1');
				const p2 = limiter.fetch('https://api.com/2', { signal: controller.signal });

				await vi.advanceTimersByTimeAsync(999);
				const p2Expect = expect(p2).rejects.toThrow(/aborted/i);
				controller.abort();
				await vi.advanceTimersByTimeAsync(1);
				await p2Expect;
				expect(limiter.getPendingCount()).toBe(0);
			});

			it('should handle multiple concurrent aborts mixed with rate limit updates', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const completionTimes: Record<string, number> = {};
				const start = performance.now();
				const c2 = new AbortController();
				const c4 = new AbortController();

				limiter.fetch('https://api/1');
				limiter.fetch('https://api/2', { signal: c2.signal }).catch(() => completionTimes['2'] = -1);
				limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);
				limiter.fetch('https://api/4', { signal: c4.signal }).catch(() => completionTimes['4'] = -1);
				limiter.fetch('https://api/5').then(() => completionTimes['5'] = performance.now() - start);

				await vi.advanceTimersByTimeAsync(500);
				limiter.setRateLimitForAllRequests({ windowMs: 2000, limit: 1 });
				c2.abort();
				c4.abort();

				await vi.runAllTimersAsync();
				expect(completionTimes['3']).toBeLessThan(2050);
				expect(completionTimes['5']).toBeLessThan(4050);
			});

			it('should handle abort immediately after wake-up (race condition)', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const c2 = new AbortController();
				const completionTimes: Record<string, number> = {};

				limiter.fetch('https://api/1');
				limiter.fetch('https://api/2', { signal: c2.signal }).catch(() => completionTimes['2'] = -1);

				await vi.advanceTimersByTimeAsync(500);
				limiter.setRateLimitForAllRequests({ windowMs: 2000, limit: 1 });
				c2.abort();

				await vi.runAllTimersAsync();
				expect(completionTimes['2']).toBe(-1);
				expect(limiter.getPendingCount()).toBe(0);
			});

			it('should properly track state when the queue is manipulated via mixed aborts', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const aborts: AbortController[] = [];
				const promises: Promise<any>[] = [];

				// Queue 5 items.
				for (let i = 0; i < 5; i++) {
					const ac = new AbortController();
					aborts.push(ac);
					promises.push(limiter.fetch(`https://api/${i}`, { signal: ac.signal }).catch(e => e.name));
				}

				// Abort index 1 and 3 (2nd and 4th items)
				aborts[1].abort();
				aborts[3].abort();

				await vi.runAllTimersAsync();
				const results = await Promise.all(promises);

				expect(results[1]).toBe('AbortError');
				expect(results[3]).toBe('AbortError');
				expect(fetchMock).toHaveBeenCalledTimes(3);// 0, 2, 4
			});

			it('should cancel an in-flight request if the signal is aborted', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const controller = new AbortController();

				// Mock a hanging fetch that respects abort
				fetchMock.mockImplementationOnce((url, init) => {
					return new Promise((resolve, reject) => {
						if (init?.signal?.aborted) {
							return reject(new DOMException('The user aborted a request.', 'AbortError'));
						}
						init?.signal?.addEventListener('abort', () => {
							reject(new DOMException('The user aborted a request.', 'AbortError'));
						});
					});
				});

				const p = limiter.fetch('https://api/hang', { signal: controller.signal });

				// Ensure it's picked up (limit is 1, queue empty, so immediate)
				await vi.advanceTimersByTimeAsync(10);
				expect(fetchMock).toHaveBeenCalledTimes(1);

				controller.abort();
				await expect(p).rejects.toThrow(/abort/i);
			});

			it('should throw consistent error types for both queued and in-flight aborts', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });

				// Override mock to simulate browser-like AbortSignal behavior where reason is passed
				fetchMock.mockImplementation((url, init) => {
					return new Promise((resolve, reject) => {
						const signal = init?.signal;
						if (signal?.aborted) {
							return reject(signal.reason);
						}
						signal?.addEventListener('abort', () => {
							reject(signal.reason);
						});
					});
				});

				const customReason = new Error('Custom Abort Reason');

				// Case 1: Abort while queued
				const c1 = new AbortController();
				limiter.fetch('https://api/blocker');// Take the slot
				const pQueued = limiter.fetch('https://api/queued', { signal: c1.signal });

				c1.abort(customReason);// Pass custom reason

				let errQueued: any;
				try { await pQueued; } catch (e) { errQueued = e; }

				// Case 2: Abort while in-flight
				const c2 = new AbortController();
				const pInFlight = limiter.fetch('https://api/inflight', { signal: c2.signal });

				// Advance time to let 'blocker' finish and 'inflight' start
				await vi.advanceTimersByTimeAsync(1100);

				c2.abort(customReason);// Pass SAME custom reason

				let errInFlight: any;
				try { await pInFlight; } catch (e) { errInFlight = e; }

				expect(errQueued).toBeDefined();
				expect(errInFlight).toBeDefined();

				// Verify exact object reference equality
				expect(errQueued).toBe(customReason);
				expect(errInFlight).toBe(customReason);
			});

			it('should never call fetch if a request is aborted while in the queue', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const controller = new AbortController();

				// 1. Occupy the only slot
				limiter.fetch('https://api/blocker');

				// 2. Queue a second request that will be aborted
				const p = limiter.fetch('https://api/aborted', { signal: controller.signal });

				// 3. Abort it while it's still in the queue
				controller.abort();

				await expect(p).rejects.toThrow();

				// 4. Advance time past the window to see if it ever fires
				await vi.advanceTimersByTimeAsync(2000);

				// 5. fetch should have only been called ONCE (for the blocker)
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(fetchMock).not.toHaveBeenCalledWith('https://api/aborted', expect.anything());
			});

			it('should reject with the default AbortError DOMException when no reason is provided', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });

				// Standard mock that just rejects with signal.reason
				fetchMock.mockImplementation((url, init) => {
					return new Promise((resolve, reject) => {
						const signal = init?.signal;
						if (signal?.aborted) return reject(signal.reason);
						signal?.addEventListener('abort', () => reject(signal.reason));
					});
				});

				// 1. Queued
				const c1 = new AbortController();
				limiter.fetch('https://api/block');
				const p1 = limiter.fetch('https://api/1', { signal: c1.signal });
				c1.abort();
				let err1: any;
				try { await p1; } catch (e) { err1 = e; }

				// 2. In-flight
				const c2 = new AbortController();
				const p2 = limiter.fetch('https://api/2', { signal: c2.signal });
				await vi.advanceTimersByTimeAsync(1100);
				c2.abort();
				let err2: any;
				try { await p2; } catch (e) { err2 = e; }

				// Verify it matches the platform's default AbortError
				// (In Node 21+ and Browsers, this is a DOMException with name 'AbortError')
				expect(err1.name).toBe('AbortError');
				expect(err2.name).toBe('AbortError');
				expect(err1).toBeInstanceOf(DOMException);
				expect(err2).toBeInstanceOf(DOMException);

				// They should both be the same type of object as signal.reason
				expect(err1).toBe(c1.signal.reason);
				expect(err2).toBe(c2.signal.reason);
			});
		});
	});

	describe('Dynamic Configuration', () => {
		it('should allow updating the rate limit for new requests', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const logs: string[] = [];
			limiter.fetch('https://api/1').then(() => logs.push('1'));
			limiter.fetch('https://api/2').then(() => logs.push('2'));
			expect(limiter.getPendingCount()).toBe(1);

			limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 2 });
			limiter.fetch('https://api/3').then(() => logs.push('3'));

			await vi.runAllTimersAsync();
			expect(logs).toEqual(expect.arrayContaining(['1', '3', '2']));
			expect(limiter.getRateLimitForNewRequests()).toEqual({ windowMs: 1000, limit: 2 });
		});

		it('should reschedule pending requests when setRateLimitForAllRequests is called', async () => {
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(1000);
			limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 1 });

			await vi.runAllTimersAsync();
			expect(completionTimes['2']).toBeLessThan(1100);
		});

		it('should allow a burst of pending requests to execute immediately if limit > 1 after reducing window', async () => {
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: 2 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1');
			limiter.fetch('https://api/2');
			limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);
			limiter.fetch('https://api/4').then(() => completionTimes['4'] = performance.now() - start);
			limiter.fetch('https://api/5').then(() => completionTimes['5'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(5000);
			limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 2 });

			await vi.runAllTimersAsync();
			expect(completionTimes['3']).toBeLessThan(5050);
			expect(completionTimes['4']).toBeLessThan(5050);
			expect(completionTimes['5']).toBeGreaterThan(5950);
		});

		it('should delay pending requests when setRateLimitForAllRequests increases the window', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(500);
			limiter.setRateLimitForAllRequests({ windowMs: 5000, limit: 1 });

			await vi.runAllTimersAsync();
			expect(completionTimes['2']).toBeGreaterThan(4950);
		});

		it('should reschedule pending requests when setRateLimitForAllRequests increases the limit', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(500);
			limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 2 });

			await vi.runAllTimersAsync();
			expect(completionTimes['2']).toBeLessThan(550);
		});

		it('should delay pending requests when setRateLimitForAllRequests decreases the limit', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 2 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			await vi.advanceTimersByTimeAsync(500);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);
			limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(100);
			limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 1 });

			await vi.runAllTimersAsync();
			expect(completionTimes['3']).toBeGreaterThan(1450);
		});

		it('should handle multiple updates to setRateLimitForNewRequests interlaced with requests', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);

			limiter.setRateLimitForNewRequests({ windowMs: 500, limit: 1 });
			limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);

			limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 2 });
			limiter.fetch('https://api/4').then(() => completionTimes['4'] = performance.now() - start);

			limiter.setRateLimitForNewRequests({ windowMs: 2000, limit: 1 });
			limiter.fetch('https://api/5').then(() => completionTimes['5'] = performance.now() - start);

			await vi.runAllTimersAsync();
			expect(completionTimes['3']).toBeGreaterThan(1450);
			expect(completionTimes['4']).toBeGreaterThan(1950);
			expect(completionTimes['5']).toBeGreaterThan(3950);
		});

		it('should strictly respect rejectPending even if raced with setRateLimitForAllRequests', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1');
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start).catch(() => completionTimes['2'] = -1);

			await vi.advanceTimersByTimeAsync(500);
			limiter.setRateLimitForAllRequests({ windowMs: 2000, limit: 1 });
			limiter.rejectPending();

			await vi.runAllTimersAsync();
			expect(completionTimes['2']).toBe(-1);
		});

		it('should handle rapid configuration changes without losing consistency', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			const p1 = limiter.fetch('https://api/1');
			for (let i = 0; i < 100; i++) limiter.setRateLimitForAllRequests({ windowMs: 1000 + i, limit: 1 });
			const p2 = limiter.fetch('https://api/2');

			await vi.runAllTimersAsync();
			await p1;
			await p2;
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('should handle multiple updates to setRateLimitForAllRequests interlaced with requests', async () => {
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: 1 });
			const completionTimes: Record<string, number> = {};
			const start = performance.now();

			limiter.fetch('https://api/1').then(() => completionTimes['1'] = performance.now() - start);
			limiter.fetch('https://api/2').then(() => completionTimes['2'] = performance.now() - start);
			limiter.fetch('https://api/3').then(() => completionTimes['3'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(2000);
			limiter.setRateLimitForAllRequests({ windowMs: 1000, limit: 1 });

			limiter.fetch('https://api/4').then(() => completionTimes['4'] = performance.now() - start);

			await vi.advanceTimersByTimeAsync(500);
			limiter.setRateLimitForAllRequests({ windowMs: 5000, limit: 1 });

			await vi.runAllTimersAsync();
			expect(completionTimes['2']).toBeLessThan(2050);
			expect(completionTimes['3']).toBeGreaterThan(6950);
			expect(completionTimes['4']).toBeGreaterThan(11950);
		});

		it('should unleash a "thundering herd" when limit is drastically increased', async () => {
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: 1 });
			const completionTimes: number[] = [];
			const start = performance.now();

			// Queue 10 items
			const promises = [];
			for (let i = 0; i < 10; i++) {
				promises.push(limiter.fetch(`https://api/${i}`).then(() => {
					completionTimes.push(performance.now() - start);
				}));
			}

			// Advance slightly to let the first one execute
			await vi.advanceTimersByTimeAsync(10);
			// 1 started. 9 pending.

			// Open the floodgates
			limiter.setRateLimitForAllRequests({ windowMs: 10000, limit: 100 });

			await vi.runAllTimersAsync();
			await Promise.all(promises);

			// All should have finished effectively immediately after the update
			// The first one finished near 0. The rest should finish near the update time (10ms).
			// None should wait for the 10s window.
			expect(completionTimes.length).toBe(10);
			for (const time of completionTimes) {
				expect(time).toBeLessThan(500);// Well below 10000
			}
		});

		it('should verify correct behavior when switching from large to small window (Mixed Queue)', async () => {
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: 5 });
			// Generate history: 5 requests at T=0
			for (let i = 0; i < 5; i++) limiter.fetch(`https://api.com/setup/${i}`);
			await vi.runAllTimersAsync();

			// Advance to T=2000
			// History: [0, 0, 0, 0, 0].
			// These are VALID for Window=10000 (expire at 10000).
			// These are EXPIRED for Window=1000 (expire at 1000).
			await vi.advanceTimersByTimeAsync(2000);

			// Queue Small Window Request (Limit 1, Window 1000).
			// The rate limiter should recognize that the old history items (T=0)
			// do not block this new request (Window=1000, Now=2000),
			// either via expiration or semantic counting.
			limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 1 });
			const start = performance.now();
			const pSmall = limiter.fetch('https://api.com/small').then(() => performance.now() - start);

			// Queue Large Window Request (Window 10000) immediately after.
			// This forces _maxQueueWindowMs to be 10000, preventing pruning of T=0 history,
			// ensuring the small request must correctly handle the presence of "irrelevant" history.
			limiter.setRateLimitForNewRequests({ windowMs: 10000, limit: 1 });
			limiter.fetch('https://api.com/large');

			await vi.runAllTimersAsync();
			const elapsed = await pSmall;

			// Should execute immediately.
			expect(elapsed).toBeLessThan(50);
		});
	});

	describe('Monitoring & Utility Methods', () => {
		describe('getTimeUntilNextPossibleNewFetchMs', () => {
			it('should return 0 for empty history and empty queue', () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBe(0);
			});

			it('should return correct wait time when blocked by history (Optimization O(1))', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('https://api/1');// T=0
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(900);

				await vi.advanceTimersByTimeAsync(500);
				const wait = limiter.getTimeUntilNextPossibleNewFetchMs();
				expect(wait).toBeGreaterThan(400);
				expect(wait).toBeLessThanOrEqual(500);
			});

			it('should return correct wait time when blocked by queue (Optimization O(1))', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('https://api/1');// Exec T=0
				limiter.fetch('https://api/2');// Queued, will exec T=1000

				// New request (3rd) should wait until T=2000
				const wait = limiter.getTimeUntilNextPossibleNewFetchMs();
				expect(wait).toBeGreaterThan(1900);
				expect(wait).toBeLessThanOrEqual(2000);
			});

			it('should handle limit > 1 correctly (Optimization O(1))', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 2 });
				limiter.fetch('1');// T=0
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBe(0);// Still capacity

				limiter.fetch('2');// T=0
				// Capacity reached. Next available slot when '1' expires at T=1000.
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(900);

				limiter.fetch('3');// Queued, will exec T=1000 (replacing '1')
				// Next available slot when '2' expires at T=1000 (for 4th request)
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(900);

				limiter.fetch('4');// Queued, will exec T=1000 (replacing '2')
				// Items: Req 1(H), Req 2(H), Req 3(Q), Req 4(Q), [Req 5].
				// Req 5 depends on Req 3 (item at index 2).
				// Req 3 will start at T=1000, expire at T=2000.
				// So Req 5 can start at 2000.
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(1900);
			});

			it('should handle deep queue with many jumps (Optimization O(1))', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				for (let i = 0; i < 5; i++) limiter.fetch(String(i));
				// 0: start 0, expires 1000
				// ...
				// 4: start 4000, expires 5000
				// [New]: starts 5000
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(4900);
			});

			it('should fallback to simulation for heterogeneous queues', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('1');// T=0, window 1000. Expire T=1000.

				limiter.setRateLimitForNewRequests({ windowMs: 5000, limit: 1 });
				limiter.fetch('2');// Queue. Starts T=5000 (must wait for Req 1 to be 5000ms ago), window 5000.

				limiter.setRateLimitForNewRequests({ windowMs: 2000, limit: 1 });
				const wait = limiter.getTimeUntilNextPossibleNewFetchMs();
				expect(wait).toBeGreaterThan(6900);
				expect(wait).toBeLessThanOrEqual(7000);
			});

			it('should handle mixed window sizes and limits in fallback', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('1');// T=0, L=1, W=1000. Expire 1000.

				// Change limit for next queued items
				limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 2 });
				limiter.fetch('2');// Queue. Starts T=1000.
				limiter.fetch('3');// Queue. Starts T=1000.

				// New Request (L=1, W=1000):
				limiter.setRateLimitForNewRequests({ windowMs: 1000, limit: 1 });

				// Simulated history after Req 3: [0, 0, 1000].
				// blocking = history[3-1] = history[2] = 1000.
				// Next allowed = 1000 + 1000 = 2000.

				const wait = limiter.getTimeUntilNextPossibleNewFetchMs();
				expect(wait).toBeGreaterThan(1900);
				expect(wait).toBeLessThanOrEqual(2000);
			});

			it('should return 0 when time passes and history expires', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('1');
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(900);

				await vi.advanceTimersByTimeAsync(1001);
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBe(0);
			});

			it('should correctly calculate wait time in the "unblocked chain" scenario (Internal State)', () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				const item = { resolve: () => { }, reject: () => { }, input: 'http://api', windowMs: 1000, limit: 1 };

				// Manually inject state: 3 items in queue, NO history.
				// @ts-ignore
				limiter._queue = [item, item, item];
				// @ts-ignore
				limiter._queueWindowCounts.set(1000, 3);
				// @ts-ignore
				limiter._queueLimitCounts.set(1, 3);
				// @ts-ignore
				limiter._history = [];

				// New Req (4th) blocker is 3rd item in queue (index 2).
				// 3 cycles * 1000ms = 3000ms.
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBe(3000);
			});

			it('should reset wait time after rejectPending()', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('1');
				limiter.fetch('2').catch(() => { });// Catch rejection

				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(1900);
				limiter.rejectPending();
				// Now only blocked by '1' in history
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeLessThanOrEqual(1000);
			});

			it('should update wait time after resolvePending()', async () => {
				const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
				limiter.fetch('1');
				limiter.fetch('2');

				limiter.resolvePending();
				// Both in history now at T=0. 3rd req blocked by Req 2 @ 0.
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeGreaterThan(900);
				expect(limiter.getTimeUntilNextPossibleNewFetchMs()).toBeLessThanOrEqual(1000);
			});
		});

		it('getPendingCount() should accurately reflect queue size', () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			limiter.fetch('1').catch(() => { });
			limiter.fetch('2').catch(() => { });
			expect(limiter.getPendingCount()).toBe(1);
			limiter.rejectPending();
			expect(limiter.getPendingCount()).toBe(0);
		});
	});

	describe('Internal Resilience & State Maintenance', () => {
		it('should propagate network errors and continue processing the queue', async () => {
			const limiter = new FetchRateLimited({ windowMs: 100, limit: 1 });
			fetchMock.mockRejectedValueOnce(new Error('Network Failure'));

			const p1 = limiter.fetch('https://api/fail').catch(e => e.message);
			const p2 = limiter.fetch('https://api/success');

			await vi.runAllTimersAsync();
			const results = await Promise.all([p1, p2]);
			expect(results[0]).toBe('Network Failure');
			expect(results[1].ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('should properly prune history to prevent memory leaks', async () => {
			const limiter = new FetchRateLimited({ windowMs: 100, limit: 10 });
			for (let i = 0; i < 50; i++) {
				for (let j = 0; j < 10; j++) limiter.fetch('https://api/test');
				await vi.advanceTimersByTimeAsync(200);
			}
			// @ts-ignore
			expect(limiter._history.length).toBe(10);
			await limiter.fetch('https://api/final');
			// @ts-ignore
			expect(limiter._history.length).toBe(1);
		});

		it('should not stack overflow when processing a large number of immediate requests', async () => {
			const limit = 20000;
			const limiter = new FetchRateLimited({ windowMs: 10000, limit: limit + 100 });
			const requests: Promise<Response>[] = [];
			for (let i = 0; i < limit; i++) requests.push(limiter.fetch(`https://api/${i}`));

			await vi.runAllTimersAsync();
			await Promise.all(requests);
			expect(fetchMock).toHaveBeenCalledTimes(limit);
		});

		it('should reset _maxQueueWindowMs to 0 if setRateLimitForAllRequests is called on an empty queue', () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			// @ts-ignore
			expect(limiter._maxQueueWindowMs).toBe(0);
			limiter.setRateLimitForAllRequests({ windowMs: 5000, limit: 5 });
			// @ts-ignore
			expect(limiter._maxQueueWindowMs).toBe(0);
		});

		it('should set _maxQueueWindowMs correctly on non-empty queue', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			limiter.fetch('https://api.com/0');
			limiter.fetch('https://api.com/1');
			limiter.setRateLimitForAllRequests({ windowMs: 5000, limit: 1 });
			// @ts-ignore
			expect(limiter._maxQueueWindowMs).toBe(5000);
		});

		it('should precisely track _maxQueueWindowMs when queue is emptied', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });
			limiter.fetch('https://api.com/0');
			limiter.setRateLimitForNewRequests({ windowMs: 5000, limit: 1 });
			limiter.fetch('https://api.com/1');
			// @ts-ignore
			expect(limiter._maxQueueWindowMs).toBe(5000);

			await vi.runAllTimersAsync();
			// @ts-ignore
			expect(limiter._maxQueueWindowMs).toBe(0);
		});

		it('should initiate the next request even if the previous one is still pending (slow response)', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1000, limit: 2 });

			// Make fetch return a promise that doesn't resolve immediately
			let resolveSlow: any;
			const slowPromise = new Promise<any>((res) => { resolveSlow = res; });
			fetchMock.mockReturnValueOnce(slowPromise);

			const p1 = limiter.fetch('https://api/slow');// Initiates immediately
			const p2 = limiter.fetch('https://api/fast');// Should also initiate immediately because limit is 2

			await vi.advanceTimersByTimeAsync(10);

			expect(fetchMock).toHaveBeenCalledTimes(2);// Both initiated
			expect(limiter.getPendingCount()).toBe(0);

			resolveSlow({ ok: true });// Clean up
			await Promise.all([p1, p2]);
		});

		it('should handle fractional windowMs gracefully', async () => {
			// windowMs 10.5ms.
			const limiter = new FetchRateLimited({ windowMs: 10.5, limit: 1 });
			const start = performance.now();
			const times: number[] = [];

			const p1 = limiter.fetch('https://api/1').then(() => times.push(performance.now() - start));
			const p2 = limiter.fetch('https://api/2').then(() => times.push(performance.now() - start));

			await vi.runAllTimersAsync();
			await Promise.all([p1, p2]);

			expect(times[0]).toBeLessThan(5);
			// Should wait ~10.5ms. Rounding might happen in setTimeout or engine.
			// Generally expect >= 10.
			expect(times[1]).toBeGreaterThanOrEqual(10);
		});

		it('should handle high-precision windowMs accurately', async () => {
			const limiter = new FetchRateLimited({ windowMs: 1, limit: 1 });

			limiter.fetch('https://api/1');
			limiter.fetch('https://api/2');
			await vi.runAllTimersAsync();

			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});
});