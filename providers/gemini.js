const LLMProvider = require('./base');
const { GoogleGenAI } = require('@google/genai');

class GeminiProvider extends LLMProvider {
    constructor(config) {
        super(config);
        this.ai = new GoogleGenAI({ apiKey: config.apiKey });
        this.session = null;
    }

    async connect(tools) {
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

        try {
            this.session = await this.ai.live.connect({
                model: this.config.model,
                config: sessionConfig,
                callbacks: {
                    onopen: () => this.emit('connected'),
                    onmessage: (response) => this.handleMessage(response),
                    onerror: (error) => this.emit('error', error),
                    onclose: () => this.emit('close')
                }
            });
        } catch (e) {
            this.emit('error', new Error(`Failed to connect to Gemini: ${e.message}`));
        }
    }

    handleMessage(response) {
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
        if (this.session) {
            try {
                this.session.sendRealtimeInput({
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: pcmChunk.toString('base64')
                    }
                });
            } catch (e) {
                this.emit('error', new Error(`Error sending audio to Gemini: ${e.message}`));
            }
        }
    }

    sendToolResponse(callId, name, resultText) {
        if (this.session) {
            try {
                this.session.sendToolResponse({
                    functionResponses: [{
                        id: callId,
                        name: name,
                        response: { result: resultText }
                    }]
                });
            } catch (e) {
                this.emit('error', new Error(`Error sending tool response to Gemini: ${e.message}`));
            }
        }
    }

    interrupt() {
        if (this.session) {
            try {
                this.session.sendClientContent({ turnComplete: true });
            } catch (e) {
                console.error(`[Gemini] Error sending interrupt: ${e.message}`);
            }
        }
    }

    close() {
        const session = this.session;
        this.session = null;
        if (session && typeof session.close === 'function') session.close();
    }
}

module.exports = GeminiProvider;
