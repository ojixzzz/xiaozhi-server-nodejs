const LLMProvider = require('./base');
const { performance } = require('node:perf_hooks');
const { GoogleGenAI } = require('@google/genai');
const { transientError } = require('../lib/live-recovery');

class GeminiProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.ai = new GoogleGenAI({ apiKey: config.apiKey });
        this.session = null;
        this.closed = false;
        this.ready = false;
        this.cancelConnect = null;
        this.pendingMessages = [];
        this.goAwayTimer = null;
        this.finish = null;
    }

    async connect(tools) {
        if (this.closed) return;
        const started = performance.now();
        let setupReceived = false;
        this.emit('diagnostic', { event: 'gemini.sdk_connect', model: this.config.model, setup_timeout_ms: 20000 });
        const sessionConfig = {
            responseModalities: ['audio'],
            sessionResumption: this.config.resumptionHandle ? { handle: this.config.resumptionHandle } : {},
            contextWindowCompression: { slidingWindow: {} },
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: this.config.voice
                    }
                }
            },
            systemInstruction: {
                parts: [{ text: this.config.prompt }]
            }
        };

        if (tools && tools.length > 0) {
            // MCP supplies JSON Schema, while Gemini's `parameters` uses a
            // restricted Schema message (e.g. it rejects `uniqueItems`). Use
            // the JSON Schema field, as the SDK's MCP adapter does, and keep
            // SDK transformations isolated from the original tool definitions.
            const functionDeclarations = tools.map(tool => {
                const declaration = { ...tool };
                const schema = tool.parametersJsonSchema ?? tool.parameters;
                delete declaration.parameters;
                if (schema != null) declaration.parametersJsonSchema = JSON.parse(JSON.stringify(schema));
                return declaration;
            });
            sessionConfig.tools = [{ functionDeclarations }];
            sessionConfig.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
            this.emit('diagnostic', {
                event: 'gemini.tool_schema_prepared',
                tool_count: functionDeclarations.length,
                tools: functionDeclarations.map((tool, index) => ({
                    index, name: tool.name, schema_format: tool.parametersJsonSchema != null ? 'parametersJsonSchema' : 'none'
                }))
            });
        }

        if (this.config.input_transcription) sessionConfig.inputAudioTranscription = {};
        if (this.config.output_transcription) sessionConfig.outputAudioTranscription = {};

        // A socket's onopen precedes setup validation. Wait for setupComplete
        // AND the Session handle before allowing the device to send audio.
        let setupReady;
        let ended;
        const setupPromise = new Promise(resolve => { setupReady = resolve; });
        const endedPromise = new Promise(resolve => { ended = resolve; });
        this.cancelConnect = ended;
        const finish = (details) => {
            if (this.closed) return;
            this.closed = true;
            this.ready = false;
            this.session = null;
            this.pendingMessages = [];
            clearTimeout(this.goAwayTimer);
            this.goAwayTimer = null;
            ended();
            this.emit('close', details);
        };
        this.finish = finish;
        const timeout = setTimeout(() => {
            const session = this.session;
            this.emit('diagnostic', { event: 'gemini.setup_timeout', duration_ms: Math.round(performance.now() - started),
                session_handle: Boolean(session), setup_accepted: setupReceived });
            finish({ code: 1006, reason: 'Gemini setup timed out after 20s', wasClean: false });
            session?.close();
        }, 20000);
        timeout.unref?.();
        try {
            const sessionPromise = this.ai.live.connect({
                model: this.config.model,
                config: sessionConfig,
                callbacks: {
                    onopen: () => {
                        if (!this.closed) this.emit('diagnostic', { event: 'gemini.socket_open', duration_ms: Math.round(performance.now() - started) });
                    },
                    onmessage: (response) => {
                        if (this.closed) return;
                        if (response.setupComplete) {
                            if (!setupReceived) this.emit('diagnostic', { event: 'gemini.setup_accepted', duration_ms: Math.round(performance.now() - started) });
                            setupReceived = true;
                            setupReady();
                        }
                        if (this.ready) this.handleMessage(response);
                        else if (!response.setupComplete && this.pendingMessages.length < 100) this.pendingMessages.push(response);
                    },
                    onerror: (error) => {
                        if (!this.closed) {
                            const cause = error?.error;
                            const failure = new Error(error?.message || cause?.message || 'Gemini WebSocket error', { cause });
                            failure.code = cause?.code;
                            this.emit('error', failure);
                            this.disconnect({ code: 1006, reason: failure.message,
                                retryable: !/\b(400|401|403|404)\b|invalid.*(key|model)/i.test(failure.message) });
                        }
                    },
                    onclose: (event) => {
                        if (!this.closed) this.emit('diagnostic', { event: 'gemini.socket_closed', code: event?.code,
                            reason: event?.reason || '', was_clean: event?.wasClean, setup_accepted: setupReceived, duration_ms: Math.round(performance.now() - started) });
                        finish({ code: event?.code, reason: event?.reason || '', wasClean: event?.wasClean });
                    }
                }
            }).then(session => {
                if (this.closed) session.close();
                else {
                    this.session = session;
                    this.emit('diagnostic', { event: 'gemini.session_handle_received', duration_ms: Math.round(performance.now() - started) });
                }
            });
            await Promise.race([sessionPromise, endedPromise]);
            if (this.closed) return;
            await Promise.race([setupPromise, endedPromise]);
            if (this.closed) return;
            this.ready = true;
            this.emit('connected');
            const pending = this.pendingMessages;
            this.pendingMessages = [];
            for (const response of pending) this.handleMessage(response);
        } catch (e) {
            if (!this.closed) {
                this.emit('error', new Error(`Failed to connect to Gemini: ${e.message}`, { cause: e }));
                const session = this.session;
                finish({ reason: e.message, retryable: transientError(e) });
                session?.close();
            }
        } finally {
            clearTimeout(timeout);
            this.cancelConnect = null;
        }
    }

    handleMessage(response) {
        if (this.closed) return;
        if (response.sessionResumptionUpdate) {
            const update = response.sessionResumptionUpdate;
            this.emit('resumption_update', { resumable: update.resumable === true, handle: update.newHandle });
            this.emit('diagnostic', { event: 'gemini.resumption_updated', resumable: update.resumable === true });
        }
        if (response.goAway) {
            const value = response.goAway.timeLeft;
            const milliseconds = typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value) ? parseFloat(value) * 1000 : 1000;
            const delay = Math.max(0, Math.min(milliseconds - 1000, 120000));
            this.emit('diagnostic', { event: 'gemini.go_away', reconnect_in_ms: delay });
            clearTimeout(this.goAwayTimer);
            this.goAwayTimer = setTimeout(() => this.disconnect({ code: 1012, reason: 'Gemini GoAway', retryable: true }), delay);
            this.goAwayTimer.unref?.();
        }
        if (response.serverContent) {
            const content = response.serverContent;
            
            if (content.modelTurn?.parts) {
                for (const part of content.modelTurn.parts) {
                    if (part.inlineData) {
                        this.emit('audio_output', Buffer.from(part.inlineData.data, 'base64'));
                    }
                }
            }
            if (typeof content.inputTranscription?.text === 'string' && this.config.input_transcription) {
                this.emit('input_transcription', content.inputTranscription.text);
            }
            if (typeof content.outputTranscription?.text === 'string' && this.config.output_transcription) {
                this.emit('output_transcription', content.outputTranscription.text);
            }
            if (content.turnComplete && !content.interrupted) {
                this.emit('turn_complete');
            }
            if (content.interrupted) {
                this.emit('interrupted');
            }
        }

        if (response.toolCall?.functionCalls) {
            for (const call of response.toolCall.functionCalls) {
                this.emit('tool_call', call.id, call.name, call.args || {});
            }
        }
    }

    sendAudio(pcmChunk) {
        if (this.ready && this.session) {
            try {
                this.session.sendRealtimeInput({
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: pcmChunk.toString('base64')
                    }
                });
                return true;
            } catch (e) {
                this.emit('error', new Error(`Error sending audio to Gemini: ${e.message}`, { cause: e }));
                this.disconnect({ code: 1006, reason: e.message, retryable: true });
            }
        }
        return false;
    }

    endAudio() {
        if (!this.ready || !this.session) return false;
        try {
            this.session.sendRealtimeInput({ audioStreamEnd: true });
            this.emit('diagnostic', { event: 'gemini.audio_stream_ended' });
            return true;
        } catch (error) {
            this.emit('error', new Error(`Error ending Gemini audio: ${error.message}`, { cause: error }));
            this.disconnect({ code: 1006, reason: error.message, retryable: true });
            return false;
        }
    }

    disconnect(details) {
        if (this.closed) return;
        const session = this.session;
        this.finish?.(details);
        session?.close();
    }

    sendToolResponse(callId, name, resultText) {
        if (this.ready && this.session) {
            try {
                this.session.sendToolResponse({
                    functionResponses: [{
                        id: callId,
                        name: name,
                        response: { result: resultText }
                    }]
                });
            } catch (e) {
                this.emit('error', new Error(`Error sending tool response to Gemini: ${e.message}`, { cause: e }));
                this.disconnect({ code: 1006, reason: e.message, retryable: true });
            }
        }
    }

    interrupt() {
        if (this.ready && this.session) {
            try {
                this.session.sendClientContent({ turnComplete: true });
            } catch (e) {
                this.emit('error', new Error(`Error sending interrupt to Gemini: ${e.message}`, { cause: e }));
            }
        }
    }

    close() {
        if (!this.closed) this.emit('diagnostic', { event: 'gemini.close_requested', ready: this.ready, session_handle: Boolean(this.session) });
        this.closed = true;
        this.ready = false;
        this.pendingMessages = [];
        clearTimeout(this.goAwayTimer);
        this.goAwayTimer = null;
        this.cancelConnect?.();
        const session = this.session;
        this.session = null;
        if (session && typeof session.close === 'function') session.close();
    }
}

module.exports = GeminiProvider;
