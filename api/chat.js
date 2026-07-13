// ============================================================
// SAT Tutor API v2.1
// - New multilingual sheet schema support
// - Frontend context first, Google Sheet fallback
// - Learn / Study / Exam mode-aware tutoring
// - OpenAI primary, DeepSeek fallback
// ============================================================

const DEFAULT_SHEET_API_URL =
  'https://script.google.com/macros/s/AKfycbwLVA2OJ3H9RAKgzP3NvCWkDCGyRIAhxT6svLU6bvUT-oq1dxrFQSJQ31vb6z7Kyxnk/exec';

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      service: 'SAT Tutor API',
      version: '2.1.0',
      provider: getConfiguredProvider(),
      status: 'ready'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method Not Allowed'
    });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const problemNumber = toCleanString(body.problemNumber);
    const studentQuestion = toCleanString(body.question);
    const incomingContext =
      body.context && typeof body.context === 'object' ? body.context : null;

    if (!studentQuestion) {
      return res.status(400).json({
        success: false,
        error: '질문 내용을 입력해주세요.'
      });
    }

    let problem = normalizeProblem(incomingContext);

    // Frontend context is preferred because it already contains the exact
    // currently displayed question and language fields.
    if (!hasUsableProblem(problem)) {
      if (!problemNumber) {
        return res.status(400).json({
          success: false,
          error: '현재 문제 정보를 찾을 수 없습니다.'
        });
      }

      problem = await fetchProblemFromSheet(problemNumber);
    }

    if (!hasUsableProblem(problem)) {
      return res.status(404).json({
        success: false,
        error: `문제 번호 ${problemNumber || ''}를 찾을 수 없습니다.`
      });
    }

    const mode = normalizeMode(
      incomingContext?.currentMode || body.mode || 'study'
    );
    const language = normalizeLanguage(
      incomingContext?.currentLanguage || body.language || 'KO'
    );

    const systemPrompt = buildSystemPrompt({
      mode,
      language
    });

    const userPrompt = buildUserPrompt({
      problem,
      studentQuestion,
      mode,
      language
    });

    const aiResult = await callConfiguredAI({
      systemPrompt,
      userPrompt
    });

    return res.status(200).json({
      success: true,
      message: aiResult.message,
      provider: aiResult.provider,
      model: aiResult.model,
      mode,
      language,
      problem: {
        number: problem.N || problemNumber || '',
        sourceId: problem.SOURCE_ID || '',
        subject: problem.SUBJECT || 'SAT'
      }
    });
  } catch (error) {
    console.error('SAT Tutor API error:', error);

    return res.status(500).json({
      success: false,
      error: sanitizeErrorMessage(error)
    });
  }
}

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader('Cache-Control', 'no-store');
}

function getConfiguredProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  return 'none';
}

async function fetchProblemFromSheet(problemNumber) {
  const sheetApiUrl =
    process.env.GOOGLE_SHEET_API_URL || DEFAULT_SHEET_API_URL;

  const url = new URL(sheetApiUrl);
  url.searchParams.set('start', String(problemNumber));
  url.searchParams.set('limit', '1');
  url.searchParams.set('_', String(Date.now()));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Google Sheet API HTTP ${response.status}`);
  }

  const payload = await response.json();

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.questions)
        ? payload.questions
        : [];

  if (rows.length === 0) {
    return null;
  }

  return normalizeProblem(rows[0]);
}

function normalizeProblem(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const normalized = {};

  for (const [key, value] of Object.entries(raw)) {
    normalized[normalizeKey(key)] = value;
  }

  const get = (...keys) => {
    for (const key of keys) {
      const normalizedKey = normalizeKey(key);

      if (
        Object.prototype.hasOwnProperty.call(normalized, normalizedKey) &&
        normalized[normalizedKey] !== null &&
        normalized[normalizedKey] !== undefined
      ) {
        return normalized[normalizedKey];
      }
    }

    return '';
  };

  return {
    N: get('N', 'NUMBER', 'PROBLEMNUMBER'),
    SUBJECT: get('SUBJECT') || 'SAT',

    Q_EN: get('Q_EN', 'QUESTION_EN', 'Q', 'QUESTION'),
    Q_KO: get('Q_KO', 'QUESTION_KO'),

    P_EN: get('P_EN', 'PASSAGE_EN', 'P', 'PASSAGE'),
    P_KO: get('P_KO', 'PASSAGE_KO'),

    '1_EN': get('1_EN', 'CHOICE1_EN', 'OPTION1_EN', '1'),
    '1_KO': get('1_KO', 'CHOICE1_KO', 'OPTION1_KO'),

    '2_EN': get('2_EN', 'CHOICE2_EN', 'OPTION2_EN', '2'),
    '2_KO': get('2_KO', 'CHOICE2_KO', 'OPTION2_KO'),

    '3_EN': get('3_EN', 'CHOICE3_EN', 'OPTION3_EN', '3'),
    '3_KO': get('3_KO', 'CHOICE3_KO', 'OPTION3_KO'),

    '4_EN': get('4_EN', 'CHOICE4_EN', 'OPTION4_EN', '4'),
    '4_KO': get('4_KO', 'CHOICE4_KO', 'OPTION4_KO'),

    A: get('A', 'ANSWER'),

    E_EN: get('E_EN', 'EXPLANATION_EN', 'E', 'EXPLANATION'),
    E_KO: get('E_KO', 'EXPLANATION_KO'),

    G: get('G', 'GRAPHIC'),
    D: get('D', 'DIFFICULTY'),

    SOURCE_TYPE: get('SOURCE_TYPE'),
    VARIANT_NO: get('VARIANT_NO'),
    SOURCE_ID: get('SOURCE_ID'),
    STATUS: get('STATUS'),

    currentMode: get('CURRENTMODE', 'CURRENT_MODE'),
    currentLanguage: get('CURRENTLANGUAGE', 'CURRENT_LANGUAGE')
  };
}

function hasUsableProblem(problem) {
  if (!problem) return false;

  return Boolean(
    toCleanString(problem.Q_EN) ||
    toCleanString(problem.Q_KO) ||
    toCleanString(problem.P_EN) ||
    toCleanString(problem.P_KO)
  );
}

function normalizeKey(key) {
  return String(key ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toUpperCase();
}

function normalizeMode(mode) {
  const value = toCleanString(mode).toLowerCase();

  return ['learn', 'study', 'exam'].includes(value)
    ? value
    : 'study';
}

function normalizeLanguage(language) {
  const value = toCleanString(language).toUpperCase();

  return value === 'EN' ? 'EN' : 'KO';
}

function buildSystemPrompt({ mode, language }) {
  const languageRule =
    language === 'EN'
      ? 'Respond primarily in English.'
      : 'Respond primarily in Korean, but keep important SAT terms in English when useful.';

  const sharedRules = `
You are an expert Digital SAT tutor for Reading, Writing, and Math.

General rules:
- Be accurate, concise, supportive, and educational.
- Use the supplied problem context as the source of truth.
- Explain why the correct choice works and why tempting distractors fail when relevant.
- Do not invent missing facts.
- If the question contains math, show the minimum clear steps.
- If the student asks about vocabulary, explain meaning, context, and contrast with nearby choices.
- ${languageRule}
`;

  if (mode === 'learn') {
    return `${sharedRules}

Mode: LEARN
- The student is learning from the answer and explanation.
- You may reveal the correct answer directly.
- Prioritize understanding, concept connections, and a simple explanation.
- End with one short takeaway.`;
  }

  if (mode === 'exam') {
    return `${sharedRules}

Mode: EXAM
- Do not reveal the correct answer or quote the official explanation.
- Give only a short strategic hint or point the student to the relevant evidence.
- Preserve realistic test conditions.
- If the student explicitly asks for the answer, politely refuse and give a hint instead.`;
  }

  return `${sharedRules}

Mode: STUDY
- Give guided help first.
- You may confirm the correct answer when the student has attempted the problem
  or explicitly asks for an explanation.
- Focus on immediate feedback and correcting misconceptions.`;
}

function buildUserPrompt({
  problem,
  studentQuestion,
  mode,
  language
}) {
  const choices = [1, 2, 3, 4]
    .map((number) => {
      const en = toCleanString(problem[`${number}_EN`]);
      const ko = toCleanString(problem[`${number}_KO`]);

      if (!en && !ko) return '';

      return `${number}. EN: ${en || '(none)'}\n   KO: ${ko || '(none)'}`;
    })
    .filter(Boolean)
    .join('\n');

  const answer = toCleanString(problem.A);
  const explanationEn = toCleanString(problem.E_EN);
  const explanationKo = toCleanString(problem.E_KO);

  return `
CURRENT PROBLEM CONTEXT

Number: ${toCleanString(problem.N)}
Subject: ${toCleanString(problem.SUBJECT) || 'SAT'}
Mode: ${mode}
Student language: ${language}

Question EN:
${toCleanString(problem.Q_EN) || '(none)'}

Question KO:
${toCleanString(problem.Q_KO) || '(none)'}

Passage EN:
${toCleanString(problem.P_EN) || '(none)'}

Passage KO:
${toCleanString(problem.P_KO) || '(none)'}

Choices:
${choices || '(subjective / no multiple-choice options)'}

Correct answer:
${answer || '(none)'}

Official explanation EN:
${explanationEn || '(none)'}

Official explanation KO:
${explanationKo || '(none)'}

Graphic JSON or reference:
${toCleanString(problem.G) || '(none)'}

Difficulty:
${toCleanString(problem.D) || '(none)'}

STUDENT QUESTION:
${studentQuestion}
`.trim();
}

async function callConfiguredAI({
  systemPrompt,
  userPrompt
}) {
  if (process.env.OPENAI_API_KEY) {
    return callOpenAI({
      systemPrompt,
      userPrompt
    });
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return callDeepSeek({
      systemPrompt,
      userPrompt
    });
  }

  throw new Error(
    'OPENAI_API_KEY 또는 DEEPSEEK_API_KEY 환경변수가 필요합니다.'
  );
}

async function callOpenAI({
  systemPrompt,
  userPrompt
}) {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  const response = await fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: userPrompt,
        max_output_tokens: 700
      })
    }
  );

  const data = await readJsonSafely(response);

  if (!response.ok) {
    throw new Error(
      `OpenAI API ${response.status}: ${
        data?.error?.message || 'Unknown error'
      }`
    );
  }

  const message = extractOpenAIText(data);

  if (!message) {
    throw new Error('OpenAI 응답 본문이 비어 있습니다.');
  }

  return {
    provider: 'openai',
    model,
    message
  };
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') {
    return data.output_text.trim();
  }

  if (!Array.isArray(data?.output)) {
    return '';
  }

  const parts = [];

  for (const outputItem of data.output) {
    if (!Array.isArray(outputItem?.content)) continue;

    for (const contentItem of outputItem.content) {
      if (
        contentItem?.type === 'output_text' &&
        typeof contentItem?.text === 'string'
      ) {
        parts.push(contentItem.text);
      }
    }
  }

  return parts.join('\n').trim();
}

async function callDeepSeek({
  systemPrompt,
  userPrompt
}) {
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  const response = await fetch(
    'https://api.deepseek.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.4,
        max_tokens: 700
      })
    }
  );

  const data = await readJsonSafely(response);

  if (!response.ok) {
    throw new Error(
      `DeepSeek API ${response.status}: ${
        data?.error?.message || 'Unknown error'
      }`
    );
  }

  const message =
    data?.choices?.[0]?.message?.content?.trim();

  if (!message) {
    throw new Error('DeepSeek 응답 본문이 비어 있습니다.');
  }

  return {
    provider: 'deepseek',
    model,
    message
  };
}

async function readJsonSafely(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: text.slice(0, 500)
      }
    };
  }
}

function sanitizeErrorMessage(error) {
  const message = toCleanString(error?.message);

  if (!message) {
    return '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
  }

  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 800);
}

function toCleanString(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') {
    return value.trim();
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
