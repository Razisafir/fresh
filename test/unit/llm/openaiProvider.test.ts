/**
 * openaiProvider.test.ts — Unit tests for the OpenAI LLM provider.
 */

import { expect } from 'chai';
import { OpenAIProvider } from '../../../src/llm/providers/openaiProvider';
import { ProviderStatus } from '../../../src/types/llm';
import type { ISecrets } from '../../../src/types/platform';

const { initAppState, _resetAppState } = require('../../../src/platform/appState');
const os = require('os');
const path = require('path');
const fs = require('fs');

/** Mock secrets provider for testing. */
class MockSecrets implements ISecrets {
	private readonly _store = new Map<string, string>();
	async get(key: string): Promise<string | undefined> { return this._store.get(key); }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value); }
	async delete(key: string): Promise<void> { this._store.delete(key); }
}

describe('OpenAIProvider', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), 'kovix-test-openai-' + process.pid);
		fs.mkdirSync(tmpDir, { recursive: true });
		await initAppState(tmpDir);
	});

	afterEach(() => {
		_resetAppState();
	});

	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		expect(provider.providerType).to.equal('openai');
	});

	it('returns a default active model', () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		const model = provider.getActiveModel();
		expect(model).to.not.be.undefined;
		expect(model!.id).to.equal('gpt-4o');
		expect(model!.provider).to.equal('openai');
	});

	it('reports not offline', () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		expect(provider.isOffline()).to.be.false;
	});

	it('returns empty models list when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		const models = await provider.listModels();
		expect(models).to.deep.equal([]);
	});

	it('returns NoModels status when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal(ProviderStatus.NoModels);
	});

	it('can set active model (always accepts)', async () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		const result = await provider.setActiveModel('gpt-4o-mini');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('gpt-4o-mini');
	});

	it('can set active model to any model id', async () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		const result = await provider.setActiveModel('gpt-4-turbo');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('gpt-4-turbo');
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new OpenAIProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
