// ============================================================================
// POST /api/debate/check-argument — Safety check on a user-typed debate argument
// ============================================================================
// Used by the human-player feature: when a user submits their own argument in
// a debate, we run it through the same Gemini classifier we use for topic
// safety, just adapted to "would you publish this on a debate platform?"
//
// Returns { safe: true } or { safe: false } so the frontend can show an inline
// error and let the user edit and retry. No tokens are charged.
// ============================================================================

import { NextRequest } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export async function POST(request: NextRequest) {
  const body = await request.json() as { text?: string };
  const text = (body.text || '').trim();

  if (!text) {
    return Response.json({ error: 'Empty argument' }, { status: 400 });
  }
  if (text.length > 4000) {
    return Response.json({ error: 'Argument is too long' }, { status: 400 });
  }

  try {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const prompt = `A debate platform lets users submit their own debate arguments. Your job: decide if this argument is safe to publish.

Say NO only if the argument:
- Provides step-by-step instructions to build weapons, bombs, drugs, or poisons
- Contains content sexualising minors
- Provides instructions to carry out specific acts of violence or terrorism
- Doxxes a real person: reveals private information such as home addresses, phone numbers, workplaces, or personal contact details. NOT including criticism, opinion, or unflattering claims about public figures.
- Sustained personal attacks intended to harass a specific individual. NOT including disagreement with their work, opinions, products, or public actions.

Say YES for everything else, including:
- Provocative or controversial opinions
- Religious, political, or ethical positions you disagree with
- Criticism of public figures, politicians, celebrities, brands, companies, platforms, products, or their policies — even harshly worded, one-sided, or unfair
- Dark humour, taboo subjects, hypothetical scenarios
- Bad arguments, incoherent text, single-word replies
- Anything that is a legitimate (if uncomfortable) thing to say in a debate

Argument:
"""
${text}
"""

Respond with ONLY one word: YES or NO`;

    console.log('[USER ARG SAFETY] Checking:', text.slice(0, 100));

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } },
    });

    const verdict = (response.text?.trim().toUpperCase() || '');
    const safe = verdict.startsWith('YES');
    console.log(`[USER ARG SAFETY] ${safe ? 'PASSED' : 'BLOCKED'}`);

    return Response.json({ safe });
  } catch (err) {
    // Fail closed: if the safety check itself errors, treat as unsafe.
    console.error('[USER ARG SAFETY] error:', err);
    return Response.json({ safe: false });
  }
}
