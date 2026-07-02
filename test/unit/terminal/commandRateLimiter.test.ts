/**
 * commandRateLimiter.test.ts — Unit tests for the command rate limiter.
 */

import { expect } from 'chai';
import { CommandRateLimiter } from '../../../src/terminal/commandRateLimiter';

describe('CommandRateLimiter', () => {
	it('allows commands under the limit', () => {
		const limiter = new CommandRateLimiter({ maxCommands: 3, windowMs: 30_000 });
		expect(limiter.tryAcquire().allowed).to.be.true;
		expect(limiter.tryAcquire().allowed).to.be.true;
		expect(limiter.tryAcquire().allowed).to.be.true;
	});

	it('blocks commands over the limit', () => {
		const limiter = new CommandRateLimiter({ maxCommands: 2, windowMs: 30_000 });
		limiter.tryAcquire();
		limiter.tryAcquire();
		const result = limiter.tryAcquire();
		expect(result.allowed).to.be.false;
		if (!result.allowed) {
			expect(result.retryAfterMs).to.be.greaterThan(0);
		}
	});

	it('provides accurate status', () => {
		const limiter = new CommandRateLimiter({ maxCommands: 5, windowMs: 30_000 });
		limiter.tryAcquire();
		limiter.tryAcquire();
		const status = limiter.getStatus();
		expect(status.commandsInWindow).to.equal(2);
		expect(status.maxCommands).to.equal(5);
	});

	it('resets correctly', () => {
		const limiter = new CommandRateLimiter({ maxCommands: 2, windowMs: 30_000 });
		limiter.tryAcquire();
		limiter.tryAcquire();
		expect(limiter.tryAcquire().allowed).to.be.false;
		limiter.reset();
		expect(limiter.tryAcquire().allowed).to.be.true;
	});

	it('updates config', () => {
		const limiter = new CommandRateLimiter({ maxCommands: 2, windowMs: 30_000 });
		limiter.tryAcquire();
		limiter.tryAcquire();
		expect(limiter.tryAcquire().allowed).to.be.false;
		limiter.updateConfig({ maxCommands: 5 });
		expect(limiter.tryAcquire().allowed).to.be.true;
	});
});
