// OpenAI と Twilio の直書きの宛先を、シミュレータの偽物（SIM_FAKE_BASE）へ向ける
import realFetch from 'node-fetch';
export * from 'node-fetch';
const BASE = process.env.SIM_FAKE_BASE;
const rewrite = (u) => String(u)
    .replace('https://api.openai.com', `${BASE}/openai`)
    .replace('https://api.twilio.com', `${BASE}/twilio`);
export default function fetch(url, opts) {
    return realFetch(rewrite(url), opts);
}
