/**
 * 本地 mock Azure 语音合成：验证 server /api/tts 的请求契约。
 * 规则模拟真实 Azure：
 *  - 缺 User-Agent -> 400
 *  - rate="1x" 这类非百分比写法 -> 400
 *  - 合法请求 -> 200 audio/mpeg（假 mp3 字节）
 */
const http = require('http');
const PORT = Number(process.env.MOCK_PORT || 3998);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const ssml = Buffer.concat(chunks).toString('utf8');
    const problems = [];
    if (!req.headers['ocp-apim-subscription-key']) problems.push('missing key');
    if (!/ssml\+xml/.test(req.headers['content-type'] || '')) problems.push('bad content-type: ' + req.headers['content-type']);
    if (!req.headers['x-microsoft-outputformat']) problems.push('missing X-Microsoft-OutputFormat');
    if (!req.headers['user-agent']) problems.push('missing User-Agent');

    const m = ssml.match(/rate="([^"]+)"/);
    if (m && !/^[+-]?\d+(\.\d+)?%$/.test(m[1])) problems.push('bad prosody rate: ' + m[1]);
    if (m && process.env.MOCK_REJECT_PROSDY) problems.push('ssml rejected: prosody not supported (strict mode)');
    if (!/<speak[\s\S]*<voice name="[^"]+"/.test(ssml)) problems.push('bad ssml');
    if (!/[\u4e00-\u9fff]/.test(ssml) && /&(?!(amp|lt|gt|quot|apos);)/.test(ssml)) problems.push('unescaped entity');

    if (problems.length) {
      console.log('[mock-tts] 400 <-', problems.join(' | '));
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request: ' + problems.join('; '));
    }
    const voice = (ssml.match(/voice name="([^"]+)"/) || [])[1];
    const rate = m ? m[1] : '(none)';
    console.log('[mock-tts] 200 voice=' + voice + ' rate=' + rate + ' len=' + ssml.length);
    const fake = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2048, 0x55)]);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fake.length });
    res.end(fake);
  });
}).listen(PORT, () => console.log('[mock-tts] listening on', PORT));
