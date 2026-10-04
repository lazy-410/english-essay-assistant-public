// M1 冒烟入口（临时）：验证「JNI 启动 Node → 127.0.0.1 服务 → WebView 打开」整链。
// M3 起由 scripts/build-android.mjs 用混淆后的正式 app.cjs 替换。
const http = require('node:http');
const { versions, platform, arch } = process;
console.log('[android-smoke] node started', versions.node, platform, arch);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, node: versions.node, platform, arch }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8">
<h2>Android 冒烟 OK</h2>
<p>Node ${versions.node} · ${platform}/${arch}</p>
<p>环境注入: EEA_NO_BROWSER=${process.env.EEA_NO_BROWSER ?? '(未注入)'}
<br>EEA_LICENSE_DIR=${process.env.EEA_LICENSE_DIR ?? '(未注入)'}
<br>HOME=${process.env.HOME ?? '(未注入)'}</p>`);
});

server.listen(7654, '127.0.0.1', () => console.log('[android-smoke] listening on 7654'));
