/**
 * deepseekProvider.test.ts — Unit tests for the DeepSeek LLM provider.
 */

import { expect } from 'chai';
import { DeepSeekProvider } from '../../../src/llm/providers/deepseekProvider';
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

describe('DeepSeekProvider', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), 'kovix-test-deepseek-' + process.pid);
		fs.mkdirSync(tmpDir, { recursive: true });
		await initAppState(tmpDir);
	});

	afterEach(() => {
		_resetAppState();
	});

	it('has the correct provider type', () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		expect(provider.providerType).to.equal('deepseek');
	});

	it('returns a default active model', () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		const model = provider.getActiveModel();
		expect(model).to.not.be.undefined;
		expect(model!.id).to.equal('deepseek-chat');
		expect(model!.provider).to.equal('deepseek');
	});

	it('reports not offline', () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		expect(provider.isOffline()).to.be.false;
	});

	it('returns empty models list when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		const models = await provider.listModels();
		expect(models).to.deep.equal([]);
	});

	it('returns NoModels status when no API key', async () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		const status = await provider.checkStatus();
		expect(status).to.equal(ProviderStatus.NoModels);
	});

	it('can set active model (always accepts)', async () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		const result = await provider.setActiveModel('deepseek-reasoner');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('deepseek-reasoner');
	});

	it('can set active model to deepseek-coder', async () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		const result = await provider.setActiveModel('deepseek-coder');
		expect(result).to.be.true;
		expect(provider.getActiveModel()?.id).to.equal('deepseek-coder');
	});

	it('can be disposed without error', () => {
		const secrets = new MockSecrets();
		const provider = new DeepSeekProvider(secrets);
		expect(() => provider.dispose()).to.not.throw();
	});
});
