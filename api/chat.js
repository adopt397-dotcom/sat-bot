// ============================================================
// SAT 챗봇 API - Vercel Serverless Function (CORS + OpenAI 통합)
// ============================================================

export default async function handler(req, res) {
  // ============================================================
  // 1. CORS 헤더 설정 (모든 응답에 적용)
  // ============================================================
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // ============================================================
  // 2. OPTIONS (preflight) 처리
  // ============================================================
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ============================================================
  // 3. POST 요청만 처리
  // ============================================================
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { problemNumber, question } = req.body;

    // 입력값 검증
    if (!problemNumber || !question) {
      return res.status(400).json({
        error: '문제 번호(problemNumber)와 질문(question)을 모두 입력해주세요.'
      });
    }

    // ============================================================
    // 4. Google Sheets API에서 문제 조회 (Vercel 서버에서 호출)
    // ============================================================
    const SHEET_API_URL = 'https://script.google.com/macros/s/AKfycbx-S88kC_Ii_MxbibHmmHQYK_ITc1U9jphAxJ-uV0NSBGMFUidA3ItBE0niKhUyW32oMA/exec';
    
    const sheetRes = await fetch(`${SHEET_API_URL}?start=${problemNumber}&limit=1`);
    
    if (!sheetRes.ok) {
      return res.status(502).json({ error: '구글 시트 조회 실패' });
    }

    const sheetData = await sheetRes.json();

    if (!Array.isArray(sheetData) || sheetData.length === 0) {
      return res.status(404).json({
        error: `문제 번호 ${problemNumber}를 찾을 수 없습니다.`
      });
    }

    const problem = sheetData[0];
    const problemText = problem.Q || problem.question || '문제 텍스트 없음';
    const options = [
      problem['1'] || '선택지 1',
      problem['2'] || '선택지 2',
      problem['3'] || '선택지 3',
      problem['4'] || '선택지 4'
    ];
    const answer = problem.A || problem.answer || '정답 없음';

    // ============================================================
    // 5. OpenAI API 호출
    // ============================================================
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API 키가 설정되지 않았습니다.' });
    }

    const systemPrompt = `
      당신은 SAT 수학 튜터입니다.
      - 정답을 절대 바로 알려주지 마세요.
      - 힌트를 3단계로 나누어 제공하세요.
      - 학생이 스스로 풀 수 있도록 유도하세요.
    `;

    const userPrompt = `
      문제: ${problemText}
      보기: ${options.join(', ')}
      정답은 ${answer}입니다. (학생에게 절대 알려주지 마세요)
      학생 질문: ${question}
    `;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
        max_tokens: 600
      })
    });

    if (!openaiRes.ok) {
      const errorData = await openaiRes.json();
      return res.status(502).json({
        error: `OpenAI API 오류: ${errorData.error?.message || '알 수 없는 오류'}`
      });
    }

    const openaiData = await openaiRes.json();
    const aiMessage = openaiData.choices?.[0]?.message?.content ||
      '죄송합니다. 응답을 생성할 수 없었습니다.';

    // ============================================================
    // 6. 성공 응답
    // ============================================================
    return res.status(200).json({
      success: true,
      message: aiMessage,
      problem: {
        number: problemNumber,
        text: problemText,
        options: options,
        answer: answer
      }
    });

  } catch (error) {
    console.error('❌ 서버 오류:', error);
    return res.status(500).json({
      error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
}
