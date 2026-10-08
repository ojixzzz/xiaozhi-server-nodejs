const LLMProvider = require('./base');
const { performance } = require('node:perf_hooks');
const { GoogleGenAI } = require('@google/genai');

class GeminiProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.ai = new GoogleGenAI({ apiKey: config.apiKey });
        this.session = null;
        this.closed = false;
        this.ready = false;
        this.cancelConnect = null;
        this.pendingMessages = [];
    }

    async connect(tools) {
        if (this.closed) return;
        const started = performance.now();
        let setupReceived = false;
        this.emit('diagnostic', { event: 'gemini.sdk_connect', model: this.config.model, setup_timeout_ms: 20000 });
        const sessionConfig = {
            responseModalities: ['audio'],
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
            sessionConfig.tools = [{ functionDeclarations: tools }];
            sessionConfig.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
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
            ended();
            this.emit('close', details);
        };
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
                finish({ reason: e.message, retryable: false });
                session?.close();
            }
        } finally {
            clearTimeout(timeout);
            this.cancelConnect = null;
        }
    }

    handleMessage(response) {
        if (this.closed) return;
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
            } catch (e) {
                this.emit('error', new Error(`Error sending audio to Gemini: ${e.message}`, { cause: e }));
            }
        }
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
        this.cancelConnect?.();
        const session = this.session;
        this.session = null;
        if (session && typeof session.close === 'function') session.close();
    }
}

module.exports = GeminiProvider;
