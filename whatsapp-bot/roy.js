const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const SYSTEM_PROMPT = `You are Roy, a friendly and helpful personal WhatsApp assistant. Your job is to help the user reply to their WhatsApp messages.

When given a message, draft a natural, polite, and concise reply on behalf of the user.

Guidelines:
- Keep replies short and conversational (1-3 sentences usually)
- Match the tone of the incoming message (casual for friends, professional for work)
- Be warm and friendly, never robotic
- Do not add unnecessary filler phrases like "Certainly!" or "Of course!"
- Write the reply as if YOU are the user — first person, natural language
- If the message is in another language, reply in the same language
- If the message is unclear or vague, ask a simple clarifying question

Reply with ONLY the draft message text. Do not add explanations, labels, or quotation marks.`;

async function draftReply(incomingMessage, senderName, chatHistory = []) {
  // Build context from recent chat history
  let contextText = '';
  if (chatHistory.length > 1) {
    const recent = chatHistory.slice(-8); // Last 8 messages
    contextText = '\n\nRecent conversation context:\n' +
      recent.map(m => `${m.fromMe ? 'Me' : senderName}: ${m.body}`).join('\n');
  }

  const userPrompt = `${senderName} sent you this message: "${incomingMessage}"${contextText}

Draft a reply for me to send back.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt }
    ]
  });

  return response.content[0].text.trim();
}

module.exports = { draftReply };
