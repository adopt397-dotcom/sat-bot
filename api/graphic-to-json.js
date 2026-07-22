// ============================================================
// GongBoo Graphic-to-JSON API v1.0
// Converts an uploaded educational diagram into Super Graphic JSON.
// The source image is used only for the request and is never stored.
// ============================================================

const MAX_IMAGE_DATA_URL_LENGTH = 3_000_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      service: 'GongBoo Graphic-to-JSON API',
      version: '1.0.0',
      status: process.env.OPENAI_API_KEY ? 'ready' : 'configuration_required'
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ success: false, error: 'Graphic conversion service is not configured.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const imageDataUrl = String(body.imageDataUrl || '').trim();
    const imageCheck = validateImageDataUrl(imageDataUrl);
    if (!imageCheck.valid) return res.status(400).json({ success: false, error: imageCheck.message });

    const model = process.env.OPENAI_GRAPHIC_MODEL || 'gpt-4.1-mini';
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        instructions: buildInstructions(),
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Analyze this educational diagram and return the requested conversion decision.' },
            { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
          ]
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'gongboo_graphic_conversion',
            strict: true,
            schema: conversionSchema()
          }
        },
        max_output_tokens: 4200
      })
    });

    const responseData = await readJsonSafely(response);
    if (!response.ok) {
      console.error('Graphic conversion OpenAI error:', response.status, responseData?.error?.message);
      throw new Error('Graphic analysis request failed.');
    }

    const result = normalizeConversion(JSON.parse(extractOpenAIText(responseData)));
    return res.status(200).json({
      success: true,
      status: result.status,
      json: result.json,
      warnings: result.warnings,
      requiresReview: result.requiresReview,
      model
    });
  } catch (error) {
    console.error('Graphic-to-JSON API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Graphic conversion could not be completed. Try a clearer diagram or enter JSON manually.'
    });
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function validateImageDataUrl(value) {
  if (!value) return { valid: false, message: 'An image is required.' };
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return { valid: false, message: 'Image is too large. Use an image smaller than about 2 MB.' };
  }
  const match = /^data:([^;,]+);base64,[A-Za-z0-9+/=\s]+$/i.exec(value);
  if (!match || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase())) {
    return { valid: false, message: 'Use a PNG, JPEG, WEBP, or GIF image file.' };
  }
  return { valid: true };
}

function buildInstructions() {
  return `You convert educational diagrams into GongBoo Super Graphic Engine v1 JSON.

Return READY only when the mathematical meaning is clear and a compact structured representation is feasible.
Return NEEDS_REVIEW when it can render but visual placement needs human adjustment.
Return NEEDS_CONFIRMATION when any mathematical value, label, solid-versus-dashed distinction, endpoint type, equation, domain, boundary, tangent/intersection, or answer-relevant detail is uncertain.
Return UNSUPPORTED when a structured recreation would be unreliable or has no practical benefit. Do not invent information.

For READY, NEEDS_REVIEW, or NEEDS_CONFIRMATION, graphicJson must be one valid JSON object encoded as a string:
{"engine":"super","schemaVersion":"1.0","type":"scene"|"calculus.functionGraph"|"calculus.regionBetweenCurves"|"calculus.tangent"|"calculus.secant"|"calculus.piecewise","data":{...},"layout":{...}}

Keep the JSON compact. The renderer requires these exact calculus fields:
- calculus.functionGraph: data.coordinateSystem and data.curves (not data.functions). Example: {"data":{"coordinateSystem":{"xRange":[-3,3],"yRange":[-2,5]},"curves":[{"id":"f","expression":"x^2","domain":[-2,2]}]}}
- calculus.regionBetweenCurves: the same data.curves array plus data.region with upper, lower, and xRange. Example: {"region":{"upper":"g","lower":"f","xRange":[0,2]}}
- calculus.piecewise: data.coordinateSystem and data.pieces. Every piece is a separate object such as {"expression":"2*x+1","domain":[-3,0]}. Never use piecewise(), if/then, comparison operators, ampersands, or multiple expressions inside one string.

Use only coordinate systems, points, lines, segments, rays, curves, simple shapes, polygons, regions, vectors, text, and math labels. Expressions use x, numbers, parentheses, + - * / ^, sqrt, abs, sin, cos, tan, exp, log, pi, and e. Domains are [min,max].
Do not include source images, data URLs, external URLs, file IDs, markdown, explanations, or code fences in graphicJson.
For UNSUPPORTED, use an empty graphicJson string. Warnings must be short Korean strings.`;
}

function conversionSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['status', 'graphicJson', 'warnings', 'requiresReview'],
    properties: {
      status: { type: 'string', enum: ['READY', 'NEEDS_REVIEW', 'NEEDS_CONFIRMATION', 'UNSUPPORTED'] },
      graphicJson: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
      requiresReview: { type: 'boolean' }
    }
  };
}

function normalizeConversion(value) {
  const allowed = new Set(['READY', 'NEEDS_REVIEW', 'NEEDS_CONFIRMATION', 'UNSUPPORTED']);
  const status = allowed.has(value?.status) ? value.status : 'NEEDS_CONFIRMATION';
  const warnings = Array.isArray(value?.warnings)
    ? value.warnings.map(item => String(item).trim()).filter(Boolean).slice(0, 12) : [];
  if (status === 'UNSUPPORTED') return { status, json: null, warnings, requiresReview: true };

  let json;
  try { json = JSON.parse(String(value?.graphicJson || '')); } catch {
    return { status: 'NEEDS_CONFIRMATION', json: null, warnings: [...warnings, '생성된 JSON을 해석할 수 없습니다.'], requiresReview: true };
  }
  if (!isBasicSuperGraphic(json)) {
    return { status: 'NEEDS_CONFIRMATION', json: null, warnings: [...warnings, 'Super Graphic 기본 형식 검증에 실패했습니다.'], requiresReview: true };
  }
  return { status, json, warnings, requiresReview: Boolean(value?.requiresReview) || status !== 'READY' };
}

function isBasicSuperGraphic(json) {
  return Boolean(json && typeof json === 'object' && !Array.isArray(json) &&
    json.engine === 'super' && /^1(?:\.|$)/.test(String(json.schemaVersion || '')) &&
    new Set(['scene', 'calculus.functionGraph', 'calculus.regionBetweenCurves', 'calculus.tangent', 'calculus.secant', 'calculus.piecewise']).has(json.type) &&
    json.data && typeof json.data === 'object' && !Array.isArray(json.data));
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const parts = [];
  for (const outputItem of Array.isArray(data?.output) ? data.output : []) {
    for (const contentItem of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string') parts.push(contentItem.text);
    }
  }
  return parts.join('\n').trim();
}

async function readJsonSafely(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 500) } }; }
}
