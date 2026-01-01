import FetchRateLimited from '../src/index';

function sleepMs(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function logTestHeader(name: string, expectedOutcome: string) {
	console.log('\n' + '='.repeat(80));
	console.log(`TEST: ${name}`);
	console.log(`EXPECTATION: ${expectedOutcome}`);
	console.log('-'.repeat(80));
}

function submitRequests(
	fetchRateLimited: FetchRateLimited,
	numRequests: number,
	abortControllers?: AbortController[]
): Promise<any>[] {
	const startTime = performance.now();
	const requests: Promise<any>[] = [];
	for (let i = 1; i <= numRequests; i++) {
		const options = abortControllers ? { signal: abortControllers[i - 1].signal } : undefined;
		const req = fetchRateLimited.fetch(`https://jsonplaceholder.typicode.com/todos/${i}`, options)
			.then(res => res.json())
			.then(obj => {
				const elapsed = Math.floor(performance.now() - startTime);
				console.log(`Request #${i} resolved at ${elapsed}ms`);
			})
			.catch(err => {
				const elapsed = Math.floor(performance.now() - startTime);
				console.log(`Request #${i} rejected at ${elapsed}ms: ${err.message}`);
			});
		requests.push(req);
	}
	console.log(`${numRequests} requests submitted.`);
	return requests;
}

async function testCallbackFetch() {
	logTestHeader(
		'Callback Fetch Context',
		'Should successfully make a request when the fetch function is passed as a callback.'
	);

	const fetchRateLimited = new FetchRateLimited({ windowMs: 1000, limit: 1 });

	// Simulate passing the fetch function to another context
	async function executeCallback(fetchFn: Function) {
		const res = await fetchFn('https://jsonplaceholder.typicode.com/todos/1');
		return await res.json();
	}

	try {
		const res = await executeCallback(fetchRateLimited.fetch);
		console.log('Request successful:', !!res && !!res.id);
	} catch (e: any) {
		console.error('Request failed:', e.message);
	}
}

async function testRejectPending() {
	logTestHeader(
		'rejectPending()',
		'Submitting 6 requests (Limit: 1/1s). Requests 1-4 should start over 3s. After 3.8s, rejectPending() is called. Requests 5-6 (still pending) should be rejected.'
	);

	const fetchRateLimited = new FetchRateLimited({ windowMs: 1000, limit: 1 });
	const requests = submitRequests(fetchRateLimited, 6);

	// Wait until just before the 5th request would start (approx 4000ms)
	// 1st: 0ms, 2nd: 1000ms, 3rd: 2000ms, 4th: 3000ms
	// We wait 3800ms.
	await sleepMs(3800);

	console.log(`Calling rejectPending(). Pending count: ${fetchRateLimited.getPendingCount()}`);
	fetchRateLimited.rejectPending();

	await Promise.all(requests);
	console.log('All requests finished.');
}

async function testResolvePending() {
	logTestHeader(
		'resolvePending()',
		'Submitting 6 requests (Limit: 1/1s). After 3.8s, resolvePending() is called. Requests 5-6 (still pending) should start immediately regardless of rate limit.'
	);

	const fetchRateLimited = new FetchRateLimited({ windowMs: 1000, limit: 1 });
	const requests = submitRequests(fetchRateLimited, 6);

	await sleepMs(3800);

	console.log(`Calling resolvePending(). Pending count: ${fetchRateLimited.getPendingCount()}`);
	fetchRateLimited.resolvePending();

	await Promise.all(requests);
	console.log('All requests finished.');
}

async function testAbortController() {
	logTestHeader(
		'AbortController',
		'Submitting 6 requests. Aborting the 4th request while it is queued (or processing). Expectation: 4th request rejects with AbortError.'
	);

	const fetchRateLimited = new FetchRateLimited({ windowMs: 1000, limit: 1 });
	const numRequests = 6;
	const abortControllers = Array(numRequests).fill(null).map(() => new AbortController());

	const requests = submitRequests(fetchRateLimited, numRequests, abortControllers);

	// Wait 2800ms.
	// 1(0ms), 2(1000ms), 3(2000ms) should be done or running.
	// 4(3000ms) is pending.
	await sleepMs(2800);
	console.log('Aborting request #4');
	abortControllers[3].abort();// Index 3 is request #4

	await Promise.all(requests);
	console.log('All requests finished.');
}

async function testBurst() {
	logTestHeader(
		'Burst Requests',
		'Limit 3 per 1s. 10 Requests. Expectation: 1-3 immediate, 4-6 at ~1s, 7-9 at ~2s, 10 at ~3s.'
	);

	const fetchRateLimited = new FetchRateLimited({ windowMs: 1000, limit: 3 });
	const requests = submitRequests(fetchRateLimited, 10);

	await Promise.all(requests);
	console.log('All requests finished.');
}

async function testREADMEAbortExample() {
	logTestHeader(
		'README AbortSignal Example',
		"Should throw 'AbortError' when aborted while in queue."
	);

	const limiter = new FetchRateLimited({ windowMs: 1000, limit: 1 });

	// Occupy the first slot so the next request waits in the queue
	limiter.fetch('https://jsonplaceholder.typicode.com/todos/1').catch(() => { });

	const controller = new AbortController();
	const signal = controller.signal;

	// This request will wait in the queue
	const fetchPromise = limiter.fetch('https://jsonplaceholder.typicode.com/todos/2', { signal });

	// Cancel it before it starts
	controller.abort();

	try {
		await fetchPromise;
		console.error('Test Failed: fetchPromise did not throw');
	} catch (err: any) {
		console.log('Request aborted:', err.name);// 'AbortError'
	}
}

async function testQuickStart() {
	logTestHeader(
		'README Quick Start Example',
		'Should print results array after ~2s.'
	);

	const limiter = new FetchRateLimited({ windowMs: 1000, limit: 3 });

	const data = [1, 2, 3, 4, 5, 6, 7];
	const urls = data.map(id => `https://jsonplaceholder.typicode.com/todos/${id}`);

	// Requests are automatically throttled to 3 per second
	const responses = await Promise.all(
		urls.map(url => limiter.fetch(url).catch(console.error))
	);

	const results = await Promise.all(responses.map(res => res?.json()));
	console.log(results);
}

// Run all tests sequentially
(async () => {
	try {
		await testCallbackFetch();
		await testRejectPending();
		await testResolvePending();
		await testAbortController();
		await testBurst();
		await testREADMEAbortExample();
		await testQuickStart();
	} catch (err) {
		console.error('Unhandled error in tests:', err);
	}
})();
