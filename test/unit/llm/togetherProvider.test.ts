/**
 * togetherProvider.test.ts — Unit tests for the Together AI LLM provider.
 */

import { expect } from 'chai';
import { TogetherProvider } from '../../../src/llm/providers/togetherProvider';
import type { ISecrets } from '../../../src/types/platform';

/** Mock secrets provider for testing. */
class MockSecrets implements ISecrets {
	private readonly _store = new Map<string, string>();
	async get(key: string): Promise<string | undefined> { return this._store.get(key); }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value); }
	async delete(key: string): Promise<void> { this._store.delete(key); }
}

describe('TogetherProvider', () => {
	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		expect(provider.providerType).to.equal('together');
	});

	it('returns a default active model', () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		const model = provider.getActiveModel();
		expect(model).to.not.be.undefined;
		expect(model!.id).to.equal('meta-llama/Llama-3.3-70B-Instruct-Turbo');
		expect(model!.provider).to.equal('together');
	});

	it('reports not offline', () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		expect(provider.isOffline()).to.be.false;
	});

	it('returns fallback models when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		const models = await provider.listModels();
		expect(models.length).to.be.greaterThan(0);
		expect(models[0].provider).to.equal('together');
	});

	it('returns unreachable status when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal('unreachable');
	});

	it('can set active model', async () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		const result = await provider.setActiveModel('mistralai/Mixtral-8x7B-Instruct-v0.1');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('mistralai/Mixtral-8x7B-Instruct-v0.1');
	});

	it('returns false for unknown model', async () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		const result = await provider.setActiveModel('nonexistent-model');
		expect(result).to.be.false;
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new TogetherProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
