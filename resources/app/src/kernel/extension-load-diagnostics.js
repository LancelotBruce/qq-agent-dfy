export function extensionLoadDiagnostic(error) {
  const message = String(error?.message ?? error);
  if (/当前仅验证 QQ Agent 0\.4\.0|仅支持.{0,12}0\.4/.test(message)) return {
    code: 'COMPAT04_HOST_VERSION_RESTRICTED',
    message: '此插件自检限定 0.4，拒绝在当前版本运行；需要作者更新宿主兼容声明与接口。程序没有绕过该检查。',
  };
  const missing = String(error?.url ?? message).replaceAll('\\', '/').match(/\/app\/src\/([a-zA-Z0-9_./-]+\.[cm]?js)/);
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && missing) return {
    code: 'COMPAT04_PRIVATE_IMPORT_UNSUPPORTED',
    message: `此插件直接引用了尚未兼容的旧宿主模块 src/${missing[1]}；插件原包与资料已保留。`,
  };
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'EXTENSION_LOAD_FAILED';
  return {code, message: message.startsWith(`[${code}] `) ? message.slice(code.length + 3) : message};
}

export function dependencyLoadMessage(missing, providers = []) {
  return missing.map(name => {
    const candidates = providers.filter(row => row.capabilities?.includes(name));
    if (!candidates.length) return `${name}：缺少提供此能力的前置插件，请安装该插件要求的依赖`;
    return `${name}：请先启用或修复前置插件 ${candidates.map(row => `“${row.name || row.id}”`).join('、')}`;
  }).join('；');
}
