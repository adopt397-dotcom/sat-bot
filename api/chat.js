// ============================================================
// SAT 챗봇 API - Vercel Serverless Function
// ============================================================

// CORS 헤더 및 요청 처리
export default function handler(req, res) {
  // 1. CORS 헤더 설정 (모든 요청에 적용)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. OPTIONS 요청 처리 (preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. POST 요청 처리 (실제 챗봇 로직)
  if (req.method === 'POST') {
    return handlePostRequest(req, res);
  }

  // 4. 잘못된 메서드 처리
  res.status(405).json({ error: 'Method Not Allowed' });
}

// ============================================================
// POST 요청 처리 함수
// ============================================================
async function handlePostRequest(req, res) {
  try {
    const { problemNumber, question } = req.body;

    // 입력값 검증
    if (!problemNumber || !question) {
      return res.status(400).json({
        error: '문제 번호(problemNumber)와 질문(question)을 모두 입력해주세요.'
      });
    }

    // 1. Google Sheets API에서 문제 데이터 조회
    const problemData = await fetchProblemFromSheet(problemNumber);

    if (!problemData) {
      return res.status(404).json({
        error: `문제 번호 ${problemNumber}를 찾을 수 없습니다.`
      });
    }

    // 2. OpenAI API를 호출하여 튜터 응답 생성
    const aiResponse = await generateTutorResponse(question, problemData);

    // 3. 성공 응답 반환
    return res.status(200).json({
      success: true,
      message: aiResponse,
      problem: {
        number: problemNumber,
        text: problemData.text,
        options: problemData.options,
        answer: problemData.answer
      }
    });

  } catch (error) {
    console.error('❌ API 오류:', error);
    return res.status(500).json({
      error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
}

// ============================================================
// Google Sheets API 연동 (문제 조회)
// ============================================================
async function fetchProblemFromSheet(problemNumber) {
  // Apps Script URL (구글 시트 데이터를 JSON으로 반환)
  const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbx-S88kC_Ii_MxbibHmmHQYK_ITc1U9jphAxJ-uV0NSBGMFUidA3ItBE0niKhUyW32oMA/exec';

  try {
    const response = await fetch(`${SHEET_API_URL}?start=${problemNumber}&limit=1`);
    
    if (!response.ok) {
      throw new Error(`시트 API 오류: ${response.status}`);
    }

    const data = await response.json();
    
    // 응답 데이터가 배열이고 첫 번째 항목이 존재하는지 확인
    if (Array.isArray(data) && data.length > 0) {
      const item = data[0];
      return {
        text: item.Q || item.question || '문제 텍스트가 없습니다.',
        options: [
          item['1'] || '선택지 1',
          item['2'] || '선택지 2',
          item['3'] || '선택지 3',
          item['4'] || '선택지 4'
        ],
        answer: item.A || item.answer || '1',
        explanation: item.E || item.explanation || '해설이 없습니다.'
      };
    }

    return null;
  } catch (error) {
    console.error('❌ 시트 조회 실패:', error);
    return null;
  }
}

// ============================================================
// OpenAI API 연동 (튜터 응답 생성)
// ============================================================
async function generateTutorResponse(studentQuestion, problemData) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다.');
  }

  const systemPrompt = `
    당신은 친절한 SAT 수학 튜터입니다. 다음 규칙을 철저히 따르세요:

    1. 학생이 "모르겠어요"라고 해도 정답을 절대 바로 알려주지 마세요.
    2. 힌트를 3단계로 나누어 제공하세요.
    3. 학생이 스스로 풀 수 있도록 유도하세요.
    4. 긍정적이고 격려하는 태도를 유지하세요.
    5. 수학 개념을 쉬운 예시와 연결해 설명하세요.
  `;

  const userPrompt = `
    [문제 정보]
    번호: ${problemData.number || '알 수 없음'}
    지문: ${problemData.text}
    보기: ${problemData.options.join(', ')}
    정답: ${problemData.answer} (학생에게 절대 알려주지 마세요)
    난이도: 중

    [학생 질문]
    "${studentQuestion}"

    위 학생의 질문에 대해 튜터로서 답변해주세요.
  `;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`OpenAI API 오류: ${errorData.error?.message || response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '죄송합니다. 응답을 생성할 수 없었습니다.';
  } catch (error) {
    console.error('❌ OpenAI 호출 실패:', error);
    throw new Error('AI 응답 생성 중 오류가 발생했습니다.');
  }
}
