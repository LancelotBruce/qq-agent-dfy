// 设置页里的 QQ 自启开关。只调宿主组合层提供的 /api/qq-autostart，
// 不读全局配置、不碰令牌，也不改看门狗和协议端。
import { request } from '../panel-client.js';

const card = document.getElementById('qq-autostart-card');
if (card) {
  const enabled = document.getElementById('qq-autostart-enabled');
  const delay = document.getElementById('qq-autostart-delay');
  const save = document.getElementById('qq-autostart-save');
  const state = document.getElementById('qq-autostart-state');
  const note = document.getElementById('qq-autostart-note');

  function render(data) {
    enabled.checked = Boolean(data?.enabled);
    delay.value = Number(data?.delaySec) || 45;
    state.textContent = data?.enabled ? '已启用' : '未启用';
    state.classList.toggle('on', Boolean(data?.enabled));
    note.textContent = data?.qqPath
      ? `QQ：${data.qqPath}｜${data.note || ''}`
      : '没找到 QQ.exe。先确认 QQ 已安装，再保存。';
  }

  async function load() {
    save.disabled = true;
    try { render(await request('GET', '/api/qq-autostart')); }
    catch (error) { state.textContent = '读取失败'; note.textContent = error?.message || String(error); }
    finally { save.disabled = false; }
  }

  save.addEventListener('click', async () => {
    save.disabled = true;
    state.textContent = '保存中';
    try {
      const data = await request('POST', '/api/qq-autostart', {
        enabled: Boolean(enabled.checked),
        delaySec: Math.min(300, Math.max(5, Math.round(Number(delay.value) || 45))),
      });
      render(data);
      state.textContent = data?.enabled ? '已启用' : '已关闭';
    } catch (error) {
      state.textContent = '保存失败';
      note.textContent = error?.message || String(error);
    } finally { save.disabled = false; }
  });

  load();
}
