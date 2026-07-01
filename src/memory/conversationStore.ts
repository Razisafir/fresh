/**
 * conversationStore.ts — Conversation persistence service that saves/loads
 * chat sessions to disk so history survives restarts.
 *
 * Conversations are stored as individual JSON files in appData/conversations/,
 * with an index file for fast listing. The store supports auto-save (debounced),
 * auto title generation, and LRU eviction when the max conversation count is
 * exceeded.
 *
 * Phase 0 pivot (D-015): uses local EventEmitter instead of vscode.EventEmitter.
 * Uses the Event<T> type from types/llm.ts and IChatMessage for compatibility.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Event } from '../types/llm';
import type { IChatMessage } from '../types/llm';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IConversation {
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        messages: IStoredMessage[];
        metadata: {
                provider: string;
                model: string;
                role: string;
                executionMode: string;
                workspaceRoot?: string;
        };
}

export interface IStoredMessage {
        id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        timestamp: number;
        toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
        tokensUsed?: number;
}

export interface IConversationMeta {
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        messageCount: number;
        provider: string;
        model: string;
}

export interface IConversationStore {
        saveConversation(conversation: IConversation): Promise<void>;
        loadConversation(id: string): Promise<IConversation | null>;
        listConversations(): Promise<IConversationMeta[]>;
        deleteConversation(id: string): Promise<void>;
        getActiveConversation(): Promise<IConversation | null>;
        setActiveConversation(id: string): Promise<void>;
        createConversation(title?: string): Promise<IConversation>;
        addMessage(conversationId: string, message: IChatMessage): Promise<void>;
        onDidChangeConversations: Event<void>;
}

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter (replaces vscode.*)
// ---------------------------------------------------------------------------

interface Disposable {
        dispose(): void;
}

class EventEmitter<T> {
        private listeners: Array<(data: T) => void> = [];

        get event(): (listener: (data: T) => void) => { dispose(): void } {
                return (listener: (data: T) => void) => {
                        this.listeners.push(listener);
                        return {
                                dispose: () => {
                                        const idx = this.listeners.indexOf(listener);
                                        if (idx >= 0) { this.listeners.splice(idx, 1); }
                                },
                        };
                };
        }

        fire(data: T): void {
                for (const listener of [...this.listeners]) {
                        try { listener(data); } catch {
                                // Swallow errors in listeners.
                        }
                }
        }

        dispose(): void {
                this.listeners = [];
        }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of conversations to keep. Oldest are auto-deleted (LRU). */
const MAX_CONVERSATIONS = 100;

/** Auto-save debounce interval in milliseconds. */
const AUTO_SAVE_DEBOUNCE_MS = 2000;

/** Maximum length of auto-generated title (from first user message). */
const AUTO_TITLE_MAX_LENGTH = 50;

/** Directory name for conversation files, relative to baseDir. */
const CONVERSATIONS_DIR = 'conversations';

/** Index file name for fast listing. */
const INDEX_FILE = 'conversations-index.json';

/** Active conversation pointer file. */
const ACTIVE_FILE = 'active-conversation.json';

// ---------------------------------------------------------------------------
// Index file structure
// ---------------------------------------------------------------------------

interface IIndexEntry {
        id: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        messageCount: number;
        provider: string;
        model: string;
}

interface IIndex {
        entries: IIndexEntry[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ConversationStore implements IConversationStore, Disposable {
        private _conversationsDir = '';
        private _indexPath = '';
        private _activePath = '';
        private _initialised = false;

        /** In-memory cache of the index for fast listing. */
        private _index: IIndex = { entries: [] };

        /** Active conversation ID (cached in memory). */
        private _activeConversationId: string | undefined;

        /** Debounce timer for auto-save after addMessage. */
        private _autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

        /** Conversations that have been modified and need auto-save. */
        private _dirtyConversationIds = new Set<string>();

        /** In-memory cache of loaded conversations. */
        private readonly _conversationCache = new Map<string, IConversation>();

        private readonly _onDidChangeConversations = new EventEmitter<void>();
        readonly onDidChangeConversations = this._onDidChangeConversations.event;

        // -----------------------------------------------------------------------
        // Initialisation
        // -----------------------------------------------------------------------

        /**
         * Initialise the store with a base directory. Called once during app startup.
         * Creates the conversations directory and loads the existing index.
         */
        async init(baseDir: string): Promise<void> {
                if (this._initialised) {
                        throw new Error('initConversationStore() called twice — use getConversationStore() instead.');
                }

                this._conversationsDir = path.join(baseDir, CONVERSATIONS_DIR);
                this._indexPath = path.join(baseDir, INDEX_FILE);
                this._activePath = path.join(baseDir, ACTIVE_FILE);

                // Ensure the conversations directory exists.
                await fs.mkdir(this._conversationsDir, { recursive: true });

                // Load the existing index.
                await this._loadIndex();

                // Load the active conversation pointer.
                await this._loadActivePointer();

                this._initialised = true;
                logger.info(`[ConversationStore] Initialized (baseDir: ${baseDir}, ${this._index.entries.length} conversation(s) in index)`);
        }

        private _ensureInitialised(): void {
                if (!this._initialised) {
                        throw new Error('ConversationStore not initialised. Call initConversationStore() first.');
                }
        }

        // -----------------------------------------------------------------------
        // Public API
        // -----------------------------------------------------------------------

        async saveConversation(conversation: IConversation): Promise<void> {
                this._ensureInitialised();

                const filePath = this._conversationFilePath(conversation.id);
                const json = JSON.stringify(conversation, null, 2);

                await fs.writeFile(filePath, json, 'utf8');

                // Update cache.
                this._conversationCache.set(conversation.id, conversation);

                // Update the index entry.
                this._upsertIndexEntry(conversation);

                // Persist the index.
                await this._saveIndex();

                // Check LRU eviction.
                await this._enforceMaxConversations();

                this._onDidChangeConversations.fire();

                logger.verbose(`[ConversationStore] Saved conversation: ${conversation.id} (${conversation.messages.length} messages)`);
        }

        async loadConversation(id: string): Promise<IConversation | null> {
                this._ensureInitialised();

                // Check cache first.
                const cached = this._conversationCache.get(id);
                if (cached) return cached;

                const filePath = this._conversationFilePath(id);
                try {
                        const raw = await fs.readFile(filePath, 'utf8');
                        const conversation = JSON.parse(raw) as IConversation;
                        this._conversationCache.set(id, conversation);
                        return conversation;
                } catch {
                        logger.verbose(`[ConversationStore] Conversation not found: ${id}`);
                        return null;
                }
        }

        async listConversations(): Promise<IConversationMeta[]> {
                this._ensureInitialised();

                // Return from the in-memory index — no disk I/O needed.
                return this._index.entries.map(entry => ({ ...entry }));
        }

        async deleteConversation(id: string): Promise<void> {
                this._ensureInitialised();

                // Remove the conversation file.
                const filePath = this._conversationFilePath(id);
                try {
                        await fs.unlink(filePath);
                } catch {
                        // File might not exist — that's okay.
                }

                // Remove from cache.
                this._conversationCache.delete(id);

                // Remove from index.
                const idx = this._index.entries.findIndex(e => e.id === id);
                if (idx >= 0) {
                        this._index.entries.splice(idx, 1);
                        await this._saveIndex();
                }

                // Clear active pointer if this was the active conversation.
                if (this._activeConversationId === id) {
                        this._activeConversationId = undefined;
                        await this._saveActivePointer();
                }

                this._onDidChangeConversations.fire();

                logger.info(`[ConversationStore] Deleted conversation: ${id}`);
        }

        async getActiveConversation(): Promise<IConversation | null> {
                this._ensureInitialised();

                if (!this._activeConversationId) return null;
                return this.loadConversation(this._activeConversationId);
        }

        async setActiveConversation(id: string): Promise<void> {
                this._ensureInitialised();

                // Verify the conversation exists.
                const conversation = await this.loadConversation(id);
                if (!conversation) {
                        logger.warn(`[ConversationStore] Cannot set active: conversation not found: ${id}`);
                        return;
                }

                this._activeConversationId = id;
                await this._saveActivePointer();

                logger.verbose(`[ConversationStore] Active conversation set: ${id}`);
        }

        async createConversation(title?: string): Promise<IConversation> {
                this._ensureInitialised();

                const id = this._generateId();
                const now = Date.now();

                const conversation: IConversation = {
                        id,
                        title: title ?? 'New Conversation',
                        createdAt: now,
                        updatedAt: now,
                        messages: [],
                        metadata: {
                                provider: '',
                                model: '',
                                role: '',
                                executionMode: '',
                        },
                };

                await this.saveConversation(conversation);

                logger.info(`[ConversationStore] Created conversation: ${id}`);
                return conversation;
        }

        async addMessage(conversationId: string, message: IChatMessage): Promise<void> {
                this._ensureInitialised();

                const conversation = await this.loadConversation(conversationId);
                if (!conversation) {
                        logger.warn(`[ConversationStore] Cannot add message: conversation not found: ${conversationId}`);
                        return;
                }

                const now = Date.now();
                const storedMessage: IStoredMessage = {
                        id: this._generateId(),
                        role: message.role as 'user' | 'assistant' | 'system',
                        content: message.content,
                        timestamp: now,
                        toolCalls: message.toolCalls?.map(tc => ({
                                name: tc.name,
                                input: tc.arguments ? this._safeParseJson(tc.arguments) : undefined,
                        })),
                };

                conversation.messages.push(storedMessage);
                conversation.updatedAt = now;

                // Auto-generate title from first user message if still the default.
                if (
                        conversation.title === 'New Conversation' &&
                        message.role === 'user' &&
                        message.content.trim().length > 0
                ) {
                        conversation.title = this._generateTitle(message.content);
                }

                // Update cache immediately.
                this._conversationCache.set(conversationId, conversation);

                // Mark as dirty for auto-save.
                this._dirtyConversationIds.add(conversationId);
                this._scheduleAutoSave();
        }

        dispose(): void {
                if (this._autoSaveTimer) {
                        clearTimeout(this._autoSaveTimer);
                        this._autoSaveTimer = undefined;
                }
                // Flush any remaining dirty conversations synchronously — best effort.
                this._flushDirtyConversationsSync();
                this._onDidChangeConversations.dispose();
                this._conversationCache.clear();
                this._index = { entries: [] };
                this._initialised = false;
        }

        // -----------------------------------------------------------------------
        // Private helpers — file paths
        // -----------------------------------------------------------------------

        private _conversationFilePath(id: string): string {
                return path.join(this._conversationsDir, `${id}.json`);
        }

        // -----------------------------------------------------------------------
        // Private helpers — index
        // -----------------------------------------------------------------------

        private async _loadIndex(): Promise<void> {
                try {
                        const raw = await fs.readFile(this._indexPath, 'utf8');
                        const parsed = JSON.parse(raw) as IIndex;
                        this._index = parsed;
                } catch {
                        // Index doesn't exist yet — start empty.
                        this._index = { entries: [] };
                }
        }

        private async _saveIndex(): Promise<void> {
                const json = JSON.stringify(this._index, null, 2);
                await fs.writeFile(this._indexPath, json, 'utf8');
        }

        private _upsertIndexEntry(conversation: IConversation): void {
                const entry: IIndexEntry = {
                        id: conversation.id,
                        title: conversation.title,
                        createdAt: conversation.createdAt,
                        updatedAt: conversation.updatedAt,
                        messageCount: conversation.messages.length,
                        provider: conversation.metadata.provider,
                        model: conversation.metadata.model,
                };

                const idx = this._index.entries.findIndex(e => e.id === conversation.id);
                if (idx >= 0) {
                        this._index.entries[idx] = entry;
                } else {
                        this._index.entries.push(entry);
                }

                // Keep the index sorted by updatedAt (newest first).
                this._index.entries.sort((a, b) => b.updatedAt - a.updatedAt);
        }

        // -----------------------------------------------------------------------
        // Private helpers — active pointer
        // -----------------------------------------------------------------------

        private async _loadActivePointer(): Promise<void> {
                try {
                        const raw = await fs.readFile(this._activePath, 'utf8');
                        const parsed = JSON.parse(raw) as { activeConversationId: string };
                        this._activeConversationId = parsed.activeConversationId;
                } catch {
                        this._activeConversationId = undefined;
                }
        }

        private async _saveActivePointer(): Promise<void> {
                const data = JSON.stringify({ activeConversationId: this._activeConversationId ?? null }, null, 2);
                await fs.writeFile(this._activePath, data, 'utf8');
        }

        // -----------------------------------------------------------------------
        // Private helpers — auto-save
        // -----------------------------------------------------------------------

        private _scheduleAutoSave(): void {
                if (this._autoSaveTimer) {
                        clearTimeout(this._autoSaveTimer);
                }

                this._autoSaveTimer = setTimeout(() => {
                        this._autoSaveTimer = undefined;
                        this._flushDirtyConversations();
                }, AUTO_SAVE_DEBOUNCE_MS);
        }

        /**
         * Flush all dirty conversations to disk. Called after the auto-save
         * debounce timer fires.
         */
        private async _flushDirtyConversations(): Promise<void> {
                const dirtyIds = [...this._dirtyConversationIds];
                this._dirtyConversationIds.clear();

                for (const id of dirtyIds) {
                        const conversation = this._conversationCache.get(id);
                        if (conversation) {
                                try {
                                        await this.saveConversation(conversation);
                                } catch (err) {
                                        logger.error(`[ConversationStore] Auto-save failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
                                        // Re-mark as dirty so it will be retried on next flush.
                                        this._dirtyConversationIds.add(id);
                                }
                        }
                }
        }

        /**
         * Synchronous best-effort flush for disposal. Only writes conversations
         * that are in the cache — does not update the index.
         */
        private _flushDirtyConversationsSync(): void {
                for (const id of this._dirtyConversationIds) {
                        const conversation = this._conversationCache.get(id);
                        if (conversation) {
                                try {
                                        const filePath = this._conversationFilePath(id);
                                        const json = JSON.stringify(conversation, null, 2);
                                        fsSync.writeFileSync(filePath, json, 'utf8');
                                } catch {
                                        // Best effort — swallow errors during disposal.
                                }
                        }
                }
                this._dirtyConversationIds.clear();
        }

        // -----------------------------------------------------------------------
        // Private helpers — LRU eviction
        // -----------------------------------------------------------------------

        /**
         * Enforce the maximum conversation count. If there are more than
         * MAX_CONVERSATIONS, the oldest (by updatedAt) are deleted.
         */
        private async _enforceMaxConversations(): Promise<void> {
                while (this._index.entries.length > MAX_CONVERSATIONS) {
                        // The last entry is the oldest (index is sorted newest-first).
                        const oldest = this._index.entries[this._index.entries.length - 1];
                        if (!oldest) break;

                        logger.info(`[ConversationStore] LRU eviction: deleting conversation ${oldest.id} ("${oldest.title}")`);

                        // Delete the file.
                        try {
                                await fs.unlink(this._conversationFilePath(oldest.id));
                        } catch {
                                // File might already be gone.
                        }

                        // Remove from cache.
                        this._conversationCache.delete(oldest.id);

                        // Remove from index.
                        this._index.entries.pop();

                        // Clear active pointer if needed.
                        if (this._activeConversationId === oldest.id) {
                                this._activeConversationId = undefined;
                                await this._saveActivePointer();
                        }
                }
        }

        // -----------------------------------------------------------------------
        // Private helpers — utilities
        // -----------------------------------------------------------------------

        /**
         * Generate a unique ID for a conversation or message.
         */
        private _generateId(): string {
                return crypto.randomUUID();
        }

        /**
         * Generate a title from the first user message content.
         * Takes the first AUTO_TITLE_MAX_LENGTH characters, trims whitespace.
         */
        private _generateTitle(content: string): string {
                const cleaned = content.replace(/\n/g, ' ').trim();
                if (cleaned.length <= AUTO_TITLE_MAX_LENGTH) {
                        return cleaned;
                }
                return cleaned.slice(0, AUTO_TITLE_MAX_LENGTH).trimEnd() + '…';
        }

        /**
         * Safely parse a JSON string. Returns the parsed value or the raw string
         * if parsing fails.
         */
        private _safeParseJson(jsonString: string): unknown {
                try {
                        return JSON.parse(jsonString);
                } catch {
                        return jsonString;
                }
        }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ConversationStore | undefined;

/**
 * Initialise the conversation store with a base directory.
 * Called once during app startup (before any other calls).
 *
 * @param baseDir Directory for app data (same baseDir as AppState).
 */
export async function initConversationStore(baseDir: string): Promise<void> {
        if (_instance) {
                throw new Error('initConversationStore() called twice — use getConversationStore() instead.');
        }
        _instance = new ConversationStore();
        await _instance.init(baseDir);
}

/**
 * Returns the singleton conversation store. Throws if initConversationStore()
 * has not been called yet.
 */
export function getConversationStore(): IConversationStore {
        if (!_instance) {
                throw new Error('getConversationStore() called before initConversationStore().');
        }
        return _instance;
}

/**
 * Returns true if the conversation store has been initialized.
 */
export function isConversationStoreInitialized(): boolean {
        return _instance !== undefined;
}

/**
 * Reset the conversation store (for testing only).
 */
export function _resetConversationStore(): void {
        _instance?.dispose();
        _instance = undefined;
}
