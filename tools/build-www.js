/* 把 app/src 打包成单文件 HTML（APK assets 与后端首页都用它）：node tools/build-www.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'app', 'src');
const out = path.join(__dirname, '..', 'app');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('css/app.css');
const jsFiles = ['js/data.js', 'js/core.js', 'js/ui.js', 'js/app.js'];
const js = jsFiles.map((f) => '/* ===== ' + f + ' ===== */\n' + read(f)).join('\n');

let html = read('index.html');
// 用函数式替换：字符串形式会把代码里的 $$ 吞成 $
html = html.replace('<!--__CSS__-->', () => '<style>\n' + css + '\n</style>');
html = html.replace('<!--__JS__-->', () => '<script>\n' + js + '\n</script>');
html = html.replace(/<link rel="manifest"[^>]*>/g, '');

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html, 'utf8');
console.log('app/index.html', (html.length / 1024).toFixed(1) + ' KB');
