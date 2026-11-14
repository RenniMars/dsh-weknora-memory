/**
 * Vendored from @wxg-prc-cpg/dsh-weknora 0.1.0 (dist/client.js), MIT, source repo
 * https://github.com/Tencent/WeKnora (packages/dsh-weknora). Kept byte-for-byte apart from
 * this banner so upstream fixes can be diffed back in; integration lives in lib/tool-config.js
 * and lib/index.js, never here.
 */
/** Minimal WeKnora REST client: JSON endpoints plus the SSE chat streams. */
/** Raised for any non-2xx response or transport failure, with the key redacted. */
export class WeknoraApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = 'WeknoraApiError';
        this.status = status;
    }
}
/** Trim a response body for an error message without leaking a whole page. */
function snippet(body) {
    const collapsed = body.replace(/\s+/g, ' ').trim();
    return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}
/** Extract a human-readable reason from WeKnora's error envelope. */
function reasonOf(body) {
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed.error === 'string')
            return parsed.error;
        if (parsed.error?.message !== undefined)
            return parsed.error.message;
        if (parsed.message !== undefined)
            return parsed.message;
    }
    catch {
        // Fall through to the raw snippet: a proxy may answer with HTML.
    }
    return snippet(body);
}
/**
 * Combine the caller's cancellation with this call's deadline. The tool body
 * must abort when the harness aborts, and a hung backend must not hold a turn
 * open forever.
 */
function deadline(signal, timeoutMs) {
    return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
export class WeknoraClient {
    config;
    constructor(config) {
        this.config = config;
    }
    headers() {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (this.config.apiKey !== undefined)
            headers['X-API-Key'] = this.config.apiKey;
        if (this.config.tenantId !== undefined)
            headers['X-Tenant-ID'] = this.config.tenantId;
        return headers;
    }
    url(path, query) {
        const url = new URL(`${this.config.baseUrl}${path}`);
        if (this.config.resourceUrls === 'public')
            url.searchParams.set('resource_urls', 'public');
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined)
                url.searchParams.set(key, String(value));
        }
        return url.toString();
    }
    async fetchJson(path, init, signal) {
        const url = this.url(path, init.query);
        let response;
        try {
            response = await fetch(url, {
                method: init.method,
                headers: this.headers(),
                ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
                signal: deadline(signal, this.config.requestTimeoutMs),
            });
        }
        catch (cause) {
            throw new WeknoraApiError(`${init.method} ${path} failed: ${describeTransportFailure(cause, signal)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new WeknoraApiError(`${init.method} ${path} failed with HTTP ${response.status}: ${reasonOf(text)}`, response.status);
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new WeknoraApiError(`${init.method} ${path} returned a non-JSON body: ${snippet(text)}`, response.status);
        }
    }
    /** List the knowledge bases this credential can retrieve from. */
    async listKnowledgeBases(signal) {
        const envelope = await this.fetchJson('/knowledge-bases', { method: 'GET' }, signal);
        return Array.isArray(envelope.data) ? envelope.data : [];
    }
    /** Hybrid (vector + keyword) retrieval across one or more knowledge bases. */
    async search(input, signal) {
        const envelope = await this.fetchJson('/knowledge-search', {
            method: 'POST',
            body: {
                query: input.query,
                ...input.knowledgeBaseIds.length > 0 ? { knowledge_base_ids: input.knowledgeBaseIds } : {},
                ...input.knowledgeIds.length > 0 ? { knowledge_ids: input.knowledgeIds } : {},
            },
        }, signal);
        return Array.isArray(envelope.data) ? envelope.data : [];
    }
    /**
     * Find documents by title or filename. Unlike `search` this spans every
     * knowledge base the credential can see and needs no scope, so it is what
     * answers "where is the document called X".
     */
    async findDocuments(input, signal) {
        const envelope = await this.fetchJson('/knowledge/search', {
            method: 'GET',
            query: { keyword: input.keyword, limit: input.limit },
        }, signal);
        return Array.isArray(envelope.data) ? envelope.data : [];
    }
    /** A document's metadata, including the generated summary WeKnora stores as `description`. */
    async getDocument(knowledgeId, signal) {
        const envelope = await this.fetchJson(`/knowledge/${encodeURIComponent(knowledgeId)}`, { method: 'GET' }, signal);
        return envelope.data ?? {};
    }
    /** One page of a document's stored chunks, in storage order. */
    async listChunks(input, signal) {
        const envelope = await this.fetchJson(`/chunks/${encodeURIComponent(input.knowledgeId)}`, {
            method: 'GET',
            query: { page: input.page, page_size: input.pageSize },
        }, signal);
        const chunks = Array.isArray(envelope.data) ? envelope.data : [];
        return {
            chunks,
            total: typeof envelope.total === 'number' ? envelope.total : chunks.length,
            page: typeof envelope.page === 'number' ? envelope.page : input.page,
            pageSize: typeof envelope.page_size === 'number' ? envelope.page_size : input.pageSize,
        };
    }
    /** Create a conversation container to hold one or more asked questions. */
    async createSession(title, signal) {
        const envelope = await this.fetchJson('/sessions', {
            method: 'POST',
            body: { title },
        }, signal);
        const id = envelope.data?.id;
        if (typeof id !== 'string' || id === '') {
            throw new WeknoraApiError('POST /sessions returned no session id');
        }
        return id;
    }
    /**
     * Ask a question and assemble the streamed answer. `agentId` selects the
     * ReAct pipeline (`/agent-chat`); without it the RAG pipeline answers
     * (`/knowledge-chat`).
     */
    async ask(input, signal) {
        const route = input.agentId === undefined ? 'knowledge-chat' : 'agent-chat';
        const path = `/${route}/${encodeURIComponent(input.sessionId)}`;
        const body = {
            query: input.query,
            channel: 'api',
            ...input.knowledgeBaseIds.length > 0 ? { knowledge_base_ids: input.knowledgeBaseIds } : {},
            ...input.agentId === undefined ? {} : { agent_id: input.agentId, agent_enabled: true },
            ...input.webSearch ? { web_search_enabled: true } : {},
        };
        const combined = deadline(signal, this.config.chatTimeoutMs);
        let response;
        try {
            response = await fetch(this.url(path), {
                method: 'POST',
                headers: { ...this.headers(), Accept: 'text/event-stream' },
                body: JSON.stringify(body),
                signal: combined,
            });
        }
        catch (cause) {
            throw new WeknoraApiError(`POST ${path} failed: ${describeTransportFailure(cause, signal)}`);
        }
        if (!response.ok) {
            const text = await response.text();
            throw new WeknoraApiError(`POST ${path} failed with HTTP ${response.status}: ${reasonOf(text)}`, response.status);
        }
        if (response.body === null) {
            throw new WeknoraApiError(`POST ${path} returned no response body`);
        }
        return await assembleStream(response.body, input.sessionId, path, signal);
    }
}
/** Turn an aborted or refused fetch into a message that names the real cause. */
function describeTransportFailure(cause, callerSignal) {
    if (cause instanceof Error && cause.name === 'AbortError') {
        return callerSignal.aborted ? 'the call was cancelled' : 'the request timed out';
    }
    if (cause instanceof Error && cause.name === 'TimeoutError')
        return 'the request timed out';
    return cause instanceof Error ? cause.message : String(cause);
}
/**
 * Consume WeKnora's `text/event-stream` and assemble the parts a tool result
 * needs: the answer text, its citations, and the tool names the agent used.
 * Server-side `error` events become a thrown failure so the model is never
 * handed a silently empty answer.
 */
async function assembleStream(body, sessionId, path, callerSignal) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    const answer = [];
    const toolCalls = [];
    let references = [];
    let resolvedSessionId = sessionId;
    let buffer = '';
    let completed = false;
    const consumeLine = (line) => {
        if (!line.startsWith('data:'))
            return;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]')
            return;
        let event;
        try {
            event = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (typeof event.session_id === 'string' && event.session_id !== '')
            resolvedSessionId = event.session_id;
        switch (event.response_type) {
            case 'answer':
                if (typeof event.content === 'string')
                    answer.push(event.content);
                break;
            case 'references':
                if (Array.isArray(event.knowledge_references))
                    references = event.knowledge_references;
                break;
            case 'tool_call':
                for (const call of event.tool_calls ?? []) {
                    const name = call.function?.name ?? call.name;
                    if (typeof name === 'string' && name !== '' && !toolCalls.includes(name))
                        toolCalls.push(name);
                }
                break;
            case 'error':
                throw new WeknoraApiError(`POST ${path} streamed an error: ${event.content ?? 'unknown error'}`);
            case 'complete':
                completed = true;
                break;
            default:
                break;
        }
    };
    try {
        while (!completed) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                consumeLine(buffer.slice(0, newline).replace(/\r$/, ''));
                buffer = buffer.slice(newline + 1);
                if (completed)
                    break;
                newline = buffer.indexOf('\n');
            }
        }
        if (!completed && buffer !== '')
            consumeLine(buffer.replace(/\r$/, ''));
    }
    catch (cause) {
        if (cause instanceof WeknoraApiError)
            throw cause;
        throw new WeknoraApiError(`POST ${path} stream failed: ${describeTransportFailure(cause, callerSignal)}`);
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
    // WeKnora ends every answer with a `complete` event. Without it the stream was
    // cut short, and handing the model the partial text would present a truncated
    // answer as a whole one.
    if (!completed) {
        throw new WeknoraApiError(`POST ${path} ended before WeKnora completed the answer; `
            + `${answer.join('').length} character(s) had streamed`);
    }
    return { answer: answer.join(''), references, sessionId: resolvedSessionId, toolCalls };
}
//# sourceMappingURL=client.js.map