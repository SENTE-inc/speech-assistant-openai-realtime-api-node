import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Supabaseクライアント初期化
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = `あなたはプロの営業アシスタントです。必ず日本語で話してください。
以下の役割で電話対応を行います。

【目的】
担当者への取り次ぎを獲得する。

【トーク例】
- 最初の挨拶：「お世話になっております。株式会社SENTEと申します。御社のご担当者様はいらっしゃいますでしょうか？」
- 受付に聞かれたら：「Uber Eatsの売上改善に関するご提案でございます。」
- 担当者に繋いでもらえたら：「ありがとうございます。少々お時間よろしいでしょうか？」

【注意事項】
- 必ず日本語のみで話す
- 丁寧な敬語を使う
- 簡潔に話す
- 相手の返答をよく聞いてから話す`;

const VOICE = 'shimmer';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

const SHOW_TIMING_MATH = false;

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let sessionId = null;
        let callStartTime = Date.now();

        // Supabaseにセッション作成
        const createSession = async (phoneNumber) => {
            const { data, error } = await supabase
                .from('call_sessions')
                .insert({
                    phone_number: phoneNumber || 'unknown',
                    status: 'calling',
                    script_phase: 'greeting'
                })
                .select()
                .single();
            if (error) {
                console.error('Supabase session create error:', error);
            } else {
                sessionId = data.id;
                console.log('Session created:', sessionId);
            }
        };

        // トランスクリプト保存（非同期）
        const saveTranscript = (role, content) => {
            if (!sessionId) return;
            supabase.from('call_transcripts').insert({
                session_id: sessionId,
                role,
                content
            }).then(({ error }) => {
                if (error) console.error('Transcript save error:', error);
            });
        };

        // セッション終了
        const endSession = (result) => {
            if (!sessionId) return;
            const duration = Math.floor((Date.now() - callStartTime) / 1000);
            supabase.from('call_sessions').update({
                status: 'completed',
                result: result || 'unknown',
                ended_at: new Date().toISOString(),
                duration_seconds: duration
            }).eq('id', sessionId).then(({ error }) => {
                if (error) console.error('Session end error:', error);
            });
        };

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ['text', 'audio'],
                    temperature: TEMPERATURE,
                }
            };
            openAiWs.send(JSON.stringify(sessionUpdate));
            sendInitialConversationItem();
        };

        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'お世話になっております。株式会社SENTEと申します。御社のご担当者様はいらっしゃいますでしょうか？と日本語で挨拶してください。'
                        }
                    ]
                }
            };
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    openAiWs.send(JSON.stringify(truncateEvent));
                }
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // AIの発話テキストを保存
                if (response.type === 'response.content.done') {
                    if (response.content) {
                        response.content.forEach(item => {
                            if (item.type === 'text') {
                                saveTranscript('assistant', item.text);
                            }
                        });
                    }
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }
                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // ユーザーの発話テキストを保存
                if (response.type === 'input_audio_buffer.committed') {
                    if (response.transcript) {
                        saveTranscript('user', response.transcript);
                    }
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        // セッション作成
                        createSession(data.start.customParameters?.phone_number);
                        break;
                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            endSession('completed');
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
