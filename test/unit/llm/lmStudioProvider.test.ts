/**
 * lmStudioProvider.test.ts — Unit tests for the LM Studio LLM provider.
 */

import { expect } from 'chai';
import { LmStudioProvider } from '../../../src/llm/providers/lmStudioProvider';
import type { ISecrets } from '../../../src/types/platform';

/** Mock secrets provider for testing. */
class MockSecrets implements ISecrets {
	private readonly _store = new Map<string, string>();
	async get(key: string): Promise<string | undefined> { return this._store.get(key); }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value); }
	async delete(key: string): Promise<void> { this._store.delete(key); }
}

describe('LmStudioProvider', () => {
	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		expect(provider.providerType).to.equal('lm-studio');
	});

	it('reports offline (LM Studio is always local)', () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		expect(provider.isOffline()).to.be.true;
	});

	it('returns no default active model (models discovered at runtime)', () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		const model = provider.getActiveModel();
		// LM Studio has no pre-configured default model — models are discovered from the server
		expect(model).to.be.undefined;
	});

	it('returns empty models list when LM Studio server is not running', async () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		const models = await provider.listModels();
		expect(models).to.deep.equal([]);
	});

	it('returns unreachable status when LM Studio server is not running', async () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal('unreachable');
	});

	it('returns false for setActiveModel when model not in list', async () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		// No models discovered, so any setActiveModel should fail
		const result = await provider.setActiveModel('some-model');
		expect(result).to.be.false;
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new LmStudioProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
