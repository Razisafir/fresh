/**
 * geminiProvider.test.ts — Unit tests for the Gemini LLM provider.
 */

import { expect } from 'chai';
import { GeminiProvider } from '../../../src/llm/providers/geminiProvider';
import type { ISecrets } from '../../../src/types/platform';

/** Mock secrets provider for testing. */
class MockSecrets implements ISecrets {
	private readonly _store = new Map<string, string>();
	async get(key: string): Promise<string | undefined> { return this._store.get(key); }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value); }
	async delete(key: string): Promise<void> { this._store.delete(key); }
}

describe('GeminiProvider', () => {
	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		expect(provider.providerType).to.equal('gemini');
	});

	it('returns a default active model', () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		const model = provider.getActiveModel();
		expect(model).to.not.be.undefined;
		expect(model!.id).to.equal('gemini-2.0-flash');
		expect(model!.provider).to.equal('gemini');
	});

	it('reports not offline', () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		expect(provider.isOffline()).to.be.false;
	});

	it('returns fallback models when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		const models = await provider.listModels();
		expect(models.length).to.be.greaterThan(0);
		expect(models[0].provider).to.equal('gemini');
	});

	it('returns unreachable status when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal('unreachable');
	});

	it('can set active model', async () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		const result = await provider.setActiveModel('gemini-1.5-pro');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('gemini-1.5-pro');
	});

	it('returns false for unknown model', async () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		const result = await provider.setActiveModel('nonexistent-model');
		expect(result).to.be.false;
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new GeminiProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
