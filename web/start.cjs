const { spawn } = require('node:child_process');
const { createWebServer } = require('./server.cjs');

function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const browser = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    browser.on('error', error => process.stderr.write(`无法自动打开浏览器：${error.message}\n`));
    browser.unref();
  } catch (error) {
    process.stderr.write(`无法自动打开浏览器：${error.message}\n`);
  }
}

async function main() {
  const requestedPort = process.env.BURKIN_WEBUI_PORT === undefined ? 4173 : Number(process.env.BURKIN_WEBUI_PORT);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('BURKIN_WEBUI_PORT 必须是 0 到 65535 的整数');
  }
  let server;
  try { server = await createWebServer({ port: requestedPort }); }
  catch (error) {
    if (error.code !== 'EADDRINUSE' || requestedPort === 0) throw error;
    server = await createWebServer({ port: 0 });
  }
  process.stdout.write(`布尔金 WebUI 已启动：${server.url}\n关闭此窗口或按 Ctrl+C 即可停止。\n`);
  openBrowser(server.url);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  process.stderr.write(`WebUI 启动失败：${error.message}\n`);
  process.exitCode = 1;
});
