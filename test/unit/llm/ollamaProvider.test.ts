/**
 * ollamaProvider.test.ts — Unit tests for the Ollama LLM provider.
 */

import { expect } from 'chai';
import { OllamaProvider } from '../../../src/llm/providers/ollamaProvider';
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

describe('OllamaProvider', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), 'kovix-test-ollama-' + process.pid);
		fs.mkdirSync(tmpDir, { recursive: true });
		await initAppState(tmpDir);
	});

	afterEach(() => {
		_resetAppState();
	});

	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		expect(provider.providerType).to.equal('ollama');
	});

	it('returns a default active model', () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		const model = provider.getActiveModel();
		expect(model).to.not.be.undefined;
		expect(model!.id).to.equal('llama3.1');
		expect(model!.provider).to.equal('ollama');
	});

	it('reports not offline', () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		expect(provider.isOffline()).to.be.false;
	});

	it('returns fallback models when Ollama server is not running', async () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		const models = await provider.listModels();
		// Ollama not running: falls back to [activeModel] since one is set
		expect(models.length).to.be.greaterThan(0);
		expect(models[0].provider).to.equal('ollama');
	});

	it('returns unreachable status when Ollama server is not running', async () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal(ProviderStatus.Unreachable);
	});

	it('can set active model (always accepts, auto-discover friendly)', async () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		const result = await provider.setActiveModel('codellama');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('codellama');
	});

	it('can set active model to any model id', async () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		const result = await provider.setActiveModel('custom-model');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('custom-model');
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new OllamaProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
