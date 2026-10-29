/** 本地 mock Azure 发音评测：用于验证后端 /api/score 的请求契约与响应解析（不需要真实密钥） */
const http = require('http');
const PORT = Number(process.env.MOCK_PORT || 3999);

const log = (...a) => console.log('[mock-azure]', ...a);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const problems = [];

    const raw = req.headers['pronunciation-assessment'];
    if (!raw) {
      problems.push('missing Pronunciation-Assessment header');
    } else {
      let cfg = null;
      try {
        cfg = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      } catch (e) {
        problems.push('Pronunciation-Assessment is not base64(JSON): ' + e.message);
      }
      if (cfg) {
        log('config', JSON.stringify(cfg));
        if (!cfg.ReferenceText) problems.push('ReferenceText missing');
        if (!cfg.GradingSystem) problems.push('GradingSystem missing');
      }
    }

    const ct = req.headers['content-type'] || '';
    if (!/audio\/wav/.test(ct)) problems.push('bad content-type: ' + ct);
    if (body.slice(0, 4).toString('ascii') !== 'RIFF') {
      problems.push('body is not a RIFF WAV (first bytes: ' + JSON.stringify(body.slice(0, 8).toString('ascii')) + ')');
    }
    if (!req.headers['ocp-apim-subscription-key']) problems.push('missing subscription key');

    if (problems.length) {
      log('400 ->', problems.join(' | '));
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request: ' + problems.join('; '));
    }

    const text = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).ReferenceText;
    const words = String(text).replace(/[^A-Za-z' ]/g, '').split(/\s+/).filter(Boolean);
    const payload = {
      RecognitionStatus: 'Success',
      DisplayText: text,
      Offset: 0,
      Duration: 24000000,
      NBest: [
        {
          Confidence: 0.94,
          Display: text,
          PronScore: 86.4,
          AccuracyScore: 88.1,
          FluencyScore: 82.0,
          CompletenessScore: 100,
          Words: words.map((w, i) => ({
            Word: w,
            Offset: i * 1000000,
            Duration: 5000000,
            PronunciationAssessment: {
              AccuracyScore: i === 1 ? 61.2 : i === 3 ? 74.5 : 93.0,
              ErrorType: 'None',
            },
          })),
        },
      ],
    };
    log('200 -> words=' + words.length + ' body=' + body.length + 'B');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}).listen(PORT, () => log('listening on', PORT));
