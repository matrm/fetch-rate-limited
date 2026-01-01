import { describe, it, vi, afterAll } from 'vitest';
import FetchRateLimited from '../src/index';

// Interface for performance results
interface PerformanceResult {
	name: string;
	inputs: Record<string, number>;
	durationMs: number;
	complexity: 'O(1)' | 'O(N)';
	status: string;
}

const results: PerformanceResult[] = [];

const measure = async (
	name: string,
	inputs: Record<string, number>,
	complexity: 'O(1)' | 'O(N)',
	fn: () => Promise<void> | void
): Promise<number> => {
	const start = performance.now();
	await fn();
	const end = performance.now();
	const duration = end - start;

	results.push({
		name,
		inputs,
		durationMs: Number(duration.toFixed(3)),
		complexity,
		status: 'pending'
	});

	// Immediate feedback
	const inputStr = Object.entries(inputs)
		.map(([k, v]) => `${k === 'Q' ? 'Queue' : k === 'H' ? 'History' : k === 'count' ? 'Count' : k}:${v}`)
		.join(', ');
	console.log(`[${name}] ${inputStr} | Time: ${duration.toFixed(3)}ms`);
	return duration;
};

// Mock fetch globally
vi.stubGlobal('fetch', async () => {
	return { ok: true } as Response;
});

describe('Performance Check', () => {
	// Print summary table after all tests
	afterAll(() => {
		console.log('\n--- Performance Measurement Summary ---');

		const baselines = new Map<string, PerformanceResult>();

		// Find baselines (smallest sum of inputs for each test name)
		results.forEach(r => {
			const bn = r.name;
			const currentTotal = Object.values(r.inputs).reduce((a, b) => a + b, 0);
			const existingBaseline = baselines.get(bn);
			if (!existingBaseline) {
				baselines.set(bn, r);
			} else {
				const existingTotal = Object.values(existingBaseline.inputs).reduce((a, b) => a + b, 0);
				if (currentTotal < existingTotal) {
					baselines.set(bn, r);
				}
			}
		});

		// Calculate status
		results.forEach(r => {
			const bn = r.name;
			const baseline = baselines.get(bn)!;
			if (r === baseline) {
				r.status = 'normal';
			} else {
				if (r.complexity === 'O(1)') {
					// For O(1), time should be roughly constant regardless of input size.
					// We allow some jitter, but if it grows significantly, it's slow.
					// Threshold: If duration > 2x baseline AND duration > 0.1ms (to ignore noise)
					// This is a heuristic.
					const ratio = r.durationMs / (baseline.durationMs || 1);// safe divide

					// If baseline is 0.005 and current is 0.01, ratio is 2, but it's still negligible.
					// So we check absolute threshold too.
					if (r.durationMs > 0.5 && ratio > 2) {
						r.status = `slow (${ratio.toFixed(2)}x growth)`;
					} else {
						r.status = 'normal';
					}
				} else {
					// O(N) logic
					// We don't assume equal weights for different inputs.
					// A safe upper bound for any linear complexity O(sum(wi * Ii)) is the max ratio of any input.
					let maxRatio = 0;
					for (const key in r.inputs) {
						const val = r.inputs[key];
						const baseVal = baseline.inputs[key] || 1;// Avoid divide by zero
						const ratio = val / baseVal;
						if (ratio > maxRatio) maxRatio = ratio;
					}

					const expectedRatio = maxRatio;
					const actualRatio = r.durationMs / baseline.durationMs;
					const deviation = actualRatio / expectedRatio;

					if (baseline.durationMs === 0) {
						r.status = 'normal (N/A)';
					} else if (deviation <= 1.5 || r.durationMs < 1) {// Also ignore jitter for very fast tests
						r.status = 'normal';
					} else {
						r.status = `slow (${deviation.toFixed(2)}x deviation)`;
					}
				}
			}
		});

		// Simple console.table-like output
		console.log(
			'Test Name'.padEnd(35) +
			'| ' + 'Inputs'.padEnd(33) +
			'| ' + 'Time (ms)'.padEnd(9) +
			'| ' + 'Result'
		);
		console.log('-'.repeat(91));
		results.forEach(r => {
			const inputStr = Object.entries(r.inputs)
				.map(([k, v]) => `${k === 'Q' ? 'Queue' : k === 'H' ? 'History' : k === 'count' ? 'Count' : k}:${v}`)
				.join(', ');
			console.log(
				r.name.padEnd(35) +
				'| ' + inputStr.padEnd(33) +
				'| ' + r.durationMs.toString().padEnd(9) +
				'| ' + r.status
			);
		});
		console.log('-'.repeat(91));
	});

	it('should measure resolvePending complexity', async () => {
		const runTest = async (count: number) => {
			const limiter = new FetchRateLimited({ windowMs: 100000, limit: 1 });// Very slow limit to ensure they pend
			const promises: Promise<any>[] = [];

			// Queue requests
			for (let i = 0; i < count; i++) {
				promises.push(limiter.fetch(`https://api.com/${i}`).catch(() => { }));
			}

			// Measure resolvePending
			await measure('resolvePending (O(N))', { count }, 'O(N)', () => {
				limiter.resolvePending();
			});
		};

		console.log('\nRunning resolvePending tests...');
		await runTest(50000);
		await runTest(250000);
		await runTest(500000);
	}, 20000);

	it('should measure getTimeUntilNextPossibleNewFetchMs complexity', async () => {
		const runTestOptimized = async (queueSize: number, historySize: number) => {
			const limiter = new FetchRateLimited({ windowMs: 100000, limit: 1000000 });

			const historyRequests: Promise<any>[] = [];
			for (let i = 0; i < historySize; i++) {
				historyRequests.push(limiter.fetch('https://api.com/history'));
			}
			await Promise.all(historyRequests);

			limiter.setRateLimitForNewRequests({ windowMs: 100000, limit: 1 });

			const queueRequests: Promise<any>[] = [];
			for (let i = 0; i < queueSize; i++) {
				queueRequests.push(limiter.fetch('https://api.com/queue').catch(() => { }));
			}

			await measure(`getTimeUntilNext (O(1))`, { Q: queueSize, H: historySize }, 'O(1)', () => {
				limiter.getTimeUntilNextPossibleNewFetchMs();
			});

			limiter.rejectPending();
		};

		const runTestUnoptimized = async (queueSize: number, historySize: number) => {
			const limiter = new FetchRateLimited({ windowMs: 100000, limit: 1000000 });

			const historyRequests: Promise<any>[] = [];
			for (let i = 0; i < historySize; i++) {
				historyRequests.push(limiter.fetch('https://api.com/history'));
			}
			await Promise.all(historyRequests);

			// Mixed queue to force O(N) path
			limiter.setRateLimitForNewRequests({ windowMs: 100000, limit: 1 });
			const queueRequests: Promise<any>[] = [];
			for (let i = 0; i < queueSize / 2; i++) {
				queueRequests.push(limiter.fetch('https://api.com/queue1').catch(() => { }));
			}
			limiter.setRateLimitForNewRequests({ windowMs: 200000, limit: 1 });
			for (let i = 0; i < queueSize / 2; i++) {
				queueRequests.push(limiter.fetch('https://api.com/queue2').catch(() => { }));
			}

			await measure(`getTimeUntilNext (O(N))`, { Q: queueSize, H: historySize }, 'O(N)', () => {
				limiter.getTimeUntilNextPossibleNewFetchMs();
			});

			limiter.rejectPending();
		};

		console.log('\nRunning getTimeUntilNextPossibleNewFetchMs (O(1)) tests...');
		await runTestOptimized(1000, 1000);
		await runTestOptimized(1000, 10000);
		await runTestOptimized(1000, 50000);
		await runTestOptimized(10000, 1000);
		await runTestOptimized(50000, 1000);
		await runTestOptimized(100000, 1000);

		console.log('\nRunning getTimeUntilNextPossibleNewFetchMs (O(N)) tests...');
		await runTestUnoptimized(1000, 1000);
		await runTestUnoptimized(1000, 10000);
		await runTestUnoptimized(1000, 50000);
		await runTestUnoptimized(10000, 1000);
		await runTestUnoptimized(50000, 1000);
		await runTestUnoptimized(100000, 1000);
	}, 60000);

	it('should measure setRateLimitForAllRequests complexity', async () => {
		const runTest = async (count: number) => {
			const limiter = new FetchRateLimited({ windowMs: 100000, limit: 1 });
			// Queue requests
			for (let i = 0; i < count; i++) {
				limiter.fetch(`https://api.com/${i}`).catch(() => { });
			}

			// Measure setRateLimitForAllRequests
			// We change to another strict limit so we primarily measure the iteration/update cost
			// rather than the execution of 10,000 requests.
			await measure('setRateLimitForAllRequests (O(N))', { count }, 'O(N)', () => {
				limiter.setRateLimitForAllRequests({ windowMs: 50000, limit: 2 });
			});

			// Cleanup
			limiter.rejectPending();
		};

		console.log('\nRunning setRateLimitForAllRequests tests...');
		await runTest(20000);
		await runTest(100000);
		await runTest(200000);
	}, 20000);
});