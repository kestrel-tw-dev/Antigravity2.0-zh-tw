const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const child_process = require('child_process');

// 關閉 Electron 對 .asar 檔案的虛擬檔案系統攔截，確保原生檔案讀寫正常運作
process.noAsar = true;

// ============================================================
// Pure JS ASAR 手術式零延遲引擎（無需 npx / @electron/asar / 外部依賴）
// 支持完整 Chromium Pickle / ASAR 格式，毫秒級讀寫與增量補丁
// ============================================================
function readFilesFromAsar(asarPath, targetFiles) {
    const fd = fs.openSync(asarPath, 'r');
    const headerBuf = Buffer.alloc(16);
    fs.readSync(fd, headerBuf, 0, 16, 0);
    const magic = headerBuf.readUInt32LE(0);
    if (magic !== 4) { fs.closeSync(fd); throw new Error("Invalid ASAR magic"); }
    const jsonSize = headerBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const padding = (4 - (jsonSize % 4)) % 4;
    const payloadStart = 16 + jsonSize + padding;

    const results = {};
    for (const relPath of targetFiles) {
        const parts = relPath.split('/');
        let cur = header;
        for (const p of parts) {
            if (!cur.files || !cur.files[p]) { cur = null; break; }
            cur = cur.files[p];
        }
        if (cur && cur.offset !== undefined && cur.size !== undefined) {
            const off = payloadStart + parseInt(cur.offset, 10);
            const buf = Buffer.alloc(cur.size);
            fs.readSync(fd, buf, 0, cur.size, off);
            results[relPath] = buf.toString('utf8');
        } else {
            results[relPath] = null;
        }
    }
    fs.closeSync(fd);
    return results;
}

function surgicalPatchAsar(originalAsarPath, targetAsarPath, replacements) {
    const fd = fs.openSync(originalAsarPath, 'r');
    const headerBuf = Buffer.alloc(16);
    fs.readSync(fd, headerBuf, 0, 16, 0);
    const magic = headerBuf.readUInt32LE(0);
    if (magic !== 4) { fs.closeSync(fd); throw new Error("Invalid ASAR magic: " + magic); }
    const jsonSize = headerBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const padding = (4 - (jsonSize % 4)) % 4;
    const oldPayloadStart = 16 + jsonSize + padding;

    const fileEntries = [];
    function traverse(node, curPath) {
        if (!node || !node.files) return;
        for (const [name, info] of Object.entries(node.files)) {
            const relPath = curPath ? `${curPath}/${name}` : name;
            if (info.files) {
                traverse(info, relPath);
            } else {
                if (info.unpacked) continue;
                if (replacements[relPath] !== undefined) {
                    const newBuf = Buffer.isBuffer(replacements[relPath]) 
                        ? replacements[relPath] 
                        : Buffer.from(replacements[relPath], 'utf8');
                    fileEntries.push({
                        path: relPath,
                        node: info,
                        isReplaced: true,
                        newBuffer: newBuf,
                        size: newBuf.length
                    });
                } else {
                    fileEntries.push({
                        path: relPath,
                        node: info,
                        isReplaced: false,
                        oldOffset: oldPayloadStart + parseInt(info.offset, 10),
                        oldSize: info.size,
                        size: info.size
                    });
                }
            }
        }
    }
    traverse(header, '');

    let currentOffset = 0;
    for (const entry of fileEntries) {
        entry.node.offset = currentOffset.toString();
        entry.node.size = entry.size;
        currentOffset += entry.size;
    }

    const newJsonString = JSON.stringify(header);
    const newJsonBuffer = Buffer.from(newJsonString, 'utf8');
    const newJsonSize = newJsonBuffer.length;
    const newPadding = (4 - (newJsonSize % 4)) % 4;
    const newHeaderPickleSize = newJsonSize + newPadding + 8;
    const newHeaderJsonPickleSize = newJsonSize + newPadding + 4;

    const newHeaderBuffer = Buffer.alloc(16 + newJsonSize + newPadding);
    newHeaderBuffer.writeUInt32LE(4, 0);
    newHeaderBuffer.writeUInt32LE(newHeaderPickleSize, 4);
    newHeaderBuffer.writeUInt32LE(newHeaderJsonPickleSize, 8);
    newHeaderBuffer.writeUInt32LE(newJsonSize, 12);
    newJsonBuffer.copy(newHeaderBuffer, 16);

    const outFd = fs.openSync(targetAsarPath, 'w');
    fs.writeSync(outFd, newHeaderBuffer, 0, newHeaderBuffer.length, 0);
    let writePos = newHeaderBuffer.length;

    const copyBuf = Buffer.alloc(1024 * 1024);
    for (const entry of fileEntries) {
        if (entry.isReplaced) {
            fs.writeSync(outFd, entry.newBuffer, 0, entry.newBuffer.length, writePos);
            writePos += entry.newBuffer.length;
        } else {
            let remaining = entry.oldSize;
            let readOffset = entry.oldOffset;
            while (remaining > 0) {
                const toRead = Math.min(remaining, copyBuf.length);
                fs.readSync(fd, copyBuf, 0, toRead, readOffset);
                fs.writeSync(outFd, copyBuf, 0, toRead, writePos);
                readOffset += toRead;
                writePos += toRead;
                remaining -= toRead;
            }
        }
    }

    fs.closeSync(fd);
    fs.closeSync(outFd);
}
// ============================================================

// macOS 环境下自动补全 PATH，确保 codesign 等工具能被顺利找到
if (process.platform === 'darwin') {
    const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin'];
    const currentPaths = (process.env.PATH || '').split(':');
    for (const p of extraPaths) {
        if (!currentPaths.includes(p) && fs.existsSync(p)) {
            currentPaths.unshift(p);
        }
    }
    const nodeBinDir = path.dirname(process.execPath);
    if (!currentPaths.includes(nodeBinDir)) {
        currentPaths.unshift(nodeBinDir);
    }
    process.env.PATH = currentPaths.join(':');
}

function classifyLocaleTag(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const norm = tag.trim().toLowerCase().replace(/_/g, '-');
    if (!norm) return null;
    if (
        norm === 'tw' || norm === 'cht' ||
        /^zh-(hant|tw|hk|mo)\b/.test(norm) ||
        /^zh-.*-(tw|hk|mo|hant)\b/.test(norm)
    ) {
        return 'tw';
    }
    if (
        norm === 'cn' || norm === 'sc' || norm === 'chs' || norm === 'zh' ||
        /^zh-(hans|cn|sg|my)\b/.test(norm) ||
        /^zh-.*-(cn|sg|my|hans)\b/.test(norm)
    ) {
        return 'cn';
    }
    return null;
}

function detectSystemLanguage() {
    // 1. 環境變數優先檢查
    const envKeys = ['ANTIGRAVITY_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
    for (const k of envKeys) {
        const val = process.env[k];
        const cls = classifyLocaleTag(val);
        if (cls) {
            return { lang: cls, source: `env:${k}`, rawLocale: val };
        }
    }

    // 2. JS/ICU Intl 區域設定檢查 (0ms)
    let intlLocale = '';
    try {
        intlLocale = Intl.DateTimeFormat().resolvedOptions().locale || '';
        const intlCls = classifyLocaleTag(intlLocale);
        if (intlCls) {
            return { lang: intlCls, source: 'intl', rawLocale: intlLocale };
        }
    } catch (_) {}

    // 3. Windows 系統語言 / 登錄檔 / 字碼頁檢查
    if (process.platform === 'win32') {
        const regQueries = [
            { cmd: 'reg query "HKCU\\Control Panel\\Desktop" /v PreferredUILanguages', name: 'reg:PreferredUILanguages' },
            { cmd: 'reg query "HKCU\\Control Panel\\International" /v LocaleName', name: 'reg:LocaleName' }
        ];
        for (const q of regQueries) {
            try {
                const out = child_process.execSync(q.cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
                for (const token of out.split(/[\s,;\\0]+/)) {
                    const cls = classifyLocaleTag(token);
                    if (cls) {
                        return { lang: cls, source: q.name, rawLocale: token };
                    }
                }
            } catch (_) {}
        }
        try {
            const acpOut = child_process.execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage" /v ACP', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true
            });
            const m = acpOut.match(/ACP\s+REG_\w+\s+(\d+)/i);
            if (m) {
                if (m[1] === '950') return { lang: 'tw', source: 'reg:ACP', rawLocale: 'CP950' };
                if (m[1] === '936') return { lang: 'cn', source: 'reg:ACP', rawLocale: 'CP936' };
            }
        } catch (_) {}
    } else if (process.platform === 'darwin') {
        for (const key of ['AppleLanguages', 'AppleLocale']) {
            try {
                const out = child_process.execSync(`defaults read -g ${key}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                for (const token of out.split(/[\s,"()]+/)) {
                    const cls = classifyLocaleTag(token);
                    if (cls) {
                        return { lang: cls, source: `defaults:${key}`, rawLocale: token };
                    }
                }
            } catch (_) {}
        }
    }

    // 4. 非中文作業系統回退預設
    const hasCn = fs.existsSync(path.join(__dirname, 'dicts'));
    const hasTw = fs.existsSync(path.join(__dirname, 'dicts_tw'));
    return {
        lang: hasCn ? 'cn' : (hasTw ? 'tw' : 'cn'),
        source: 'default-fallback',
        rawLocale: intlLocale || 'non-zh'
    };
}

function resolveLanguageConfig() {
    let explicitMode = 'auto';
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i].toLowerCase();
        if (a === '--tw') {
            explicitMode = 'tw';
        } else if (a === '--cn' || a === '--sc') {
            explicitMode = 'cn';
        } else if (a === '--lang' && argv[i + 1]) {
            const v = argv[i + 1].toLowerCase();
            if (v === 'auto') explicitMode = 'auto';
            else {
                const c = classifyLocaleTag(v);
                if (c) explicitMode = c;
            }
            i++;
        } else if (a.startsWith('--lang=')) {
            const v = a.slice(7);
            if (v === 'auto') explicitMode = 'auto';
            else {
                const c = classifyLocaleTag(v);
                if (c) explicitMode = c;
            }
        }
    }

    let info;
    let resolvedLang;
    if (explicitMode === 'tw' || explicitMode === 'cn') {
        resolvedLang = explicitMode;
        info = { lang: resolvedLang, source: 'cli-flag', rawLocale: `--${explicitMode}` };
    } else {
        info = detectSystemLanguage();
        resolvedLang = info.lang;
    }

    const hasCn = fs.existsSync(path.join(__dirname, 'dicts'));
    const hasTw = fs.existsSync(path.join(__dirname, 'dicts_tw'));
    if (resolvedLang === 'cn' && !hasCn && hasTw) {
        resolvedLang = 'tw';
    } else if (resolvedLang === 'tw' && !hasTw && hasCn) {
        resolvedLang = 'cn';
    }

    return {
        selectionMode: explicitMode,
        resolvedLang,
        useTw: resolvedLang === 'tw',
        info
    };
}

const LANG_CONFIG = resolveLanguageConfig();
const LANG_SELECTION_MODE = LANG_CONFIG.selectionMode;
const DETECTED_LANG_INFO = LANG_CONFIG.info;
const USE_TW = LANG_CONFIG.useTw;
const DICTS_FOLDER = USE_TW ? 'dicts_tw' : 'dicts';
function msg(twText, cnText) {
    return USE_TW ? twText : cnText;
}

const IS_AUTO_MODE = process.argv.includes('--auto');
const IS_IF_NEEDED = process.argv.includes('--if-needed');
const IS_QUIET = process.argv.includes('--quiet');
const IS_LAUNCH = process.argv.includes('--launch');
const IS_CHECK_ONLY = process.argv.includes('--check');
const IS_INSTALL_GUARD = process.argv.includes('--install-guard');
const IS_UNINSTALL_GUARD = process.argv.includes('--uninstall-guard');
const IS_NO_GUARD = process.argv.includes('--no-guard');
const IS_TAKEOVER_POST_UPDATE = process.argv.includes('--takeover-post-update');
const IS_CHECK_PATCH_NEEDED = process.argv.includes('--check-patch-needed');

const UPDATER_HOOK_START = "/* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK START --- */";
const UPDATER_HOOK_VERSION_MARKER = "/* TW-GUARD-V2 */";
const UPDATER_HOOK_END = "/* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK END --- */";
const GUARD_DIR_NAME = "antigravity-localization";
const GUARD_TASK_NAME = "Antigravity_AutoGuard";
const LEGACY_GUARD_TASK_NAME = "Antigravity_TW_AutoGuard";

function getGuardDir() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, GUARD_DIR_NAME);
}
const BRAND_TITLE_ALIASES = {
    english: 'english',
    en: 'english',
    default: 'english',
    hidden: 'hidden',
    hide: 'hidden',
    none: 'hidden',
    translated: 'translated',
    chinese: 'translated',
    cn: 'translated',
    zh: 'translated'
};

function getOptionValue(name, defaultValue) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name) {
            return args[i + 1] || defaultValue;
        }
        if (args[i].startsWith(name + '=')) {
            return args[i].slice(name.length + 1);
        }
    }
    return defaultValue;
}

const BRAND_TITLE_MODE = BRAND_TITLE_ALIASES[String(getOptionValue('--brand-title', 'english')).toLowerCase()] || 'english';

if (USE_TW) {
    const logTranslations = {
        "====== 正在安装 Antigravity 中文汉化 ======": "====== 正在安裝 Antigravity 繁體中文漢化 ======",
        "====== 正在卸载中文汉化，恢复官方原版 ======": "====== 正在卸載中文漢化，恢復官方原版 ======",
        "====== 检测到 Antigravity 1.0 架构，正在使用 HTML 注入引擎 ======": "====== 偵測到 Antigravity 1.0 架構，正在使用 HTML 注入引擎 ======",
        "====== 正在恢复 Antigravity 1.0 官方原版 ======": "====== 正在恢復 Antigravity 1.0 官方原版 ======",
        "[1] 检测到 Antigravity 客户端正在运行，正在关闭以解除文件锁...": "[1] 偵測到 Antigravity 用戶端正在執行，正在關閉以解除檔案鎖...",
        "[1] 正在关闭 Antigravity 运行进程以解除文件锁...": "[1] 正在關閉 Antigravity 執行進程以解除檔案鎖...",
        "[备份] 正在创建官方原始包备份: app.asar.bak ...": "[備份] 正在建立官方原始包備份: app.asar.bak ...",
        "[备份] 备份成功！": "[備份] 備份成功！",
        "[备份] 已创建旧版 HTML 备份: ": "[備份] 已建立舊版 HTML 備份: ",
        "[解包] 正在使用 npx 提取 app.asar...": "[解包] 正在提取 app.asar (純 JS ASAR 引擎)...",
        "[解包] 正在提取 app.asar (純 JS ASAR 引擎)...": "[解包] 正在提取 app.asar (純 JS ASAR 引擎)...",
        "[解包] 正在提取 app.asar...": "[解包] 正在提取 app.asar (純 JS ASAR 引擎)...",
        "[修改] 正在向 preload.js 注入汉化代码...": "[修改] 正在向 preload.js 注入漢化程式碼...",
        "[修改] 注入成功！": "[修改] 注入成功！",
        "[修改] 正在向 menu.js 注入菜单汉化代码...": "[修改] 正在向 menu.js 注入選單漢化程式碼...",
        "[修改] 菜单汉化注入成功！": "[修改] 選單漢化注入成功！",
        "[修改] 正在向 tray.js 注入任务栏菜单汉化...": "[修改] 正在向 tray.js 注入系統匣選單漢化...",
        "[修改] 任务栏菜单汉化注入成功！": "[修改] 系統匣選單漢化注入成功！",
        "[修改] 正在向 loadingOverlay.js 注入加载页汉化...": "[修改] 正在向 loadingOverlay.js 注入載入頁漢化...",
        "[修改] 加载页汉化注入成功！": "[修改] 載入頁漢化注入成功！",
        "[修改] 正在向 updater.js 注入更新弹窗汉化...": "[修改] 正在向 updater.js 注入更新彈出視窗漢化...",
        "[修改] 更新弹窗汉化注入成功！": "[修改] 更新彈出視窗漢化注入成功！",
        "[打包] 正在将修改后的内容打包回 app.asar (純 JS ASAR 引擎)...": "[打包] 正在將修改後的內容打包回 app.asar (純 JS ASAR 引擎)...",
        "[打包] 正在将修改后的内容打包回 app.asar...": "[打包] 正在將修改後的內容打包回 app.asar (純 JS ASAR 引擎)...",
        "[√] Antigravity 2.0 汉化部署完成！": "[√] Antigravity 2.0 繁體中文化套用完成！",
        "[√] Antigravity 1.0 汉化部署完成！": "[√] Antigravity 1.0 繁體中文化套用完成！",
        "[!] 未找到备份文件 app.asar.bak，可能尚未安装过汉化或备份被删除。": "[!] 未找到備份檔案 app.asar.bak，可能尚未安裝過繁中化或備份已被刪除。",
        "[还原] 正在用官方备份文件恢复...": "[還原] 正在使用官方備份檔案還原...",
        "[还原] 已重置当前 app.asar 为官方原始备份包，以进行全新注入...": "[還原] 已重設目前 app.asar 為官方原始備份包，以進行全新注入...",
        "[权限] 检测到当前用户对 macOS 应用目录缺少写入权限，正在尝试请求管理员权限 (sudo) 重新运行...": "[權限] 偵測到目前使用者對 macOS 應用程式目錄缺少寫入權限，正在嘗試請求管理員權限 (sudo) 重新執行...",
        "[提示] 当前 app.asar 被锁定（可能是客户端正在运行），将使用当前包进行增量注入。": "[提示] 目前 app.asar 被鎖定（可能是應用程式正在執行），將使用目前包進行增量注入。",
        "[还原] 已恢复 HTML: ": "[還原] 已還原 HTML: ",
        "[还原] 已删除汉化脚本": "[還原] 已刪除中文化腳本",
        "[√] 官方 app.asar 已成功恢复！": "[√] 官方 app.asar 已成功還原！",
        "[√] 校验值已同步，1.0 软件恢复至原始状态。": "[√] 校驗值已同步，1.0 軟體已還原至原始狀態。",
        "[错误] 手动指定的路径不存在:": "[錯誤] 手動指定的路徑不存在:",
        "[错误] 未在资源目录中找到 app.asar:": "[錯誤] 未在資源目錄中找到 app.asar:",
        "[错误] 解压后未能在指定路径找到 preload.js:": "[錯誤] 解壓後未能在指定路徑找到 preload.js:",
        "[错误] 无法定位有效的资源(resources)目录:": "[錯誤] 無法定位有效的資源(resources)目錄:",
        "[错误] 无法定位有效的资源(resources)目录: ": "[錯誤] 無法定位有效的資源(resources)目錄: ",
        "[错误] 解包失败，可能是由于系统未安装 Node.js/npm 或者网络限制。": "[錯誤] 解包失敗，可能是由於檔案損毀或無存取權限。",
        "[错误] 解包失败: ": "[錯誤] 解包失敗: ",
        "[错误] 打包失败。": "[錯誤] 打包失敗。",
        "[错误] 打包失败: ": "[錯誤] 打包失敗: ",
        "[警告] 未能在 menu.js 中找到设定的插入点。": "[警告] 未能在 menu.js 中找到設定的插入點。",
        "[缓存] 已自动清理 ": "[快取] 已自動清理 ",
        " 个应用缓存目录，避免新旧版本字节码冲突。": " 個應用程式快取目錄，避免新舊版本字節碼衝突。",
        "[签名] 检测到 macOS 平台，正在对应用包进行本地 ad-hoc 深度重签名: ": "[簽名] 偵測到 macOS 平台，正在對應用程式包進行本機 ad-hoc 深度重新簽名: ",
        "[签名] 重新签名成功！": "[簽名] 重新簽名成功！",
        "[警告] 重新签名失败。可能会导致应用无法打开。": "[警告] 重新簽名失敗。可能會導致應用程式無法開啟。",
        "[警告] 未能从路径 ": "[警告] 未能從路徑 ",
        " 识别到有效的 .app 路径，跳过重新签名。": " 識別到有效的 .app 路徑，跳過重新簽名。",
        "[探测] 成功自动识别到 Antigravity 安装目录: ": "[偵測] 成功自動識別到 Antigravity 安裝目錄: ",
        "[错误] 未找到默认安装目录，请使用 --install-dir 手动指定您的安装路径！": "[錯誤] 未找到預設安裝目錄，請使用 --install-dir 手動指定您的安裝路徑！",
        "[!] 未找到 1.0 备份文件。": "[!] 未找到 1.0 備份檔案。",
        "详情: ": "詳情: ",
        "[√] 注入成功: ": "[√] 注入成功: ",
        "[跳过] 检测到 --no-kill 参数，跳过关闭 Antigravity 运行进程。": "[跳過] 偵測到 --no-kill 參數，跳過關閉 Antigravity 執行進程。",
        "[启动] 检测到安装前反重力客户端处于开启状态，正在重新启动客户端...": "[啟動] 偵測到安裝前反重力用戶端處於開啟狀態，正在重新啟動用戶端...",
        "[启动] 客户端启动成功！": "[啟動] 用戶端啟動成功！",
        "[警告] 未找到客户端主程序: ": "[警告] 未找到用戶端主程式: ",
        "[警告] 客户端启动失败: ": "[警告] 用戶端啟動失敗: ",
        "[代理] 检测到 proxy_config 配置目录，正在注入代理模块...": "[代理] 偵測到 proxy_config 設定目錄，正在注入代理模組...",
        "[代理] 代理模块注入成功: ": "[代理] 代理模組注入成功: ",
        "[代理] 已清理代理注入文件: ": "[代理] 已清理代理注入檔案: ",
        "[代理警告] 注入文件 ": "[代理警告] 注入檔案 ",
        "[代理警告] 移除代理文件 ": "[代理警告] 移除代理檔案 "
    };
    const translateMsg = (args) => {
        return args.map(arg => {
            if (typeof arg === 'string') {
                let res = arg;
                for (const [k, v] of Object.entries(logTranslations)) {
                    if (res.includes(k)) {
                        res = res.split(k).join(v);
                    }
                }
                return res;
            }
            return arg;
        });
    };
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...args) => origLog(...translateMsg(args));
    console.error = (...args) => origError(...translateMsg(args));
    console.warn = (...args) => origWarn(...translateMsg(args));
}

if (IS_QUIET) {
    const appendGuardLog = (level, args) => {
        try {
            const gDir = getGuardDir();
            fs.mkdirSync(gDir, { recursive: true });
            const logPath = path.join(gDir, 'guard.log');
            try {
                if (fs.existsSync(logPath) && fs.statSync(logPath).size > 256 * 1024) {
                    const raw = fs.readFileSync(logPath);
                    fs.writeFileSync(logPath, raw.subarray(Math.floor(raw.length / 2)));
                }
            } catch (_) {}
            const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
            const ts = new Date().toISOString();
            fs.appendFileSync(logPath, `[${ts}] [${level}] ${msg}\n`, 'utf8');
        } catch (_) {}
    };
    console.log = (...args) => appendGuardLog('INFO', args);
    console.warn = (...args) => appendGuardLog('WARN', args);
    console.error = (...args) => appendGuardLog('ERROR', args);
}

const SIGNATURE_START = "/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */";
const SIGNATURE_END = "/* --- ANTIGRAVITY CHINESE LOCALIZATION END --- */";

function normalizeText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, ' ')
               .trim()
               .replace(/’/g, "'")
               .replace(/‘/g, "'")
               .replace(/“/g, '"')
               .replace(/”/g, '"')
               .replace(/…/g, '...');
}

function getDictLoadPriority(file) {
    const patchMatch = file.match(/^page_v(\d+)_extra\.json$/i);
    if (patchMatch) {
        return [10, parseInt(patchMatch[1], 10), file];
    }
    const versionSettingsMatch = file.match(/^page_settings_v(\d+)\.json$/i);
    if (versionSettingsMatch) {
        return [30, parseInt(versionSettingsMatch[1], 10), file];
    }
    return [20, 0, file];
}

function loadDictionary() {
    const totalMap = {};
    const dictsDir = path.join(__dirname, DICTS_FOLDER);
    if (fs.existsSync(dictsDir)) {
        const files = fs.readdirSync(dictsDir)
            .filter(f => f.endsWith('.json'))
            .sort((a, b) => {
                const pa = getDictLoadPriority(a);
                const pb = getDictLoadPriority(b);
                if (pa[0] !== pb[0]) return pa[0] - pb[0];
                if (pa[1] !== pb[1]) return pa[1] - pb[1];
                return pa[2].localeCompare(pb[2], 'en');
            });
        for (const file of files) {
            try {
                const filePath = path.join(dictsDir, file);
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(fileContent);
                for (const [k, v] of Object.entries(data)) {
                    const normK = normalizeText(k);
                    if (k !== normK && (/^ [^\s]/.test(k) || /[^\s] $/.test(k))) {
                        totalMap[k] = v;
                        if (!(normK in totalMap)) totalMap[normK] = v;
                    } else if (normK) {
                        totalMap[normK] = v;
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    }
    if (BRAND_TITLE_MODE === 'english') {
        delete totalMap[normalizeText('Antigravity')];
    } else if (BRAND_TITLE_MODE === 'hidden') {
        totalMap[normalizeText('Antigravity')] = '';
    }
    return totalMap;
}

function generateJs(preloadedDict) {
    const fullDict = preloadedDict || loadDictionary();
    const dictJson = JSON.stringify(fullDict);

    const jsSource = `${SIGNATURE_START}
(() => {
    // V12.0 终极隔离版：基于容器回溯的物理隔离引擎
    // 逻辑：不再仅仅检查当前标签，而是向上回溯父级，识别“代码/编辑器”禁区
    const USE_TW = ${USE_TW ? "true" : "false"};
    const map = new Map(Object.entries(DICT_PLACEHOLDER));
    const lowerMap = new Map();
    const LOWER_WORDS_EXCLUDE = new Set(['on', 'in', 'to', 'at', 'by', 'for', 'with', 'as', 'system', 'review', 'active', 'browser', 'global', 'including', 'and', 'or', 'file', 'files', 'help', 'app', 'plan', 'search', 'plugin', 'plugins', 'skill', 'skills', 'swarm', 'automation', 'automations', 'rule', 'rules', 'hook', 'hooks', 'workflow', 'workflows', 'bundle', 'bundles', 'mcp', 'sidecar']);
    for (const [k, v] of map.entries()) {
        const lowerK = k.toLowerCase();
        if (LOWER_WORDS_EXCLUDE.has(lowerK) && k !== lowerK) {
            continue;
        }
        lowerMap.set(lowerK, v);
    }
    
    const longEntries = Array.from(map.entries())
        .filter(([k]) => k.length > 15)
        .sort((a, b) => b[0].length - a[0].length);
    const translatedValues = new WeakMap();
    const observedRoots = new WeakSet();
    const hookedFrames = new WeakSet();

    // 轻量级安全隔离：跳过脚本、样式、代码块(pre/code)
    const SKIP_TAGS = ['SCRIPT', 'STYLE', 'PRE', 'CODE'];

    // 代码、富文本输入框及对话内容隔离选择器：排除 Lexical 输入框、用户消息、AI 响应正文、思考内容、代码块、终端及文件路径
    const CODE_ISOLATION_SELECTOR = 'pre, code, .monaco-editor, .cm-editor, .cm-line, [contenteditable="true"], [contenteditable="plaintext-only"], [data-lexical-editor], .terminal, .xterm, .code-line, .code-block, .line-content, [class*="diffEditor"], .token, .hljs, [class*="mtk"], [data-testid="user-input-step"] [data-quotable="true"], [data-testid="user-input-step"] .whitespace-pre-wrap';

    function isCodeOrEditor(node) {
        try {
            if (!node) return false;
            let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!el) return false;
            if (el.isContentEditable) return true;
            const active = document.activeElement;
            if (active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active.getAttribute && active.getAttribute('data-lexical-editor') === 'true')) && (active === el || active.contains(el))) {
                return true;
            }
            while (el) {
                if (el.isContentEditable) return true;
                if (typeof el.closest === 'function' && el.closest(CODE_ISOLATION_SELECTOR)) {
                    return true;
                }
                const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
                el = (root && root.host) ? root.host : null;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function norm(s) {
        if (!s) return '';
        return s.replace(/\\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').trim();
    }

    function smartTranslate(text) {
        if (!text) return null;
        if (map.has(text)) return map.get(text);
        const trimmed = text.trim();
        if (!trimmed) return null;

        const normText = norm(trimmed);
        if (map.has(normText)) return map.get(normText);
        const lowerText = normText.toLowerCase();
        if (lowerMap.has(lowerText)) return lowerMap.get(lowerText);

        // 成對引號與括號剝離 (Enclosure Stripping: "", '', [], (), 【】, “”)
        if (trimmed.length >= 2) {
            const first = trimmed[0];
            const last = trimmed[trimmed.length - 1];
            const pairs = { '"': '"', "'": "'", '[': ']', '(': ')', '{': '}', '“': '”', '‘': '’', '【': '】', '«': '»' };
            if (pairs[first] && pairs[first] === last) {
                const inner = trimmed.substring(1, trimmed.length - 1).trim();
                if (inner) {
                    const innerTrans = smartTranslate(inner);
                    if (innerTrans) {
                        return first + innerTrans + last;
                    }
                }
            }
        }

        // 快捷鍵檢測：例如 "Open File (Ctrl+O)"
        const parenIdx = trimmed.lastIndexOf('(');
        if (parenIdx > 0 && trimmed.endsWith(')')) {
            const prefix = trimmed.substring(0, parenIdx).trim();
            const parenContent = trimmed.substring(parenIdx + 1, trimmed.length - 1);
            if (/^(?:Ctrl|Cmd|Alt|Shift|Meta|Enter|Return|Esc|Escape|Space|Tab|Backspace|Delete|F\\d{1,2}|[A-Z0-9\\+\-\= ])+$/i.test(parenContent) && !/\b(?:to|the|and|or|seconds?|optional|default|tell|run|step|for)\b/i.test(parenContent) && (parenContent.includes('+') || parenContent.length <= 10)) {
                const baseTrans = smartTranslate(prefix);
                if (baseTrans) return baseTrans + " (" + parenContent + ")";
            }
        }

        // 標點符號檢測（純字串掃描，零正則風險）：例如 "Save As...", "Settings:", "Delete?", "Next >", "→ Proceed"
        const prefixChars = ' >→•-*#';
        const suffixChars = ' :：?？!！.…>→-';
        let pStart = 0;
        let pEnd = trimmed.length;
        while (pStart < pEnd && prefixChars.indexOf(trimmed[pStart]) !== -1) pStart++;
        while (pEnd > pStart && suffixChars.indexOf(trimmed[pEnd - 1]) !== -1) pEnd--;

        if (pStart > 0 || pEnd < trimmed.length) {
            const core = trimmed.substring(pStart, pEnd).trim();
            if (core && core !== trimmed) {
                const coreTrans = smartTranslate(core);
                if (coreTrans) {
                    return trimmed.substring(0, pStart) + coreTrans + trimmed.substring(pEnd);
                }
            }
        }

        // 動態操作語句正則匹配
        if (/^Step (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i.test(normText)) {
            return normText.replace(/^Step (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i, (m, a, b, rest) => (USE_TW ? "步驟 " : "步骤 ") + a + " / " + b + rest);
        }
        if (/^Step (\\d+):?\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Step (\\d+):?\\s*(.+)$/i, (m, num, desc) => (USE_TW ? "步驟 " : "步骤 ") + num + "：" + desc);
        }
        if (/^Subtask (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i.test(normText)) {
            return normText.replace(/^Subtask (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i, (m, a, b, rest) => (USE_TW ? "子任務 " : "子任务 ") + a + " / " + b + rest);
        }
        if (/^Subtask (\\d+):?\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Subtask (\\d+):?\\s*(.+)$/i, (m, num, desc) => (USE_TW ? "子任務 " : "子任务 ") + num + "：" + desc);
        }
        if (/^Phase (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i.test(normText)) {
            return normText.replace(/^Phase (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i, (m, a, b, rest) => (USE_TW ? "階段 " : "阶段 ") + a + " / " + b + rest);
        }
        if (/^Phase (\\d+):?\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Phase (\\d+):?\\s*(.+)$/i, (m, num, desc) => (USE_TW ? "階段 " : "阶段 ") + num + "：" + desc);
        }
        if (/^Task (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i.test(normText)) {
            return normText.replace(/^Task (\\d+)\\s*(?:of|\\/)\\s*(\\d+)(.*)$/i, (m, a, b, rest) => (USE_TW ? "任務 " : "任务 ") + a + " / " + b + rest);
        }
        if (/^Task (\\d+):?\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Task (\\d+):?\\s*(.+)$/i, (m, num, desc) => (USE_TW ? "任務 " : "任务 ") + num + "：" + desc);
        }
        if (/^Checkpoint #?(\\d+)(.*)$/i.test(normText)) {
            return normText.replace(/^Checkpoint #?(\\d+)(.*)$/i, (m, num, rest) => {
                let restZh = rest;
                restZh = restZh.replace(/\\(Steps (\\d+)[–-](\\d+)\\)/gi, (sm, s1, s2) => USE_TW ? ("（步驟 " + s1 + "–" + s2 + "）") : ("（步骤 " + s1 + "–" + s2 + "）"));
                restZh = restZh.replace(/\\(Intent Only\\)/gi, USE_TW ? "（僅限意圖）" : "（仅限意向）");
                return (USE_TW ? "檢查點 #" : "检查点 #") + num + restZh;
            });
        }
        if (/^Command (exited|finished|completed|failed) with (?:exit )?code (\\d+)$/i.test(normText)) {
            return normText.replace(/^Command (exited|finished|completed|failed) with (?:exit )?code (\\d+)$/i, (m, verb, code) => {
                const vZh = /^failed/i.test(verb) ? (USE_TW ? "執行失敗" : "运行失败") : (USE_TW ? "已完成" : "已完成");
                return USE_TW ? ("指令" + vZh + "，結束碼為 " + code) : ("命令" + vZh + "，退出代码为 " + code);
            });
        }
        if (/^Process finished with exit code (\\d+)$/i.test(normText)) {
            return normText.replace(/^Process finished with exit code (\\d+)$/i, (m, code) => {
                return USE_TW ? ("行程已結束，結束碼為 " + code) : ("进程已结束，退出代码为 " + code);
            });
        }
        if (/^Command failed with error:?\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Command failed with error:?\\s*(.+)$/i, (m, err) => {
                return USE_TW ? ("指令執行失敗，錯誤訊息：" + err) : ("命令运行失败，错误信息：" + err);
            });
        }
        if (/^Command timed out after (\\d+)\\s*(s|sec|seconds?)?$/i.test(normText)) {
            return normText.replace(/^Command timed out after (\\d+)\\s*(s|sec|seconds?)?$/i, (m, num) => {
                return USE_TW ? ("指令在 " + num + " 秒後逾時") : ("命令在 " + num + " 秒后超时");
            });
        }
        if (/^(Thought|Thinking|Worked) for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Thought|Thinking|Worked) for\\s+(.+)$/i, (match, verb, dur) => {
                const vZh = /^Thought/i.test(verb) ? "已思考 " : (/^Thinking/i.test(verb) ? "正在思考 " : "已工作 ");
                const dZh = dur.trim().replace(/(\\d+)\\s*h(?:ours?|r)?/gi, USE_TW ? "$1 小時" : "$1 小时").replace(/(\\d+)\\s*m(?:inutes?|in)?/gi, USE_TW ? "$1 分鐘" : "$1 分钟").replace(/(\\d+)\\s*s(?:econds?|ec)?/gi, "$1 秒");
                return vZh + dZh;
            });
        }
        if (/^Waiting for (.+)$/i.test(normText)) {
            return normText.replace(/^Waiting for (.+)$/i, (m, target) => {
                let secMatch = target.match(/\\(up to (\\d+) seconds?\\)/i);
                let secStr = secMatch ? (USE_TW ? ("（最多 " + secMatch[1] + " 秒）") : ("（最多 " + secMatch[1] + " 秒）")) : "";
                let cleanTarget = target.replace(/\\(up to \\d+ seconds?\\)/i, '').trim();
                const targetMap = USE_TW ? {
                    'command completion': '指令執行完成',
                    'command to complete': '指令完成',
                    'command to finish': '指令結束',
                    'command output': '指令輸出',
                    'subagent response': '子代理回應',
                    'subagent completion': '子代理完成',
                    'worker to finish': '工作者處理完成',
                    'user confirmation': '使用者確認',
                    'user input': '使用者輸入',
                    'user approval': '使用者核准',
                    'task completion': '任務完成',
                    'background task': '背景任務'
                } : {
                    'command completion': '命令运行完成',
                    'command to complete': '命令完成',
                    'command to finish': '命令结束',
                    'command output': '命令输出',
                    'subagent response': '子智能体响应',
                    'subagent completion': '子智能体完成',
                    'worker to finish': '工作进程完成',
                    'user confirmation': '用户确认',
                    'user input': '用户输入',
                    'user approval': '用户审批',
                    'task completion': '任务完成',
                    'background task': '后台任务'
                };
                const mapped = targetMap[cleanTarget.toLowerCase()];
                let tZh = mapped ? mapped + (secStr ? " " + secStr : "") : target;
                return (USE_TW ? "正在等待 " : "正在等待 ") + tZh;
            });
        }
        if (/^Output truncated \\((?:showing )?(?:the )?(first|last) (\\d+) lines?\\)$/i.test(normText)) {
            return normText.replace(/^Output truncated \\((?:showing )?(?:the )?(first|last) (\\d+) lines?\\)$/i, (m, pos, num) => {
                const pZh = /^first/i.test(pos) ? "前" : (USE_TW ? "後" : "后");
                return USE_TW ? ("輸出已截斷（顯示" + pZh + " " + num + " 行）") : ("输出已截断（显示" + pZh + " " + num + " 行）");
            });
        }
        if (/^Output truncated \\(([\\d,]+) bytes? total\\)$/i.test(normText)) {
            return normText.replace(/^Output truncated \\(([\\d,]+) bytes? total\\)$/i, (m, bytes) => {
                return USE_TW ? ("輸出已截斷（共 " + bytes + " 位元組）") : ("输出已截断（共 " + bytes + " 字节）");
            });
        }
        if (/^Lines (\\d+)[–-](\\d+) of (\\d+)$/i.test(normText)) {
            return normText.replace(/^Lines (\\d+)[–-](\\d+) of (\\d+)$/i, (m, s1, s2, tot) => {
                return USE_TW ? ("行 " + s1 + "–" + s2 + " / 共 " + tot + " 行") : ("行 " + s1 + "–" + s2 + " / 共 " + tot + " 行");
            });
        }
        if (/^(\\d+) tools? enabled$/i.test(normText)) {
            return normText.replace(/^(\\d+) tools? enabled$/i, (m, num) => {
                return num + (USE_TW ? " 個工具已啟用" : " 个工具已启用");
            });
        }
        if (/^(\\d+)\\s+tools?$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+tools?$/i, (m, num) => {
                return num + (USE_TW ? " 個工具" : " 个工具");
            });
        }
        if (/^Version\\s+([\\d\\.]+)$/i.test(normText)) {
            return normText.replace(/^Version\\s+([\\d\\.]+)$/i, (m, v) => "版本 " + v);
        }
        if (/^Searched for files:?\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Searched for files:?\\s+(.+)$/i, (m, q) => (USE_TW ? "已搜尋檔案：" : "已搜索文件：") + q);
        }
        if (/^Searched for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Searched for\\s+(.+)$/i, (m, q) => (USE_TW ? "已搜尋 " : "已搜索 ") + q);
        }
        if (/^Code search:?\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Code search:?\\s+(.+)$/i, (m, q) => (USE_TW ? "程式碼搜尋：" : "代码搜索：") + q);
        }
        if (/^Internal search:?\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Internal search:?\\s+(.+)$/i, (m, q) => (USE_TW ? "內部搜尋：" : "内部搜索：") + q);
        }
        if (/^(?:Listed|Listing) directory\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Listed|Listing) directory\\s+(.+)$/i, (m, verb, d) => (/^Listing/i.test(verb) ? (USE_TW ? "正在列出目錄 " : "正在列出目录 ") : (USE_TW ? "已列出目錄 " : "已列出目录 ")) + d);
        }
        if (/^Browser task:?\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Browser task:?\\s+(.+)$/i, (m, q) => (USE_TW ? "瀏覽器任務：" : "浏览器任务：") + q);
        }
        if (/^(?:Opened browser|Invoked subagent|Open Subagent|Used MCP tool|Used tool|Generated image|Viewed file|Edited file|Created file|Deleted file|Ran command):?\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Opened browser|Invoked subagent|Open Subagent|Used MCP tool|Used tool|Generated image|Viewed file|Edited file|Created file|Deleted file|Ran command):?\\s+(.+)$/i, (m, act, rest) => {
                const actMap = USE_TW ? {
                    'opened browser': '已開啟瀏覽器：',
                    'invoked subagent': '已呼叫子代理：',
                    'open subagent': '開啟子代理：',
                    'used mcp tool': '已使用 MCP 工具：',
                    'used tool': '已使用工具：',
                    'generated image': '已生成圖片：',
                    'viewed file': '已檢視檔案：',
                    'edited file': '已編輯檔案：',
                    'created file': '已建立檔案：',
                    'deleted file': '已刪除檔案：',
                    'ran command': '已執行指令：'
                } : {
                    'opened browser': '已打开浏览器：',
                    'invoked subagent': '已调用子智能体：',
                    'open subagent': '打开子智能体：',
                    'used mcp tool': '已使用 MCP 工具：',
                    'used tool': '已使用工具：',
                    'generated image': '已生成图片：',
                    'viewed file': '已查看文件：',
                    'edited file': '已编辑文件：',
                    'created file': '已创建文件：',
                    'deleted file': '已删除文件：',
                    'ran command': '已运行命令：'
                };
                return (actMap[act.toLowerCase()] || act + '：') + rest;
            });
        }
        if (/^Running for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Running for\\s+(.+)$/i, (m, dur) => {
                const dZh = dur.trim().replace(/(\\d+)\\s*h(?:ours?|r)?/gi, USE_TW ? "$1 小時" : "$1 小时").replace(/(\\d+)\\s*m(?:inutes?|in)?/gi, USE_TW ? "$1 分鐘" : "$1 分钟").replace(/(\\d+)\\s*s(?:econds?|ec)?/gi, "$1 秒");
                return (USE_TW ? "已執行 " : "已运行 ") + dZh;
            });
        }
        if (/^(\\d+h\\s+\\d+m(?:\\s+\\d+s)?|\\d+m\\s+\\d+s)$/i.test(normText)) {
            return normText.replace(/(\\d+)h/gi, USE_TW ? "$1 小時" : "$1 小时").replace(/(\\d+)m/gi, USE_TW ? "$1 分鐘" : "$1 分钟").replace(/(\\d+)s/gi, "$1 秒");
        }
        if (/^Plan,\\s*(\\d+)\\s+of\\s+(\\d+)\\s+steps?\\s+done$/i.test(normText)) {
            return normText.replace(/^Plan,\\s*(\\d+)\\s+of\\s+(\\d+)\\s+steps?\\s+done$/i, (m, a, b) => (USE_TW ? "計畫，已完成 " : "计划，已完成 ") + a + " / " + b + (USE_TW ? " 個步驟" : " 个步骤"));
        }
        if (/^Show\\s+(\\d+)\\s+earlier steps?$/i.test(normText)) {
            return normText.replace(/^Show\\s+(\\d+)\\s+earlier steps?$/i, (m, n) => (USE_TW ? "顯示前 " : "显示前 ") + n + (USE_TW ? " 個步驟" : " 个步骤"));
        }
        if (/^Filter skills and rules:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Filter skills and rules:\\s*(.+)$/i, (m, flt) => {
                const fMap = USE_TW ? { 'all': '全部', 'skills': '技能', 'rules': '規則', 'workspace': '工作區', 'global': '全域', 'plugin': '外掛' } : { 'all': '全部', 'skills': '技能', 'rules': '规则', 'workspace': '工作区', 'global': '全局', 'plugin': '插件' };
                const fZh = fMap[flt.trim().toLowerCase()] || flt;
                return (USE_TW ? "篩選技能與規則：" : "筛选技能与规则：") + fZh;
            });
        }
        if (/^More actions for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^More actions for\\s+(.+)$/i, (m, name) => (USE_TW ? "「" + name + "」的更多操作" : "“" + name + "”的更多操作"));
        }
        if (/^Toggle\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Toggle\\s+(.+)$/i, (m, name) => (USE_TW ? "切換 " : "切换 ") + name);
        }
        if (/^Open\\s+(.+?)\\s+skill$/i.test(normText)) {
            return normText.replace(/^Open\\s+(.+?)\\s+skill$/i, (m, name) => (USE_TW ? "開啟「" + name + "」技能" : "打开“" + name + "”技能"));
        }
        if (/^Open the\\s+(.+?)\\s+plugin$/i.test(normText)) {
            return normText.replace(/^Open the\\s+(.+?)\\s+plugin$/i, (m, name) => (USE_TW ? "開啟「" + name + "」外掛" : "打开“" + name + "”插件"));
        }
        if (/^Fix with Agent:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Fix with Agent:\\s*(.+)$/i, (m, name) => (USE_TW ? "使用代理修復：" : "使用智能体修复：") + name);
        }
        if (/^Configure\\s+(.+?),\\s*values missing$/i.test(normText)) {
            return normText.replace(/^Configure\\s+(.+?),\\s*values missing$/i, (m, name) => (USE_TW ? "設定 " + name + "（尚缺必填設定值）" : "配置 " + name + "（缺少必填配置项）"));
        }
        if (/^Configure\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Configure\\s+(.+)$/i, (m, name) => (USE_TW ? "設定 " + name : "配置 " + name));
        }
        if (/^Set up\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Set up\\s+(.+)$/i, (m, name) => (USE_TW ? "設定 " + name : "配置 " + name));
        }
        if (/^Review permissions for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Review permissions for\\s+(.+)$/i, (m, name) => (USE_TW ? "檢閱 " + name + " 的權限" : "审查 " + name + " 的权限"));
        }
        if (/^See\\s+(\\d+)\\s+more(?:\\s+([a-z]+))?$/i.test(normText)) {
            return normText.replace(/^See\\s+(\\d+)\\s+more(?:\\s+([a-z]+))?$/i, (m, n, noun) => (USE_TW ? "再檢視 " + n + " 項" : "再查看 " + n + " 项"));
        }
        if (/^See\\s+(more|less)\\s+in\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^See\\s+(more|less)\\s+in\\s+(.+)$/i, (m, dir, shelf) => {
                const sTrans = map.get(shelf) || shelf;
                return /^more/i.test(dir) ? (USE_TW ? "在「" + sTrans + "」中查看更多" : "在“" + sTrans + "”中查看更多") : (USE_TW ? "收起「" + sTrans + "」項目" : "收起“" + sTrans + "”项目");
            });
        }
        if (/^Plugins in\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Plugins in\\s+(.+)$/i, (m, shelf) => {
                const sTrans = map.get(shelf) || shelf;
                return USE_TW ? "「" + sTrans + "」分類中的外掛" : "“" + sTrans + "”分类中的插件";
            });
        }
        if (/^Build with\\s+(.+?)\\s+Plugins$/i.test(normText)) {
            return normText.replace(/^Build with\\s+(.+?)\\s+Plugins$/i, (m, name) => USE_TW ? "「Build with " + name + "」外掛程式" : "“Build with " + name + "”插件");
        }
        if (/^(\\d+)\\s+tools?\\s+disabled$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+tools?\\s+disabled$/i, (m, n) => n + (USE_TW ? " 個工具已停用" : " 个工具已禁用"));
        }
        if (/^([^,]+),\\s*(\\d+)\\s+grants?$/i.test(normText)) {
            return normText.replace(/^([^,]+),\\s*(\\d+)\\s+grants?$/i, (m, name, n) => name + (USE_TW ? "（" + n + " 項授權）" : "（" + n + " 项授权）"));
        }
        if (/^Credentials expire in\\s+(.+?)\\.\\s*Refresh credentials to keep this automation running$/i.test(normText)) {
            return normText.replace(/^Credentials expire in\\s+(.+?)\\.\\s*Refresh credentials to keep this automation running$/i, (m, dur) => USE_TW ? ("憑證將於 " + dur + " 後過期，請重新整理憑證以確保自動化任務持續運行") : ("凭据将在 " + dur + " 后过期，请刷新凭据以保持此自动化运行"));
        }
        if (/^Cancel Questionnaire and Stop the Agent\\s*\\(([^)]+)\\)$/i.test(normText)) {
            return normText.replace(/^Cancel Questionnaire and Stop the Agent\\s*\\(([^)]+)\\)$/i, (m, key) => (USE_TW ? "取消問卷並停止代理 (" : "取消问卷并停止智能体 (") + key + ")");
        }
        if (/^Side question \\(conversation\\s+(\\d+)\\):\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Side question \\(conversation\\s+(\\d+)\\):\\s*(.+)$/i, (m, n, rest) => (USE_TW ? "側邊提問（對話 " : "侧边提问（对话 ") + n + "）：" + rest);
        }
        if (/^Signed in:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Signed in:\\s*(.+)$/i, (m, name) => (USE_TW ? "已登入：" : "已登录：") + name);
        }
        if (/^Sign in to\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Sign in to\\s+(.+)$/i, (m, name) => (USE_TW ? "登入 " : "登录 ") + name);
        }
        if (/^(.+?)\\s+needs you to sign in before it can be used\\.?$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+needs you to sign in before it can be used\\.?$/i, (m, name) => name + (USE_TW ? " 需要您先登入才能使用。" : " 需要您先登录才能使用。"));
        }
        if (/^(Skill|Plugin)\\s+installed:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^(Skill|Plugin)\\s+installed:\\s*(.+)$/i, (m, kind, name) => (/^Skill/i.test(kind) ? (USE_TW ? "已安裝技能：" : "已安装技能：") : (USE_TW ? "已安裝外掛：" : "已安装插件：")) + name);
        }
        if (/^Unnamed skill\\s+(\\d+)$/i.test(normText)) {
            return normText.replace(/^Unnamed skill\\s+(\\d+)$/i, (m, n) => (USE_TW ? "未命名技能 " : "未命名技能 ") + n);
        }
        if (/^Deleted\\s+"(.+?)"\\.?$/i.test(normText)) {
            return normText.replace(/^Deleted\\s+"(.+?)"\\.?$/i, (m, name) => (USE_TW ? "已刪除「" + name + "」。" : "已删除“" + name + "”。"));
        }
        if (/^Failed to delete\\s+"(.+?)"\\.?$/i.test(normText)) {
            return normText.replace(/^Failed to delete\\s+"(.+?)"\\.?$/i, (m, name) => (USE_TW ? "無法刪除「" + name + "」" : "无法删除“" + name + "”"));
        }
        if (/^Search for\\s+"(.+?)"\\s+in the Marketplace$/i.test(normText)) {
            return normText.replace(/^Search for\\s+"(.+?)"\\s+in the Marketplace$/i, (m, q) => (USE_TW ? "在市集中搜尋「" + q + "」" : "在市场中搜索“" + q + "”"));
        }
        if (/^No (plugins|MCP servers|apps|skills|rules|automations) found for\\s+"(.+?)"\\.?$/i.test(normText)) {
            return normText.replace(/^No (plugins|MCP servers|apps|skills|rules|automations) found for\\s+"(.+?)"\\.?$/i, (m, kind, q) => (USE_TW ? "找不到符合「" + q + "」的項目。" : "找不到与“" + q + "”匹配的项目。"));
        }
        if (/^When toggled on,\\s*(.+?)\\s+collects usage data to help Google enhance performance and features\\.$/i.test(normText)) {
            return normText.replace(/^When toggled on,\\s*(.+?)\\s+collects usage data to help Google enhance performance and features\\.$/i, (m, app) => USE_TW ? ("開啟後，" + app + " 會收集使用資料以協助 Google 提升效能與功能體驗。") : ("开启后，" + app + " 会收集使用数据以帮助 Google 提升性能和功能体验。"));
        }
        if (/^Receive product updates, tips, and promotions from Google\\s+(.+?)\\s+via email\\.$/i.test(normText)) {
            return normText.replace(/^Receive product updates, tips, and promotions from Google\\s+(.+?)\\s+via email\\.$/i, (m, app) => USE_TW ? ("透過電子郵件接收來自 Google " + app + " 的產品更新、使用技巧與優惠資訊。") : ("通过电子邮件接收来自 Google " + app + " 的产品更新、使用技巧与促销信息。"));
        }
        if (/^When toggled on,\\s*(.+?)\\s+will use your AI credits to fulfill model requests once you're out of model quota\\.\\s*(.+?)\\s+will always use your model quota first before using AI credits\\.$/i.test(normText)) {
            return normText.replace(/^When toggled on,\\s*(.+?)\\s+will use your AI credits to fulfill model requests once you're out of model quota\\.\\s*(.+?)\\s+will always use your model quota first before using AI credits\\.$/i, (m, app) => USE_TW ? ("開啟後，當您的模型配額用盡時，" + app + " 會改用您的 AI 點數來完成模型請求（系統一律會優先使用模型配額，不足時才扣抵 AI 點數）。") : ("开启后，当您的模型配额用尽时，" + app + " 将改用您的 AI 点数来完成模型请求（系统始终优先使用模型配额）。"));
        }
        if (/^Available AI credits:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Available AI credits:\\s*(.+)$/i, (m, n) => (USE_TW ? "可用 AI 點數：" : "可用 AI 点数：") + n);
        }
        if (/^Your plan:\\s*(.*)$/i.test(normText)) {
            return normText.replace(/^Your plan:\\s*(.*)$/i, (m, p) => (USE_TW ? "目前方案：" : "当前方案：") + p);
        }
        if (/^(.+?)\\s+Sends immediately$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+Sends immediately$/i, (m, k) => k + (USE_TW ? " 立即傳送" : " 立即发送"));
        }
        if (/^(.+?)\\s+Queues after the turn$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+Queues after the turn$/i, (m, k) => k + (USE_TW ? " 於本輪結束後排隊傳送" : " 在本轮结束后排队发送"));
        }
        if (/^Manage\\s+(.+?)\\s+app settings\\.$/i.test(normText)) {
            return normText.replace(/^Manage\\s+(.+?)\\s+app settings\\.$/i, (m, app) => (USE_TW ? "管理 " : "管理 ") + app + (USE_TW ? " 應用程式設定。" : " 应用设置。"));
        }
        if (/^Deleted cookies for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Deleted cookies for\\s+(.+)$/i, (m, s) => (USE_TW ? "已刪除 " : "已删除 ") + s + " 的 Cookie");
        }
        if (/^Delete cookies for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Delete cookies for\\s+(.+)$/i, (m, s) => (USE_TW ? "刪除 " : "删除 ") + s + " 的 Cookie");
        }
        if (/^(\\d+)\\s+cookies?$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+cookies?$/i, (m, n) => n + (USE_TW ? " 個 Cookie" : " 个 Cookie"));
        }
        if (/^Reset\\s+(\\d+)\\s+overrides?$/i.test(normText)) {
            return normText.replace(/^Reset\\s+(\\d+)\\s+overrides?$/i, (m, n) => (USE_TW ? "重設 " : "重置 ") + n + (USE_TW ? " 項覆寫設定" : " 项覆盖配置"));
        }
        if (/^Recording shortcut for\\s+(.+?)\\.\\s*Press keys to bind,\\s*Enter to save,\\s*Escape to cancel\\.$/i.test(normText)) {
            return normText.replace(/^Recording shortcut for\\s+(.+?)\\.\\s*Press keys to bind,\\s*Enter to save,\\s*Escape to cancel\\.$/i, (m, name) => USE_TW ? ("正在為「" + name + "」錄製快捷鍵。請按下組合鍵綁定，按 Enter 儲存，按 Escape 取消。") : ("正在为“" + name + "”录制快捷键。请按下组合键绑定，按 Enter 保存，按 Escape 取消。"));
        }
        if (/^Conflicts with\\s+"(.+?)"\\s*\\(press Enter to replace\\)$/i.test(normText)) {
            return normText.replace(/^Conflicts with\\s+"(.+?)"\\s*\\(press Enter to replace\\)$/i, (m, name) => USE_TW ? ("與「" + name + "」衝突（按 Enter 取代）") : ("与“" + name + "”冲突（按 Enter 替换）"));
        }
        if (/^Conflicts with\\s+"(.+?)"(?:\\s*\\((.+?)\\))?$/i.test(normText)) {
            return normText.replace(/^Conflicts with\\s+"(.+?)"(?:\\s*\\((.+?)\\))?$/i, (m, name, extra) => (USE_TW ? "與「" + name + "」衝突" : "与“" + name + "”冲突") + (extra ? "（" + extra + "）" : ""));
        }
        if (/^Conflict:\\s*also assigned to\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Conflict:\\s*also assigned to\\s+(.+)$/i, (m, name) => USE_TW ? ("衝突：亦同時指派給「" + name + "」") : ("冲突：也同时分配给“" + name + "”"));
        }
        if (/^(Remove shortcut|Shortcut)\\s+(.+?)\\s+for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Remove shortcut|Shortcut)\\s+(.+?)\\s+for\\s+(.+)$/i, (m, act, key, name) => (/^Remove/i.test(act) ? (USE_TW ? "移除「" + name + "」的快捷鍵 " : "移除“" + name + "”的快捷键 ") : (USE_TW ? "「" + name + "」的快捷鍵 " : "“" + name + "”的快捷键 ")) + key);
        }
        if (/^Add shortcut for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Add shortcut for\\s+(.+)$/i, (m, name) => USE_TW ? ("為「" + name + "」新增快捷鍵") : ("为“" + name + "”添加快捷键"));
        }
        if (/^Reset\\s+(.+?)\\s+to default$/i.test(normText)) {
            return normText.replace(/^Reset\\s+(.+?)\\s+to default$/i, (m, name) => USE_TW ? ("將「" + name + "」重設為預設值") : ("将“" + name + "”重置为默认值"));
        }
        if (/^Choose\\s+(Antigravity|Jetski)'s Voice$/i.test(normText)) {
            return normText.replace(/^Choose\\s+(Antigravity|Jetski)'s Voice$/i, (m, name) => (USE_TW ? "選擇 " : "选择 ") + name + (USE_TW ? " 的語音" : " 的语音"));
        }
        if (/^Allowed in\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^Allowed in\\s+(.+)$/i, (m, p) => (USE_TW ? "已在「" + p + "」中允許" : "已在“" + p + "”中允许"));
        }
        if (/^Revoke:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Revoke:\\s*(.+)$/i, (m, x) => (USE_TW ? "撤銷權限：" : "撤销权限：") + x);
        }
        if (/^Revoke all:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Revoke all:\\s*(.+)$/i, (m, x) => (USE_TW ? "全部撤銷：" : "全部撤销：") + x);
        }
        if (/^All\\s+(\\d+)\\s+will be revoked\\.\\s*The plugin will ask before doing this again\\.$/i.test(normText)) {
            return normText.replace(/^All\\s+(\\d+)\\s+will be revoked\\.\\s*The plugin will ask before doing this again\\.$/i, (m, n) => USE_TW ? ("將撤銷全部 " + n + " 項權限。此外掛下次執行相關操作前會再次詢問您。") : ("将撤销全部 " + n + " 项权限。此插件下次执行相关操作前会再次询问您。"));
        }
        if (/^Inherits your Global Permissions when working\\s+(.+)\\.$/i.test(normText)) {
            return normText.replace(/^Inherits your Global Permissions when working\\s+(.+)\\.$/i, (m, x) => USE_TW ? ("在 " + x + " 作業時繼承您的全域權限設定。") : ("在 " + x + " 工作时继承您的全局权限设置。"));
        }
        if (/^Sign-ins to\\s+(.+?)\\s+are kept in the cloud with your account\\.$/i.test(normText)) {
            return normText.replace(/^Sign-ins to\\s+(.+?)\\s+are kept in the cloud with your account\\.$/i, (m, p) => p + (USE_TW ? " 的登入狀態會隨您的帳號安全保存於雲端。" : " 的登录状态会随您的账号安全保存在云端。"));
        }
        if (/^(\\d+)\\s+accounts?$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+accounts?$/i, (m, n) => n + (USE_TW ? " 個帳號" : " 个账号"));
        }
        if (/^(New secret|Secret)\\s+for\\s+(?:a new\\s+)?(.+?)(?:\\s+account)?$/i.test(normText)) {
            return normText.replace(/^(New secret|Secret)\\s+for\\s+(?:a new\\s+)?(.+?)(?:\\s+account)?$/i, (m, kind, p) => (/^New/i.test(kind) ? (USE_TW ? "輸入新的 " : "输入新的 ") : (USE_TW ? "輸入 " : "输入 ")) + p + (USE_TW ? " 金鑰／密鑰" : " 密钥"));
        }
        if (/^Make\\s+(.+?)\\s+the default\\s+(.+?)\\s+account$/i.test(normText)) {
            return normText.replace(/^Make\\s+(.+?)\\s+the default\\s+(.+?)\\s+account$/i, (m, id, p) => USE_TW ? ("將 " + id + " 設為預設 " + p + " 帳號") : ("将 " + id + " 设为默认 " + p + " 账号"));
        }
        if (/^(Add label for|Rename|Label for|Authorization code for|Auth code for)\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Add label for|Rename|Label for|Authorization code for|Auth code for)\\s+(.+)$/i, (m, act, rest) => {
                const aMap = USE_TW ? {
                    'add label for': '為此項目新增標籤：',
                    'rename': '重新命名：',
                    'label for': '標籤：',
                    'authorization code for': '授權驗證碼：',
                    'auth code for': '驗證碼：'
                } : {
                    'add label for': '为此项添加标签：',
                    'rename': '重命名：',
                    'label for': '标签：',
                    'authorization code for': '授权验证码：',
                    'auth code for': '验证码：'
                };
                return (aMap[act.toLowerCase()] || act + '：') + rest;
            });
        }
        if (/^Sign in to\\s+(.+?)\\s+remotely$/i.test(normText)) {
            return normText.replace(/^Sign in to\\s+(.+?)\\s+remotely$/i, (m, a) => (USE_TW ? "遠端登入 " : "远程登录 ") + a);
        }
        if (/^(Enable|Disable)\\s+(.+?)\\s+tool for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Enable|Disable)\\s+(.+?)\\s+tool for\\s+(.+)$/i, (m, en, tool, srv) => (/^Enable/i.test(en) ? (USE_TW ? "為 " + srv + " 啟用工具 " : "为 " + srv + " 启用工具 ") : (USE_TW ? "停用 " + srv + " 的工具 " : "禁用 " + srv + " 的工具 ")) + tool);
        }
        if (/^Are you sure you want to delete the hook\\s+"(.+?)"\\?$/i.test(normText)) {
            return normText.replace(/^Are you sure you want to delete the hook\\s+"(.+?)"\\?$/i, (m, h) => USE_TW ? ("確定要刪除掛鉤「" + h + "」嗎？") : ("确定要删除挂钩“" + h + "”吗？"));
        }
        if (/^Please fill in all required fields:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Please fill in all required fields:\\s*(.+)$/i, (m, f) => (USE_TW ? "請填寫所有必填欄位：" : "请填写所有必填字段：") + f);
        }
        if (/^(?:Agent settings and permissions|Settings) for conversations outside of\\s+(.+)\\.$/i.test(normText)) {
            return USE_TW ? "未歸入專案之獨立對話的代理設定與權限。" : "未归入项目之独立对话的智能体设置与权限。";
        }
        if (/^Manage\\s+(.+?)\\s+(resources|folders)(?:,\\s*agent settings,\\s*and permissions|\\s+and settings)\\.$/i.test(normText)) {
            return normText.replace(/^Manage\\s+(.+?)\\s+(resources|folders)(?:,\\s*agent settings,\\s*and permissions|\\s+and settings)\\.$/i, (m, p, kind) => USE_TW ? ("管理此專案的" + (/resources/i.test(kind) ? "資源" : "資料夾") + "、代理設定與權限。") : ("管理此项目的" + (/resources/i.test(kind) ? "资源" : "文件夹") + "、智能体设置与权限。"));
        }
        if (/^This\\s+(.+?)\\s+overrides your global permission settings\\.$/i.test(normText)) {
            return USE_TW ? "此項目的設定會覆寫您的全域權限設定。" : "此项目的设置将覆盖您的全局权限设置。";
        }
        if (/^Agent permissions preset:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Agent permissions preset:\\s*(.+)$/i, (m, rest) => (USE_TW ? "代理權限預設組：" : "智能体权限预设：") + rest);
        }
        if (/^Low contrast ratio\\s*\\((.+?)\\)\\.\\s*Text may be hard to read\\.$/i.test(normText)) {
            return normText.replace(/^Low contrast ratio\\s*\\((.+?)\\)\\.\\s*Text may be hard to read\\.$/i, (m, r) => USE_TW ? ("對比度過低 (" + r + ")，文字可能不易閱讀。") : ("对比度过低 (" + r + ")，文本可能难以阅读。"));
        }
        if (/^(Adding|Details for)\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^(Adding|Details for)\\s+(.+)$/i, (m, act, name) => (/^Adding/i.test(act) ? (USE_TW ? "正在新增 " : "正在添加 ") : (USE_TW ? "詳細資訊：" : "详细信息：")) + name);
        }
        if (/^Handler #(\\d+)$/i.test(normText)) {
            return normText.replace(/^Handler #(\\d+)$/i, (m, n) => (USE_TW ? "處理常式 #" : "处理程序 #") + n);
        }
        if (/^Project ID:\\s*(.*)$/i.test(normText)) {
            return normText.replace(/^Project ID:\\s*(.*)$/i, (m, p) => (USE_TW ? "專案 ID：" : "项目 ID：") + p);
        }
        if (/^(.+?)\\s+On empty prompt, sends next in queue$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+On empty prompt, sends next in queue$/i, (m, k) => k + (USE_TW ? " 輸入框為空時傳送佇列中的下一則訊息" : " 输入框为空时发送队列中的下一条消息"));
        }
        if (/^(.+?)\\s+\\(experimental\\)$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+\\(experimental\\)$/i, (m, p) => {
                const pZh = map.get(p) || lowerMap.get(p.toLowerCase()) || p;
                return pZh + (USE_TW ? "（實驗性）" : "（实验性）");
            });
        }
        if (/^(.+?)\\s+\\(disabled by admin\\)$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+\\(disabled by admin\\)$/i, (m, p) => {
                const pZh = map.get(p) || lowerMap.get(p.toLowerCase()) || p;
                return pZh + (USE_TW ? "（已由管理員停用）" : "（已由管理员禁用）");
            });
        }
        if (/^(.+?)\\s+(?:need|needs) the terminal sandbox, which isn't available on this host\\.$/i.test(normText)) {
            return normText.replace(/^(.+?)\\s+(?:need|needs) the terminal sandbox, which isn't available on this host\\.$/i, (m, presets) => {
                const pZh = presets
                    .replace(/\\bRequest Review\\b/gi, USE_TW ? "要求審查" : "请求审查")
                    .replace(/\\bDefault\\b/gi, USE_TW ? "預設 (Default)" : "默认 (Default)")
                    .replace(/\\bAuto\\b/gi, USE_TW ? "自動 (Auto)" : "自动 (Auto)")
                    .replace(/\\bTurbo\\b/gi, USE_TW ? "極速模式 (Turbo)" : "极速模式 (Turbo)")
                    .replace(/\\s+and\\s+/gi, USE_TW ? " 與 " : " 与 ");
                return pZh + (USE_TW ? " 需要終端機沙箱，但目前主機環境不支援。" : " 需要终端沙箱，但当前主机环境不支持。");
            });
        }
        if (/^This deletes\\s+(.+?)\\s*\\((.+?)\\)\\s+from your machine\\.\\s*You can't undo this\\.$/i.test(normText)) {
            return normText.replace(/^This deletes\\s+(.+?)\\s*\\((.+?)\\)\\s+from your machine\\.\\s*You can't undo this\\.$/i, (m, item, sz) => {
                const itemZh = item.replace(/(\\d+)\\s+call recordings?/i, (im, n) => n + (USE_TW ? " 則通話錄音" : " 条通话录音"));
                return USE_TW ? ("這將從您的電腦刪除 " + itemZh + "（" + sz + "），此操作無法復原。") : ("这将从您的电脑删除 " + itemZh + "（" + sz + "），此操作无法撤销。");
            });
        }
        if (/^Failed to delete recordings:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Failed to delete recordings:\\s*(.+)$/i, (m, err) => (USE_TW ? "刪除錄音紀錄失敗：" : "删除录音记录失败：") + err);
        }
        if (/^Failed to save cloud permission settings:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Failed to save cloud permission settings:\\s*(.+)$/i, (m, err) => (USE_TW ? "儲存雲端權限設定失敗：" : "保存云端权限设置失败：") + err);
        }
        if (/^Failed to write MCP config:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Failed to write MCP config:\\s*(.+)$/i, (m, err) => (USE_TW ? "寫入 MCP 設定失敗：" : "写入 MCP 配置失败：") + err);
        }
        if (/^Failed to save configuration:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Failed to save configuration:\\s*(.+)$/i, (m, err) => (USE_TW ? "儲存設定失敗：" : "保存配置失败：") + err);
        }
        if (/^Error (signing in to MCP server|starting sign-in|submitting auth code|disconnecting MCP server|installing MCP server|toggling MCP server|deleting MCP server|restarting MCP server|toggling tool|refreshing MCP servers):\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Error (signing in to MCP server|starting sign-in|submitting auth code|disconnecting MCP server|installing MCP server|toggling MCP server|deleting MCP server|restarting MCP server|toggling tool|refreshing MCP servers):\\s*(.+)$/i, (m, act, err) => {
                const eMap = USE_TW ? {
                    'signing in to mcp server': '登入 MCP 伺服器時發生錯誤：',
                    'starting sign-in': '啟動登入流程時發生錯誤：',
                    'submitting auth code': '提交驗證碼時發生錯誤：',
                    'disconnecting mcp server': '中斷 MCP 伺服器連線時發生錯誤：',
                    'installing mcp server': '安裝 MCP 伺服器時發生錯誤：',
                    'toggling mcp server': '切換 MCP 伺服器狀態時發生錯誤：',
                    'deleting mcp server': '刪除 MCP 伺服器時發生錯誤：',
                    'restarting mcp server': '重新啟動 MCP 伺服器時發生錯誤：',
                    'toggling tool': '切換工具狀態時發生錯誤：',
                    'refreshing mcp servers': '重新整理 MCP 伺服器清單時發生錯誤：'
                } : {
                    'signing in to mcp server': '登录 MCP 服务器时出错：',
                    'starting sign-in': '启动登录流程时出错：',
                    'submitting auth code': '提交授权码时出错：',
                    'disconnecting mcp server': '断开 MCP 服务器连接时出错：',
                    'installing mcp server': '安装 MCP 服务器时出错：',
                    'toggling mcp server': '切换 MCP 服务器状态时出错：',
                    'deleting mcp server': '删除 MCP 服务器时出错：',
                    'restarting mcp server': '重启 MCP 服务器时出错：',
                    'toggling tool': '切换工具状态时出错：',
                    'refreshing mcp servers': '刷新 MCP 服务器列表时出错：'
                };
                return (eMap[act.toLowerCase()] || (act + '：')) + err;
            });
        }
        if (/^Added MCP server "(.+?)", but it failed to start:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Added MCP server "(.+?)", but it failed to start:\\s*(.+)$/i, (m, n, r) => USE_TW ? ("已新增 MCP 伺服器「" + n + "」，但啟動失敗：" + r) : ("已添加 MCP 服务器“" + n + "”，但启动失败：" + r));
        }
        if (/^MCP server "(.+?)" (does not have a remote configuration|does not have a supported configuration|does not have any installation commands|not found in the store)\\.$/i.test(normText)) {
            return normText.replace(/^MCP server "(.+?)" (does not have a remote configuration|does not have a supported configuration|does not have any installation commands|not found in the store)\\.$/i, (m, n, msg) => {
                const mMap = USE_TW ? {
                    'does not have a remote configuration': '沒有遠端設定。',
                    'does not have a supported configuration': '沒有受支援的設定格式。',
                    'does not have any installation commands': '沒有任何安裝指令。',
                    'not found in the store': '在商店中找不到。'
                } : {
                    'does not have a remote configuration': '没有远程配置。',
                    'does not have a supported configuration': '没有受支持的配置格式。',
                    'does not have any installation commands': '没有任何安装命令。',
                    'not found in the store': '在商店中未找到。'
                };
                return (USE_TW ? ("MCP 伺服器「" + n + "」") : ("MCP 服务器“" + n + "”")) + (mMap[msg.toLowerCase()] || msg);
            });
        }
        if (/^No installation command found for MCP server "(.+?)"\\.$/i.test(normText)) {
            return normText.replace(/^No installation command found for MCP server "(.+?)"\\.$/i, (m, n) => USE_TW ? ("找不到 MCP 伺服器「" + n + "」的安裝指令。") : ("未找到 MCP 服务器“" + n + "”的安装命令。"));
        }
        if (/^(\\d+)\\s+(demoted|excluded)$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+(demoted|excluded)$/i, (m, n, k) => n + (USE_TW ? (/demoted/i.test(k) ? " 項已降級" : " 項已排除") : (/demoted/i.test(k) ? " 项已降级" : " 项已排除")));
        }
        if (/^(\\d+)\\s+rules? exceeded the rules budget and (?:was|were) demoted from full inline content to a file-path pointer\\.$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+rules? exceeded the rules budget and (?:was|were) demoted from full inline content to a file-path pointer\\.$/i, (m, n) => USE_TW ? ("有 " + n + " 條規則超出規則預算，已從完整內嵌內容降級為檔案路徑指標。") : ("有 " + n + " 条规则超出规则预算，已从完整内联内容降级为文件路径指针。"));
        }
        if (/^(\\d+)\\s+items? in (.+?) exceeded the customization budget and (?:was|were) excluded from context\\.$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+items? in (.+?) exceeded the customization budget and (?:was|were) excluded from context\\.$/i, (m, n, lbl) => USE_TW ? ("「" + (map.get(lbl) || lbl) + "」中有 " + n + " 個項目超出自訂項預算，已從上下文中排除。") : ("“" + (map.get(lbl) || lbl) + "”中有 " + n + " 个项目超出自定义项预算，已从上下文中排除。"));
        }
        if (/^(\\d+)\\s+archived conversations?$/i.test(normText)) {
            return normText.replace(/^(\\d+)\\s+archived conversations?$/i, (m, n) => n + (USE_TW ? " 個已封存的對話" : " 个已归档会话"));
        }
        if (/^Select Sidebar Item (\\d+)$/i.test(normText)) {
            return normText.replace(/^Select Sidebar Item (\\d+)$/i, (m, n) => (USE_TW ? "選取側邊欄項目 " : "选择侧边栏项目 ") + n);
        }
        if (/^More for\\s+(.+)$/i.test(normText)) {
            return normText.replace(/^More for\\s+(.+)$/i, (m, a) => (USE_TW ? "「" + a + "」的更多選項" : "“" + a + "”的更多选项"));
        }
        if (/^Couldn't load apps:\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Couldn't load apps:\\s*(.+)$/i, (m, err) => (USE_TW ? "無法載入應用程式：" : "无法加载应用：") + err);
        }
        if (/^Couldn't disconnect (.+?):\\s*(.+)$/i.test(normText)) {
            return normText.replace(/^Couldn't disconnect (.+?):\\s*(.+)$/i, (m, target, err) => (USE_TW ? "無法中斷與 " + target + " 的連線：" : "无法断开与 " + target + " 的连接：") + err);
        }
        if (/^Exited with code (\\d+)\\.$/i.test(normText)) {
            return normText.replace(/^Exited with code (\\d+)\\.$/i, (m, c) => (USE_TW ? "已結束，結束碼為 " : "已退出，退出代码为 ") + c + "。");
        }
        if (/^No sites match "(.+?)"$/i.test(normText)) {
            return normText.replace(/^No sites match "(.+?)"$/i, (m, q) => USE_TW ? ("找不到符合「" + q + "」的網站") : ("找不到与“" + q + "”匹配的网站"));
        }

        return null;
    }

    const translateWithShortcut = smartTranslate;

    function translateElementAttrs(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
        const tag = el.tagName.toUpperCase();
        if (SKIP_TAGS.includes(tag)) return;
        for (const attr of ['placeholder', 'title', 'aria-label', 'aria-valuetext', 'alt']) {
            const v = el.getAttribute(attr);
            if (!v) continue;
            const t = norm(v);
            let nextVal = null;
            const shortcutTrans = translateWithShortcut(t);
            if (shortcutTrans) nextVal = shortcutTrans;
            else if (map.has(t)) nextVal = map.get(t);
            else if (lowerMap.has(t.toLowerCase())) nextVal = lowerMap.get(t.toLowerCase());
            else if (/^Show\\s+(\\d+)\\s+more/i.test(t)) {
                nextVal = t.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (m, num, p2, type) => {
                    if (type) {
                        if (/result/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個結果...") : ("显示另外 " + num + " 个结果...");
                        if (/command/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個指令...") : ("显示另外 " + num + " 个命令...");
                        if (/item/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個項目...") : ("显示另外 " + num + " 个项目...");
                        if (/option/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個選項...") : ("显示另外 " + num + " 个选项...");
                    }
                    return USE_TW ? ("顯示另外 " + num + " 個...") : ("显示另外 " + num + " 个...");
                });
            } else if (/^Show\\s+(\\d+)\\s+breakdown(s)?$/i.test(t)) {
                nextVal = t.replace(/^Show\\s+(\\d+)\\s+breakdown(s)?$/i, (m, num) => USE_TW ? ("顯示 " + num + " 項明細") : ("显示 " + num + " 项细目"));
            } else if (/^Hide\\s+breakdown(s)?$/i.test(t)) {
                nextVal = USE_TW ? "收起明細" : "收起细目";
            } else if (/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(t)) {
                nextVal = t.replace(/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, del, name, count, dot) => {
                    const delPrefix = del ? (USE_TW ? "永久刪除 " : "永久删除 ") : "";
                    const suffix = dot ? "。" : "";
                    return delPrefix + name + (USE_TW ? ("（包含 " + count + " 個活躍對話）") : ("（包含 " + count + " 个活跃会话）")) + suffix;
                });
            }
            if (attr === 'aria-label' && (!nextVal || !/[\\u4e00-\\u9fff]/.test(nextVal))) {
                const tid = el.getAttribute('data-testid');
                if (tid === 'mode-option-non-technical') {
                    nextVal = USE_TW ? '精簡協作模式' : '精简协作模式';
                } else if (tid === 'mode-option-developer') {
                    nextVal = USE_TW ? '完整開發者模式' : '完整开发者模式';
                }
            }
            if (nextVal && nextVal !== v) el.setAttribute(attr, nextVal);
        }
    }

    function observeRoot(root) {
        try {
            if (root && !observedRoots.has(root)) {
                observedRoots.add(root);
                observer.observe(root, obsOpts);
            }
        } catch (e) {}
    }

    function hookIframe(frame) {
        if (!frame || hookedFrames.has(frame)) return;
        hookedFrames.add(frame);
        const handleDoc = () => {
            try {
                const doc = frame.contentDocument;
                if (!doc) return;
                const root = doc.body || doc.documentElement;
                if (root) {
                    observeRoot(root);
                    translateNode(root);
                }
            } catch (e) {}
        };
        frame.addEventListener('load', handleDoc);
        handleDoc();
    }

    function translateNode(node) {
        try {
            if (!node) return;
            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
                for (const child of node.childNodes) translateNode(child);
                return;
            }
            
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toUpperCase();
                if (SKIP_TAGS.includes(tag)) return;

                translateElementAttrs(node);
                if (tag === 'IFRAME') hookIframe(node);

                if (isCodeOrEditor(node)) return;
                if (node.isContentEditable) return;
                if (node.classList && (node.classList.contains('monaco-editor') || node.classList.contains('terminal') || node.classList.contains('xterm'))) return;

                // 处理 FastPick / 列表底部的 "Show <N> more..." 复合节点
                const elText = node.textContent ? node.textContent.trim() : '';
                if (/^Show\\s+\\d+\\s+more(?:\\.\\.\\.|…)?$/i.test(elText)) {
                    const textChildren = Array.from(node.childNodes).filter(c => c.nodeType === Node.TEXT_NODE);
                    if (textChildren.length >= 2) {
                        for (const tc of textChildren) {
                            const v = tc.nodeValue;
                            if (v === 'Show ' || norm(v) === 'Show') {
                                tc.nodeValue = USE_TW ? '顯示另外 ' : '显示另外 ';
                                translatedValues.set(tc, tc.nodeValue);
                            } else if (v === ' more...' || v === ' more…' || norm(v) === 'more...') {
                                tc.nodeValue = USE_TW ? ' 個...' : ' 个...';
                                translatedValues.set(tc, tc.nodeValue);
                            }
                        }
                    } else if (textChildren.length === 1) {
                        const m = elText.match(/^Show\\s+(\\d+)\\s+more(?:\\.\\.\\.|…)?$/i);
                        if (m) {
                            textChildren[0].nodeValue = USE_TW ? ('顯示另外 ' + m[1] + ' 個...') : ('显示另外 ' + m[1] + ' 个...');
                            translatedValues.set(textChildren[0], textChildren[0].nodeValue);
                        }
                    }
                }
                if (/^No\\s+(?:MCP servers|plugins|skills|rules|apps|automations)\\s+found\\s+for\\s+".+"\\.?$/i.test(elText)) {
                    const textChildren = Array.from(node.childNodes).filter(c => c.nodeType === Node.TEXT_NODE);
                    if (textChildren.length >= 2) {
                        const firstTc = textChildren[0];
                        const lastTc = textChildren[textChildren.length - 1];
                        if (/^No\\s+(?:MCP servers|plugins|skills|rules|apps|automations)\\s+found\\s+for\\s+"$/i.test(firstTc.nodeValue)) {
                            firstTc.nodeValue = USE_TW ? '找不到符合「' : '找不到与“';
                            translatedValues.set(firstTc, firstTc.nodeValue);
                        }
                        if (/^"\\.?$/.test(lastTc.nodeValue)) {
                            lastTc.nodeValue = USE_TW ? '」的項目' : '”匹配的项目';
                            translatedValues.set(lastTc, lastTc.nodeValue);
                        }
                    }
                }

                if (node.shadowRoot) {
                    observeRoot(node.shadowRoot);
                    translateNode(node.shadowRoot);
                }
                for (const child of node.childNodes) translateNode(child);

            } else if (node.nodeType === Node.TEXT_NODE) {
                if (isCodeOrEditor(node)) return;

                let originalVal = node.nodeValue;
                if (!originalVal || originalVal.trim().length < 1) return;
                if (!/[A-Za-z]/.test(originalVal)) return;

                // 处理 FastPick / 列表底部由于 React 节点拆分导致的 "Show ", num, " more..." 分段文本
                const parentText = node.parentElement && node.parentElement.textContent ? node.parentElement.textContent.trim() : '';
                if (parentText && (
                    /^(?:Show|显示另外|顯示另外)\\s+\\d+\\s+(?:more|个|個)(?:\\.\\.\\.|…)?$/i.test(parentText) ||
                    (node.parentElement.getAttribute && node.parentElement.getAttribute('value')?.startsWith('fastpick-show-more:'))
                )) {
                    if (originalVal === 'Show ' || norm(originalVal) === 'Show') {
                        node.nodeValue = USE_TW ? '顯示另外 ' : '显示另外 ';
                        translatedValues.set(node, node.nodeValue);
                        return;
                    }
                    if (originalVal === ' more...' || originalVal === ' more…' || norm(originalVal) === 'more...') {
                        node.nodeValue = USE_TW ? ' 個...' : ' 个...';
                        translatedValues.set(node, node.nodeValue);
                        return;
                    }
                }

                // 核心：如果是 skeleton 骨架占位文本，强制打上不翻译标记，防止自动翻译（例如 Google Translate 网页翻译）将其翻译为“装。资料。包装。资料。”
                if (originalVal.toLowerCase().includes('pack.info')) {
                    const parent = node.parentElement;
                    if (parent) {
                        if (parent.getAttribute('translate') !== 'no') {
                            parent.setAttribute('translate', 'no');
                        }
                        try {
                            if (!parent.classList.contains('notranslate')) {
                                parent.classList.add('notranslate');
                            }
                        } catch (e) {}
                    }
                    return;
                }

                if (translatedValues.get(node) === originalVal) return;

                let newVal = originalVal;
                const valNorm = norm(originalVal);
                const valLower = valNorm.toLowerCase();
                
                // 1. 精确匹配（含大小写自动纠正与快捷键检测）
                const SKILL_SINGLE_WORDS = {
                    'automation': USE_TW ? '自動化排程任務設計' : '自动化排程任务设计',
                    'plugin': USE_TW ? '外掛建立與管理' : '插件创建与管理',
                    'swarm': USE_TW ? '多代理蜂群平行協作' : '多智能体蜂群并行协作',
                    'conversations': USE_TW ? '本機對話程式化管理' : '本地对话程序化管理',
                    'troubleshooting': USE_TW ? '連線與環境疑難排解' : '连接与环境疑难解答'
                };
                const isSkillTitleEl = node.parentElement && (
                    (node.parentElement.getAttribute && node.parentElement.getAttribute('data-testid') === 'doc-row-title') ||
                    (node.parentElement.classList && node.parentElement.classList.contains('font-medium') && node.parentElement.classList.contains('truncate') &&
                     node.parentElement.nextElementSibling && node.parentElement.nextElementSibling.classList && node.parentElement.nextElementSibling.classList.contains('text-muted-foreground'))
                );
                const smartTrans = smartTranslate(originalVal) || smartTranslate(valNorm);
                if (isSkillTitleEl && SKILL_SINGLE_WORDS[valLower]) {
                    newVal = SKILL_SINGLE_WORDS[valLower];
                } else if (smartTrans) {
                    newVal = smartTrans;
                } else if (map.has(valNorm)) {
                    newVal = map.get(valNorm);
                } else if (lowerMap.has(valLower)) {
                    newVal = lowerMap.get(valLower);
                } else if (/^Send message\\s+(Enter|⏎|\\u23ce)$/i.test(valNorm)) {
                    newVal = (USE_TW ? "傳送訊息 " : "发送消息 ") + valNorm.replace(/^Send message\\s+/i, '');
                } else if (/^Queue message\\s+(Enter|⏎|\\u23ce)$/i.test(valNorm)) {
                    newVal = (USE_TW ? "排隊傳送訊息 " : "排队发送消息 ") + valNorm.replace(/^Queue message\\s+/i, '');
                } else if (/^to have the agent generate a plan\\.?$/i.test(valNorm)) {
                    newVal = USE_TW ? "讓代理生成計畫。" : "让智能体生成计划。";
                } else if ((valNorm === 'Type' || valNorm === 'and select') && node.parentElement && (
                    (typeof node.parentElement.closest === 'function' && node.parentElement.closest('[data-testid="plan-command-fyi-alert"]')) ||
                    (node.parentElement.textContent && node.parentElement.textContent.includes('generate a plan'))
                )) {
                    if (valNorm === 'Type') newVal = USE_TW ? "輸入" : "输入";
                    else if (valNorm === 'and select') newVal = USE_TW ? "並選取" : "并选择";
                } else if (valNorm === 'and' && node.parentElement && (
                    node.parentElement.textContent && (
                        node.parentElement.textContent.includes('Privacy Policy') ||
                        node.parentElement.textContent.includes('Terms of Service') ||
                        node.parentElement.textContent.includes('隐私政策') ||
                        node.parentElement.textContent.includes('隱私權政策')
                    )
                )) {
                    newVal = USE_TW ? "以及" : "以及";
                } else if (/^The AlloyDB for PostgreSQL remote/i.test(valNorm)) {
                    newVal = USE_TW ? "AlloyDB for PostgreSQL 遠端 MCP 伺服器可讓您存取並執行 AlloyDB 工具，用於管理 AlloyDB 叢集及執行個體、管理使用者，以及建立和復原資料備份。" : "AlloyDB for PostgreSQL 远程 MCP 服务器可让您访问并运行 AlloyDB 工具，用于管理 AlloyDB 集群及实例、管理用户，以及创建和恢复数据备份。";
                } else if (/^The Cloud SQL remote/i.test(valNorm)) {
                    newVal = USE_TW ? "Cloud SQL 遠端 MCP 伺服器可讓您存取並執行 Cloud SQL 工具，用於管理 Cloud SQL 執行個體、管理使用者、建立和復原資料備份及資料庫維運。" : "Cloud SQL 远程 MCP 服务器可让您访问并运行 Cloud SQL 工具，用于管理 Cloud SQL 实例、管理用户、创建和恢复数据备份及数据库运维。";
                } else if (/^The Spanner remote/i.test(valNorm)) {
                    newVal = USE_TW ? "Spanner 遠端 MCP 伺服器可讓您從 AI 開發環境中存取並執行 Spanner 工具，以建立、管理和查詢分散式資料庫資源。" : "Spanner 远程 MCP 服务器可让您从 AI 开发环境中访问并运行 Spanner 工具，以创建、管理和查询分布式数据库资源。";
                } else if (/^Ask questions\\.\\s*Get answers\\./i.test(valNorm) || /PostHog data/i.test(valNorm)) {
                    newVal = USE_TW ? "提問，即得答案。該 MCP 是供您的程式設計代理呼叫的伺服器。用英語提出問題，它會針對您的 PostHog 資料執行查詢，結果將直接呈現在您的編輯器中。" : "提问，即得答案。该 MCP 是供您的编程智能体调用的服务器。用英语提出问题，它会针对您的 PostHog 数据运行查询，结果将直接呈现在您的编辑器中。";
                } else if (/^The GKE remote MCP server/i.test(valNorm)) {
                    newVal = USE_TW ? "GKE 遠端 MCP 伺服器提供對 GKE Kubernetes 資源的讀寫存取權限。允許 AI 代理檢查並監控您的執行環境。" : "GKE 远程 MCP 服务器提供对 GKE Kubernetes 资源的读写权限。允许 AI 智能体检查并监控您的运行环境。";
                } else if (/^Cloud CLI MCP Server/i.test(valNorm)) {
                    newVal = USE_TW ? "Cloud CLI MCP 伺服器提供在遠端沙箱環境中執行 gcloud 與 bq CLI 指令的工具集。" : "Cloud CLI MCP 服务器提供在远程沙箱环境中运行 gcloud 与 bq CLI 命令的工具集。";
                } else if (/^The Apigee API hub remote MCP server/i.test(valNorm)) {
                    newVal = USE_TW ? "Apigee API hub 遠端 MCP 伺服器可讓您管理註冊在 Apigee API hub 中的 API、版本、規格、操作、部署、屬性、外部 API 以及相依性。" : "Apigee API hub 远程 MCP 服务器可让您管理注册在 Apigee API hub 中的 API、版本、规范、操作、部署、属性、外部 API 以及依赖项。";
                } else if (/^The Google Home Developer MCP server/i.test(valNorm)) {
                    newVal = USE_TW ? "Google Home Developer MCP 伺服器支援檢索 Google Home 文件、OpenThread 與 Matter 規格文件。" : "Google Home Developer MCP 服务器支持检索 Google Home 文档、OpenThread 与 Matter 规范文档。";
                } else if (/^The Cloud Quotas MCP server/i.test(valNorm)) {
                    newVal = USE_TW ? "Cloud Quotas MCP 伺服器支援檢視配額分配、申請提升配額以及管理 Quota Adjuster 自動調整設定。" : "Cloud Quotas MCP 服务器支持查看配额分配、申请提升配额以及管理 Quota Adjuster 自动调整配置。";
                } else if (/^Build, edit, deploy, and manage full-stack web apps with Lovable/i.test(valNorm)) {
                    newVal = USE_TW ? "使用自然語言，藉助 AI 應用程式建構工具 Lovable 建構、編輯、部署和管理全端 Web 應用程式。該 MCP 伺服器將您的 AI 用戶端連接至 Lovable，允許您的 AI 代理直接在偏好的編輯器或助手內互動、建立和管理 Lovable 專案。" : "使用自然语言，借助 AI 应用构建工具 Lovable 构建、编辑、部署和管理全栈 Web 应用。该 MCP 服务器将您的 AI 客户端连接至 Lovable，允许您的 AI 智能体直接在偏好的编辑器或助手中交互、创建和管理 Lovable 项目。";
                } else if (/^Build applications with the Gemini Interactions API and Live API/i.test(valNorm)) {
                    newVal = USE_TW ? "使用 Gemini Interactions API 與 Live API 建構應用程式，涵蓋文字生成、多輪對話、串流、函式呼叫、託管代理及即時音訊與視訊互動。" : "使用 Gemini Interactions API 和 Live API 构建应用，涵盖文本生成、多轮对话、流式传输、函数调用、托管智能体以及实时音视频交互。";
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?, (\\d+) hours?\\.?$/i, (match, d, h) => {
                        return USE_TW ? (d + " 天 " + h + " 小時後更新") : (d + " 天 " + h + " 小时后刷新");
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?, (\\d+) minutes?\\.?$/i, (match, h, m) => {
                        return USE_TW ? (h + " 小時 " + m + " 分鐘後更新") : (h + " 小时 " + m + " 分钟后刷新");
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) days?\\.?$/i, (match, d) => {
                        return USE_TW ? (d + " 天後更新") : (d + " 天后刷新");
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) hours?\\.?$/i, (match, h) => {
                        return USE_TW ? (h + " 小時後更新") : (h + " 小时后刷新");
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in (\\d+) minutes?\\.?$/i, (match, m) => {
                        return USE_TW ? (m + " 分鐘後更新") : (m + " 分钟后刷新");
                    });
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in less than a minute\\.?$/i.test(valNorm)) {
                    newVal = USE_TW ? "不到 1 分鐘後更新" : "不到 1 分钟后刷新";
                } else if (/^(?:Refreshes|You have (?:used (?:some|all) of|reached) your (?:weekly|5-hour) limit, it will fully refresh) in a few seconds\\.?$/i.test(valNorm)) {
                    newVal = USE_TW ? "幾秒後更新" : "几秒后刷新";
                } else if (/^Learn more about$/i.test(valNorm)) {
                    newVal = USE_TW ? "瞭解更多關於" : "了解更多关于";
                } else if (/^Learn more about (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Learn more about (.+)$/i, (match, p) => {
                        let translatedPreset = p;
                        const pLow = p.toLowerCase();
                        if (pLow === 'default' || pLow.includes('默认') || pLow.includes('預設')) translatedPreset = USE_TW ? "預設 (Default)" : "默认 (Default)";
                        else if (pLow === 'full machine' || pLow.includes('全机') || pLow.includes('全機')) translatedPreset = USE_TW ? "全機存取 (Full Machine)" : "全机访问 (Full Machine)";
                        else if (pLow === 'turbo mode' || pLow.includes('极速') || pLow.includes('極速')) translatedPreset = USE_TW ? "極速模式 (Turbo Mode)" : "极速模式 (Turbo Mode)";
                        else if (pLow === 'custom' || pLow.includes('自定义') || pLow.includes('自訂')) translatedPreset = USE_TW ? "自訂 (Custom)" : "自定义 (Custom)";
                        return USE_TW ? ("瞭解更多關於 " + translatedPreset + " 的詳細資訊") : ("了解更多关于 " + translatedPreset + " 的信息");
                    });
                } else if (/^Yes, and always allow '(.+)' in this project$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)' in this project$/i, (match, cmd) => {
                        return USE_TW ? ("是，且在此專案中一律允許執行 '" + cmd + "'") : ("是，且在此项目中始终允许运行 '" + cmd + "'");
                    });
                } else if (/^Yes, and always allow '(.+)'$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)'$/i, (match, cmd) => {
                        return USE_TW ? ("是，且一律允許執行 '" + cmd + "'") : ("是，且始终允许运行 '" + cmd + "'");
                    });
                } else if (/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Show\\s+(\\d+)\\s+more(\\s+(results?|items?|commands?|options?))?(\\.\\.\\.|…)?$/i, (match, num, p2, type) => {
                        if (type) {
                            if (/result/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個結果...") : ("显示另外 " + num + " 个结果...");
                            if (/command/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個指令...") : ("显示另外 " + num + " 个命令...");
                            if (/item/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個項目...") : ("显示另外 " + num + " 个项目...");
                            if (/option/i.test(type)) return USE_TW ? ("顯示另外 " + num + " 個選項...") : ("显示另外 " + num + " 个选项...");
                        }
                        return USE_TW ? ("顯示另外 " + num + " 個...") : ("显示另外 " + num + " 个...");
                    });
                } else if (/^Show\\s+(\\d+)\\s+breakdown(s)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Show\\s+(\\d+)\\s+breakdown(s)?$/i, (match, num) => {
                        return USE_TW ? ("顯示 " + num + " 項明細") : ("显示 " + num + " 项细目");
                    });
                } else if (/^Hide\\s+breakdown(s)?$/i.test(valNorm)) {
                    newVal = USE_TW ? "收起明細" : "收起细目";
                } else if (/^Show\\s+breakdown(s)?$/i.test(valNorm)) {
                    newVal = USE_TW ? "顯示明細" : "显示细目";
                } else if (/^Hide\\s+tools$/i.test(valNorm)) {
                    newVal = USE_TW ? "收起工具" : "收起工具";
                } else if (/^(\\d+)\\s+tools?\\s+excluded$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)\\s+tools?\\s+excluded$/i, (match, num) => {
                        return num + (USE_TW ? " 個工具已排除" : " 个工具已排除");
                    });
                } else if (/^Exceeded the rules token budget\\.\\s+Full rule content\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+was replaced with a lightweight file-path pointer in context\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Exceeded the rules token budget\\.\\s+Full rule content\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+was replaced with a lightweight file-path pointer in context\\.$/i, (match, num) => {
                        return USE_TW ? ("已超出規則 Token 預算。完整規則內容 (" + num + " 個 Token) 已在上下文中替換為輕量級檔案路徑指標。") : ("已超出规则 Token 预算。完整规则内容 (" + num + " 个 Token) 已在上下文中替换为轻量级文件路径指针。");
                    });
                } else if (/^All tools in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^All tools in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i, (match, num) => {
                        return USE_TW ? ("此 MCP 伺服器中的所有工具 (" + num + " 個 Token) 均已超出自訂項預算，並已從上下文中排除。") : ("此 MCP 服务器中的所有工具 (" + num + " 个 Token) 均已超出自定义项预算，并已从上下文中排除。");
                    });
                } else if (/^(\\d+)\\s+tools?\\s+in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)\\s+tools?\\s+in this MCP server\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+exceeded the customization budget and were excluded from context\\.$/i, (match, tCount, num) => {
                        return USE_TW ? ("此 MCP 伺服器中有 " + tCount + " 個工具 (" + num + " 個 Token) 超出自訂項預算，並已從上下文中排除。") : ("此 MCP 服务器中有 " + tCount + " 个工具 (" + num + " 个 Token) 超出自定义项预算，并已从上下文中排除。");
                    });
                } else if (/^Exceeded the customization token budget\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+and was excluded from context\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Exceeded the customization token budget\\s+\\(([\\d,]+)\\s+tokens?\\)\\s+and was excluded from context\\.$/i, (match, num) => {
                        return USE_TW ? ("超出自訂項 Token 預算 (" + num + " 個 Token)，已從上下文中排除。") : ("超出自定义项 Token 预算 (" + num + " 个 Token)，已从上下文中排除。");
                    });
                } else if (/^See all\\s*\\((\\d+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^See all\\s*\\((\\d+)\\)$/i, (match, num) => {
                        return USE_TW ? ("顯示全部 (" + num + ")") : ("显示全部 (" + num + ")");
                    });
                } else if (/^(\\d+)(s|m|h|d|w|mo|yr)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)(s|m|h|d|w|mo|yr)$/i, (match, num, unit) => {
                        const unitLower = unit.toLowerCase();
                        let unitStr = "";
                        if (unitLower === "s") unitStr = USE_TW ? "秒前" : "秒前";
                        else if (unitLower === "m") unitStr = USE_TW ? "分鐘前" : "分钟前";
                        else if (unitLower === "h") unitStr = USE_TW ? "小時前" : "小时前";
                        else if (unitLower === "d") unitStr = USE_TW ? "天前" : "天前";
                        else if (unitLower === "w") unitStr = USE_TW ? "週前" : "周前";
                        else if (unitLower === "mo") unitStr = USE_TW ? "個月前" : "个月前";
                        else if (unitLower === "yr") unitStr = USE_TW ? "年前" : "年前";
                        return num + unitStr;
                    });
                } else if (/^(.+?): context deadline exceeded$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): context deadline exceeded$/i, (match, prefix) => {
                        return prefix + (USE_TW ? ": 要求逾時 (context deadline exceeded)" : ": 请求超时 (context deadline exceeded)");
                    });
                } else if (/^(.+?): i\\/o timeout$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): i\\/o timeout$/i, (match, prefix) => {
                        return prefix + (USE_TW ? ": I/O 逾時 (i/o timeout)" : ": I/O 超时 (i/o timeout)");
                    });
                } else if (/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i, (match, article, name) => {
                        return USE_TW ? ("您確定要刪除專案 " + name + " 嗎？") : ("您确定要删除项目 " + name + " 吗？");
                    });
                } else if (/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(?:(Permanently delete)\\s+)?(.+?)\\s+including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, del, name, count, dot) => {
                        const delPrefix = del ? (USE_TW ? "永久刪除 " : "永久删除 ") : "";
                        const suffix = dot ? "。" : "";
                        return delPrefix + name + (USE_TW ? ("（包含 " + count + " 個活躍對話）") : ("（包含 " + count + " 个活跃会话）")) + suffix;
                    });
                } else if (/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^including\\s+(\\d+)\\s+active conversations?([.。])?$/i, (match, count, dot) => {
                        const suffix = dot ? "。" : "";
                        return (USE_TW ? ("包含 " + count + " 個活躍對話") : ("包含 " + count + " 个活跃会话")) + suffix;
                    });
                } else if (/^(\\d+)\\s+active conversations?([.。])?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)\\s+active conversations?([.。])?$/i, (match, count, dot) => {
                        const suffix = dot ? "。" : "";
                        return (USE_TW ? (count + " 個活躍對話") : (count + " 个活跃会话")) + suffix;
                    });
                } else if (/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you access and run (.+?) tools to (.+)$/i, (match, name, tools, action) => {
                        return name + (USE_TW ? " 遠端 MCP 伺服器可讓您存取並執行 " : " 远程 MCP 服务器可让您访问并运行 ") + tools + (USE_TW ? " 工具以進行管理與操作。" : " 工具以进行管理与操作。");
                    });
                } else if (/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The (.+?) remote MCP server lets you manage (.+) resources\\.?$/i, (match, name, res) => {
                        return name + (USE_TW ? " 遠端 MCP 伺服器可讓您管理 " : " 远程 MCP 服务器可让您管理 ") + res + (USE_TW ? " 資源。" : " 资源。");
                    });
                } else if (/^The (.+?) remote MCP server (allows you to|lets you) (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The (.+?) remote MCP server (allows you to|lets you) (.+)$/i, (match, name, verb, rest) => {
                        let text = rest;
                        text = text.replace(/enroll projects/gi, USE_TW ? "註冊專案" : "注册项目")
                                   .replace(/generate audit and scope reports/gi, USE_TW ? "產生稽核與範圍報告" : "生成审计与范围报告")
                                   .replace(/check resource enrollment statuses/gi, USE_TW ? "檢查資源註冊狀態" : "检查资源注册状态")
                                   .replace(/in the (.+?) region/gi, (m, r) => (USE_TW ? "在 " + r + " 區域" : "在 " + r + " 区域"));
                        return name + (USE_TW ? " 遠端 MCP 伺服器允許您 " : " 远程 MCP 服务器允许您 ") + text;
                    });
                } else if (/^Send feedback as(\\s+(.+))?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Send feedback as(\\s+(.+))?$/i, (match, p1, email) => {
                        if (email) {
                            return "以 " + email + (USE_TW ? " 身分傳送意見回饋" : " 身份发送反馈");
                        }
                        return USE_TW ? "以此身分傳送意見回饋：" : "以如下身份发送反馈：";
                    });
                } else if (/^No more older messages,\\s*showing\\s+(\\d+)\\s+of\\s+(\\d+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^No more older messages,\\s*showing\\s+(\\d+)\\s+of\\s+(\\d+)$/i, (match, a, b) => {
                        return USE_TW ? ("沒有更多歷史訊息，目前顯示 " + a + " / " + b + " 則") : ("没有更多历史消息，当前显示 " + a + " / " + b + " 条");
                    });
                } else if (/^Requesting permission to (read|write|run \\(unsandboxed\\)|run|use|download from|grant administrator access for)\\s+(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Requesting permission to (read|write|run \\(unsandboxed\\)|run|use|download from|grant administrator access for)\\s+(.+)$/i, (m, act, target) => {
                        const actMap = USE_TW ? {
                            'read': '讀取',
                            'write': '寫入',
                            'run (unsandboxed)': '執行 (非沙箱)',
                            'run': '執行',
                            'use': '使用',
                            'download from': '從中下載',
                            'grant administrator access for': '為其授予管理員權限'
                        } : {
                            'read': '读取',
                            'write': '写入',
                            'run (unsandboxed)': '运行 (非沙箱)',
                            'run': '运行',
                            'use': '使用',
                            'download from': '从中下载',
                            'grant administrator access for': '为其授予管理员权限'
                        };
                        const actZh = actMap[act.toLowerCase()] || act;
                        return USE_TW ? ("正在請求權限以" + actZh + " " + target) : ("正在请求权限以" + actZh + " " + target);
                    });
                } else if (/^Save rule to always allow (.+?)\\?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Save rule to always allow (.+?)\\?$/i, (m, target) => {
                        return USE_TW ? ("儲存規則以一律允許 " + target + "？") : ("保存规则以始终允许 " + target + "？");
                    });
                } else if (/^Allow (.+?)\\?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Allow (.+?)\\?$/i, (m, target) => {
                        return USE_TW ? ("允許 " + target + "？") : ("允许 " + target + "？");
                    });
                } else if (/^Yes, allow downloads from (.+) for this run$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, allow downloads from (.+) for this run$/i, (m, target) => {
                        return USE_TW ? ("是，本次執行允許從 " + target + " 下載") : ("是，本次运行允许从 " + target + " 下载");
                    });
                } else if (/^Yes, allow downloads from (.+) in this conversation$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, allow downloads from (.+) in this conversation$/i, (m, target) => {
                        return USE_TW ? ("是，在此對話中允許從 " + target + " 下載") : ("是，在此会话中允许从 " + target + " 下载");
                    });
                } else if (/^Yes, always allow downloads from (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, always allow downloads from (.+)$/i, (m, target) => {
                        return USE_TW ? ("是，一律允許從 " + target + " 下載") : ("是，始终允许从 " + target + " 下载");
                    });
                } else if (/^Yes, save rule for '(.+)' in this conversation$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, save rule for '(.+)' in this conversation$/i, (m, target) => {
                        return USE_TW ? ("是，在此對話中為 '" + target + "' 儲存規則") : ("是，在此会话中为 '" + target + "' 保存规则");
                    });
                } else if (/^Yes, save rule for '(.+)' globally$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, save rule for '(.+)' globally$/i, (m, target) => {
                        return USE_TW ? ("是，為 '" + target + "' 全域儲存規則") : ("是，为 '" + target + "' 全局保存规则");
                    });
                } else if (/^Yes, and always allow '(.+)' in this conversation$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)' in this conversation$/i, (m, target) => {
                        return USE_TW ? ("是，且在此對話中一律允許 '" + target + "'") : ("是，且在此会话中始终允许 '" + target + "'");
                    });
                } else if (/^Yes, allow (.+) in this conversation$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, allow (.+) in this conversation$/i, (m, target) => {
                        return USE_TW ? ("是，在此對話中允許 " + target) : ("是，在此会话中允许 " + target);
                    });
                } else if (/^Yes, always allow (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, always allow (.+)$/i, (m, target) => {
                        return USE_TW ? ("是，一律允許 " + target) : ("是，始终允许 " + target);
                    });
                } else if (/^Conflicts with your configured Ask permission:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Conflicts with your configured Ask permission:\\s*(.+)$/i, (m, detail) => {
                        return USE_TW ? ("與您設定的「詢問」權限衝突：" + detail) : ("与您配置的“询问”权限冲突：" + detail);
                    });
                } else if (/^Requires manual confirmation:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Requires manual confirmation:\\s*(.+)$/i, (m, detail) => {
                        return USE_TW ? ("需要手動確認：" + detail) : ("需要手动确认：" + detail);
                    });
                } else if (/^Process terminated with signal (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Process terminated with signal (.+)$/i, (m, sig) => {
                        return USE_TW ? ("行程已被訊號 " + sig + " 終止") : ("进程已被信号 " + sig + " 终止");
                    });
                } else if (/^Showing (first|last) (\\d+) lines?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Showing (first|last) (\\d+) lines?$/i, (m, pos, num) => {
                        const pZh = /^first/i.test(pos) ? "前" : (USE_TW ? "後" : "后");
                        return USE_TW ? ("顯示" + pZh + " " + num + " 行") : ("显示" + pZh + " " + num + " 行");
                    });
                } else if (/^Coordinator assigned task to (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Coordinator assigned task to (.+)$/i, (m, target) => {
                        return USE_TW ? ("協調員已指派任務給 " + target) : ("协调员已分配任务给 " + target);
                    });
                } else if (/^Delegated subtask to (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Delegated subtask to (.+)$/i, (m, target) => {
                        return USE_TW ? ("已委派子任務給 " + target) : ("已委派子任务给 " + target);
                    });
                } else if (/^Worker (.+) (finished assignment|completed task|posted to board)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Worker (.+) (finished assignment|completed task|posted to board)$/i, (m, name, act) => {
                        let actZh = act;
                        if (/finished|completed/i.test(act)) actZh = USE_TW ? "已完成任務" : "已完成任务";
                        else if (/posted/i.test(act)) actZh = USE_TW ? "已在看板上留言" : "已在看板上留言";
                        return (USE_TW ? "工作者 " : "工作进程 ") + name + " " + actZh;
                    });
                } else if (/^Subagent (.+) (started execution|finished execution|finished working|completed successfully|reported failure|interrupted)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Subagent (.+) (started execution|finished execution|finished working|completed successfully|reported failure|interrupted)$/i, (m, name, status) => {
                        const sMap = USE_TW ? {
                            'started execution': '已開始執行',
                            'finished execution': '已完成執行',
                            'finished working': '已完成工作',
                            'completed successfully': '已成功完成',
                            'reported failure': '回報失敗',
                            'interrupted': '已被中斷'
                        } : {
                            'started execution': '已开始执行',
                            'finished execution': '已完成执行',
                            'finished working': '已完成工作',
                            'completed successfully': '已成功完成',
                            'reported failure': '报告失败',
                            'interrupted': '已被中断'
                        };
                        return (USE_TW ? "子代理 " : "子智能体 ") + name + " " + (sMap[status.toLowerCase()] || status);
                    });
                } else if (/^Swarm status:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Swarm status:\\s*(.+)$/i, (m, status) => {
                        let sZh = status;
                        if (/healthy/i.test(status)) sZh = USE_TW ? "正常" : "正常";
                        else if (/stalled/i.test(status)) sZh = USE_TW ? "停滯" : "停滞";
                        return "Swarm " + (USE_TW ? "狀態：" : "状态：") + sZh;
                    });
                } else if (/^All (\\d+) workers completed their tasks$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^All (\\d+) workers completed their tasks$/i, (m, count) => {
                        return USE_TW ? ("所有 " + count + " 名工作者均已完成任務") : ("所有 " + count + " 名工作进程均已完成任务");
                    });
                } else if (/^The agent wants to (execute this command|edit this file|create this file|delete this file|read this file outside workspace|read a file outside your workspace|access external network|run an unsandboxed command):?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^The agent wants to (execute this command|edit this file|create this file|delete this file|read this file outside workspace|read a file outside your workspace|access external network|run an unsandboxed command):?$/i, (m, action) => {
                        const aMap = USE_TW ? {
                            'execute this command': '執行此指令',
                            'edit this file': '編輯此檔案',
                            'create this file': '建立此檔案',
                            'delete this file': '刪除此檔案',
                            'read this file outside workspace': '讀取工作區外的檔案',
                            'read a file outside your workspace': '讀取工作區外的檔案',
                            'access external network': '存取外部網路',
                            'run an unsandboxed command': '在沙箱外執行指令'
                        } : {
                            'execute this command': '运行此命令',
                            'edit this file': '编辑此文件',
                            'create this file': '创建此文件',
                            'delete this file': '删除此文件',
                            'read this file outside workspace': '读取工作区外文件',
                            'read a file outside your workspace': '读取工作区外文件',
                            'access external network': '访问外部网络',
                            'run an unsandboxed command': '在沙箱外运行命令'
                        };
                        return (USE_TW ? "代理想要" : "智能体想要") + (aMap[action.toLowerCase()] || action) + "：";
                    });
                } else if (/^(Clicking|Clicked) element "(.+)"$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Clicking|Clicked) element "(.+)"$/i, (m, verb, desc) => {
                        const vZh = /^Clicking/i.test(verb) ? (USE_TW ? "正在點擊元素" : "正在点击元素") : (USE_TW ? "已點擊元素" : "已点击元素");
                        return vZh + ' "' + desc + '"';
                    });
                } else if (/^(Typing|Typed) '(.+)' in Browser$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Typing|Typed) '(.+)' in Browser$/i, (m, verb, text) => {
                        const vZh = /^Typing/i.test(verb) ? (USE_TW ? "正在瀏覽器中鍵入" : "正在浏览器中键入") : (USE_TW ? "已在瀏覽器中鍵入" : "已在浏览器中键入");
                        return vZh + " '" + text + "'";
                    });
                } else if (/^(Pressing|Pressed) (.+) in Browser$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Pressing|Pressed) (.+) in Browser$/i, (m, verb, key) => {
                        const vZh = /^Pressing/i.test(verb) ? (USE_TW ? "正在瀏覽器中按下" : "正在浏览器中按下") : (USE_TW ? "已在瀏覽器中按下" : "已在浏览器中按下");
                        return vZh + " " + key;
                    });
                } else if (/^(Searching|Searched)\\s+(web|images)?\\s*for\\s+"(.+)"$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Searching|Searched)\\s+(web|images)?\\s*for\\s+"(.+)"$/i, (m, verb, type, q) => {
                        const vZh = /^Searching/i.test(verb) ? (USE_TW ? "正在搜尋" : "正在搜索") : (USE_TW ? "已搜尋" : "已搜索");
                        const tZh = type ? (/image/i.test(type) ? (USE_TW ? "圖片 " : "图片 ") : (USE_TW ? "網頁 " : "网页 ")) : "";
                        return vZh + " " + tZh + '"' + q + '"';
                    });
                } else if (/^(Reading|Read) terminal:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(Reading|Read) terminal:\\s*(.+)$/i, (m, verb, name) => {
                        const vZh = /^Reading/i.test(verb) ? (USE_TW ? "正在讀取終端機：" : "正在读取终端：") : (USE_TW ? "已讀取終端機：" : "已读取终端：");
                        return vZh + " " + name;
                    });
                } else if (/^Read resource:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Read resource:\\s*(.+)$/i, (m, uri) => {
                        return (USE_TW ? "已讀取資源：" : "已读取资源：") + " " + uri;
                    });
                } else if (/^List resources:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^List resources:\\s*(.+)$/i, (m, srv) => {
                        return (USE_TW ? "列出資源：" : "列出资源：") + " " + srv;
                    });
                } else if (/^Hook will only trigger if the tool name matches (.+)\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Hook will only trigger if the tool name matches (.+)\\.$/i, (m, tool) => {
                        return USE_TW ? ("僅當工具名稱符合 " + tool + " 時才會觸發勾點。") : ("仅当工具名称匹配 " + tool + " 时才会触发钩子。");
                    });
                } else if (/^Hook will only trigger if the tool name starts with (.+)\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Hook will only trigger if the tool name starts with (.+)\\.$/i, (m, prefix) => {
                        return USE_TW ? ("僅當工具名稱以 " + prefix + " 開頭時才會觸發勾點。") : ("仅当工具名称以 " + prefix + " 开头时才会触发钩子。");
                    });
                } else if (/^Hook will trigger if any tool is executed\\.$/i.test(valNorm)) {
                    newVal = USE_TW ? "執行任何工具時皆會觸發勾點。" : "运行任何工具时都会触发钩子。";
                } else if (/^In this case, (\\d+) chunks were collapsed into one\\.(.*)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^In this case, (\\d+) chunks were collapsed into one\\.(.*)$/i, (m, count, rest) => {
                        return USE_TW ? ("在此情況下，已將 " + count + " 個區塊合併為一個。" + rest) : ("在此情况下，已将 " + count + " 个分块合并为一个。" + rest);
                    });
                } else if (/^Web search prioritized results from (.+?)\\. The LLM decided that this would yield the best results\\.(.*)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Web search prioritized results from (.+?)\\. The LLM decided that this would yield the best results\\.(.*)$/i, (m, domain, rest) => {
                        return USE_TW
                            ? ("網路搜尋優先採用來自 " + domain + " 的結果。LLM 判定此舉可取得最佳成效。若不需要，您可直接告知代理不要使用網域篩選。")
                            : ("网络搜索优先采用来自 " + domain + " 的结果。LLM 判定此举可获得最佳效果。如果不需要，您可以直接告知智能体不要使用域名过滤。");
                    });
                } else if (/^Skip \\((.+?)\\), Skip All \\((.+?)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Skip \\((.+?)\\), Skip All \\((.+?)\\)$/i, (m, k1, k2) => {
                        return USE_TW ? ("略過 (" + k1 + ")，全部略過 (" + k2 + ")") : ("跳过 (" + k1 + ")，全部跳过 (" + k2 + ")");
                    });
                } else if (/^Continue \\((.+?)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Continue \\((.+?)\\)$/i, (m, k1) => {
                        return USE_TW ? ("繼續 (" + k1 + ")") : ("继续 (" + k1 + ")");
                    });
                } else if (/^(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?)(?:,\\s*(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?))*$/i.test(valNorm)) {
                    const verbMap = USE_TW
                        ? { exploring: '正在探索', explored: '已探索', editing: '正在編輯', edited: '已編輯', running: '正在執行', ran: '已執行' }
                        : { exploring: '正在探索', explored: '已探索', editing: '正在编辑', edited: '已编辑', running: '正在运行', ran: '已运行' };
                    const nounMap = USE_TW
                        ? { file: '個檔案', files: '個檔案', folder: '個資料夾', folders: '個資料夾', search: '次搜尋', searches: '次搜尋', command: '個指令', commands: '個指令', task: '個任務', tasks: '個任務', page: '個網頁', pages: '個網頁', browser: '次瀏覽器操作', browsers: '次瀏覽器操作', image: '張圖片', images: '張圖片', action: '項操作', actions: '項操作', artifact: '個產物', artifacts: '個產物' }
                        : { file: '个文件', files: '个文件', folder: '个文件夹', folders: '个文件夹', search: '次搜索', searches: '次搜索', command: '个命令', commands: '个命令', task: '个任务', tasks: '个任务', page: '个网页', pages: '个网页', browser: '次浏览器操作', browsers: '次浏览器操作', image: '张图片', images: '张图片', action: '项操作', actions: '项操作', artifact: '个工件', artifacts: '个工件' };
                    newVal = valNorm.split(/\\s*,\\s*/).map(part => {
                        const pm = part.match(/^(?:(Exploring|Explored|Editing|Edited|Running|Ran)\\s+)?(\\d+)\\s+(files?|folders?|searches?|commands?|tasks?|pages?|browsers?|images?|actions?|artifacts?)$/i);
                        if (!pm) return part;
                        const v = pm[1] ? (verbMap[pm[1].toLowerCase()] || pm[1]) + ' ' : '';
                        const n = nounMap[pm[3].toLowerCase()] || pm[3];
                        return v + pm[2] + ' ' + n;
                    }).join('，');
                } else if (/^(Exploring|Explored|Editing|Edited|Running|Ran|Creating|Created|Deleting|Deleted|Searching|Searched|Viewing|Viewed|Reading|Read|Writing|Wrote|Executing|Executed|Starting|Started|Stopping|Stopped|Killing|Killed|Canceling|Canceled|Delegating|Delegated|Invoking|Invoked|Calling|Called|Analyzing|Analyzed|Generating|Generated|Applying|Applied|Verifying|Verified|Testing|Tested|Compacting|Compacted|Summarizing|Summarized|Formatting|Formatted|Inspecting|Inspected|Opening|Opened|Closing|Closed|Fetching|Fetched|Downloading|Downloaded|Uploading|Uploaded|Resolving|Resolved|Updating|Updated|Configuring|Configured)\\s+(.+)$/i.test(valNorm)) {
                    const actVerbMap = USE_TW ? {
                        'exploring': '正在探索', 'explored': '已探索',
                        'editing': '正在編輯', 'edited': '已編輯',
                        'running': '正在執行', 'ran': '已執行',
                        'creating': '正在建立', 'created': '已建立',
                        'deleting': '正在刪除', 'deleted': '已刪除',
                        'searching': '正在搜尋', 'searched': '已搜尋',
                        'viewing': '正在檢視', 'viewed': '已檢視',
                        'reading': '正在讀取', 'read': '已讀取',
                        'writing': '正在寫入', 'wrote': '已寫入',
                        'executing': '正在執行', 'executed': '已執行',
                        'starting': '正在啟動', 'started': '已啟動',
                        'stopping': '正在停止', 'stopped': '已停止',
                        'killing': '正在終止', 'killed': '已終止',
                        'canceling': '正在取消', 'canceled': '已取消',
                        'delegating': '正在委派', 'delegated': '已委派',
                        'invoking': '正在呼叫', 'invoked': '已呼叫',
                        'calling': '正在呼叫', 'called': '已呼叫',
                        'analyzing': '正在分析', 'analyzed': '已分析',
                        'generating': '正在產生', 'generated': '已產生',
                        'applying': '正在套用', 'applied': '已套用',
                        'verifying': '正在驗證', 'verified': '已驗證',
                        'testing': '正在測試', 'tested': '已測試',
                        'compacting': '正在精簡', 'compacted': '已精簡',
                        'summarizing': '正在摘要', 'summarized': '已摘要',
                        'formatting': '正在格式化', 'formatted': '已格式化',
                        'inspecting': '正在檢查', 'inspected': '已檢查',
                        'opening': '正在開啟', 'opened': '已開啟',
                        'closing': '正在關閉', 'closed': '已關閉',
                        'fetching': '正在擷取', 'fetched': '已擷取',
                        'downloading': '正在下載', 'downloaded': '已下載',
                        'uploading': '正在上傳', 'uploaded': '已上傳',
                        'resolving': '正在解析', 'resolved': '已解析',
                        'updating': '正在更新', 'updated': '已更新',
                        'configuring': '正在設定', 'configured': '已設定'
                    } : {
                        'exploring': '正在探索', 'explored': '已探索',
                        'editing': '正在编辑', 'edited': '已编辑',
                        'running': '正在运行', 'ran': '已运行',
                        'creating': '正在创建', 'created': '已创建',
                        'deleting': '正在删除', 'deleted': '已删除',
                        'searching': '正在搜索', 'searched': '已搜索',
                        'viewing': '正在查看', 'viewed': '已查看',
                        'reading': '正在读取', 'read': '已读取',
                        'writing': '正在写入', 'wrote': '已写入',
                        'executing': '正在运行', 'executed': '已运行',
                        'starting': '正在启动', 'started': '已启动',
                        'stopping': '正在停止', 'stopped': '已停止',
                        'killing': '正在终止', 'killed': '已终止',
                        'canceling': '正在取消', 'canceled': '已取消',
                        'delegating': '正在委派', 'delegated': '已委派',
                        'invoking': '正在调用', 'invoked': '已调用',
                        'calling': '正在调用', 'called': '已调用',
                        'analyzing': '正在分析', 'analyzed': '已分析',
                        'generating': '正在生成', 'generated': '已生成',
                        'applying': '正在应用', 'applied': '已应用',
                        'verifying': '正在验证', 'verified': '已验证',
                        'testing': '正在测试', 'tested': '已测试',
                        'compacting': '正在压缩', 'compacted': '已压缩',
                        'summarizing': '正在总结', 'summarized': '已总结',
                        'formatting': '正在格式化', 'formatted': '已格式化',
                        'inspecting': '正在检查', 'inspected': '已检查',
                        'opening': '正在打开', 'opened': '已打开',
                        'closing': '正在关闭', 'closed': '已关闭',
                        'fetching': '正在获取', 'fetched': '已获取',
                        'downloading': '正在下载', 'downloaded': '已下载',
                        'uploading': '正在上传', 'uploaded': '已上传',
                        'resolving': '正在解析', 'resolved': '已解析',
                        'updating': '正在更新', 'updated': '已更新',
                        'configuring': '正在配置', 'configured': '已配置'
                    };
                    newVal = valNorm.replace(/^(Exploring|Explored|Editing|Edited|Running|Ran|Creating|Created|Deleting|Deleted|Searching|Searched|Viewing|Viewed|Reading|Read|Writing|Wrote|Executing|Executed|Starting|Started|Stopping|Stopped|Killing|Killed|Canceling|Canceled|Delegating|Delegated|Invoking|Invoked|Calling|Called|Analyzing|Analyzed|Generating|Generated|Applying|Applied|Verifying|Verified|Testing|Tested|Compacting|Compacted|Summarizing|Summarized|Formatting|Formatted|Inspecting|Inspected|Opening|Opened|Closing|Closed|Fetching|Fetched|Downloading|Downloaded|Uploading|Uploaded|Resolving|Resolved|Updating|Updated|Configuring|Configured)\\s+(.+)$/i, (m, verb, rest) => {
                        const vZh = actVerbMap[verb.toLowerCase()] || verb;
                        let cleanRest = rest;
                        if (/^files?\\s+/i.test(cleanRest)) {
                            cleanRest = cleanRest.replace(/^files?\\s+/i, USE_TW ? '檔案 ' : '文件 ');
                        } else if (/^commands?\\s+/i.test(cleanRest)) {
                            cleanRest = cleanRest.replace(/^commands?\\s+/i, USE_TW ? '指令 ' : '命令 ');
                        } else if (/^directory\\s+/i.test(cleanRest)) {
                            cleanRest = cleanRest.replace(/^directory\\s+/i, USE_TW ? '目錄 ' : '目录 ');
                        }
                        return vZh + " " + cleanRest;
                    });
                } else if (valNorm.length > 15) {
                    // 2. 长句子串滑动替换与末尾截断智能匹配 (仅当原句带有省略号截断时，才允许基于长前缀匹配)
                    for (const [key, translated] of longEntries) {
                        if (key.length > 15 && valNorm.includes(key)) {
                            newVal = newVal.split(key).join(translated);
                            break;
                        } else if ((valNorm.endsWith('...') || valNorm.endsWith('…')) && valNorm.length >= 35) {
                            const cleanVal = valNorm.replace(/(\.\.\.|…)$/, '').trim().toLowerCase();
                            if (cleanVal.length >= 30 && key.toLowerCase().startsWith(cleanVal)) {
                                newVal = translated;
                                break;
                            }
                        }
                    }
                }

                if (!/[\\u4e00-\\u9fff]/.test(newVal) && node.parentElement && typeof node.parentElement.closest === 'function') {
                    const modeCard = node.parentElement.closest('[data-testid="mode-option-non-technical"], [data-testid="mode-option-developer"]');
                    if (modeCard) {
                        const isNonTech = modeCard.getAttribute('data-testid') === 'mode-option-non-technical';
                        const pid = (node.parentElement.getAttribute && node.parentElement.getAttribute('id')) || '';
                        const isDesc = pid.indexOf('-mode-description-') !== -1 || (node.parentElement.classList && node.parentElement.classList.contains('text-muted-foreground'));
                        if (isDesc) {
                            newVal = isNonTech
                                ? (USE_TW ? '隱藏開發者工具的精簡對話與任務協作介面。' : '隐藏开发者工具的精简对话与任务协作界面。')
                                : (USE_TW ? '提供程式碼編輯器、終端機等完整的開發者工具體驗。' : '提供代码编辑器、终端等完整的开发者工具体验。');
                        } else {
                            newVal = isNonTech
                                ? (USE_TW ? '精簡協作模式' : '精简协作模式')
                                : (USE_TW ? '完整開發者模式' : '完整开发者模式');
                        }
                    }
                }

                if (newVal !== originalVal) {
                    translatedValues.set(node, newVal);
                    node.nodeValue = newVal;
                }
            }
        } catch (e) {}
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    translateNode(n);
                }
            } else if (m.type === 'characterData') {
                translateNode(m.target);
            } else if (m.type === 'attributes') {
                if (m.target && m.target.nodeType === 1) {
                    translateElementAttrs(m.target);
                }
            }
        }
    });

    const obsOpts = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label', 'aria-valuetext', 'alt'] };

    const startEngine = () => {
        const target = document.body || document.documentElement;
        if (target) {
            try {
                observeRoot(target);
                translateNode(target);
            } catch (e) {}
        }
    };

    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() {
        const sr = origAttachShadow.apply(this, arguments);
        try { observeRoot(sr); translateNode(sr); } catch(e) {}
        return sr;
    };

    // 强力多阶段触发绑定
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEngine);
    } else {
        startEngine();
    }
    window.addEventListener('load', startEngine);
    setTimeout(startEngine, 100);
    setTimeout(startEngine, 300);
    setTimeout(startEngine, 1000);
    setTimeout(startEngine, 3000);
    setTimeout(startEngine, 6000);
})();
${SIGNATURE_END}`;

    return jsSource.replace("DICT_PLACEHOLDER", () => dictJson);
}

function cleanJsContent(content) {
    const regex = new RegExp(escapeRegExp(SIGNATURE_START) + "[\\s\\S]*?" + escapeRegExp(SIGNATURE_END), "g");
    return content.replace(regex, "");
}

function cleanMenuJsContent(content) {
    if (!content) return content;
    content = content.replace(/\n?\s*\/\* --- MENU TRANSLATION START --- \*\/[\s\S]*?\/\* --- MENU TRANSLATION END --- \*\//g, '');
    const legacyStart = "// ==========================================\n    // Antigravity Native Menu Chinese Translation";
    const endMark = "translateMenu(menu.items);";
    const startIdx = content.indexOf(legacyStart);
    const endIdx = content.indexOf(endMark);
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        return content.substring(0, startIdx) + content.substring(endIdx + endMark.length);
    }
    return content;
}

function cleanTrayJsContent(content) {
    content = content.replace(/\n\s*\/\* --- TRAY TRANSLATION START --- \*\/[\s\S]*?\/\* --- TRAY TRANSLATION END --- \*\//g, '');
    content = content.replace(/\n\s*\/\* --- TRAY DOUBLE CLICK START --- \*\/[\s\S]*?\/\* --- TRAY DOUBLE CLICK END --- \*\//g, '');
    return content;
}

function cleanUpdaterJsContent(content) {
    if (!content) return content;
    return content.replace(/\n?\s*\/\* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK START --- \*\/[\s\S]*?\/\* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK END --- \*\//g, '');
}

function inspectAsarStatus(asarPath) {
    if (!asarPath || !fs.existsSync(asarPath)) {
        return { valid: false, reason: 'missing', version: null, isLocalized: false, hasUpdaterHook: false, hasLatestUpdaterHook: false, installedLang: null };
    }
    try {
        const files = readFilesFromAsar(asarPath, ['dist/preload.js', 'dist/updater.js', 'package.json']);
        const preload = files['dist/preload.js'];
        const updater = files['dist/updater.js'];
        const pkgStr = files['package.json'];
        if (typeof preload !== 'string' || preload.length === 0 || typeof pkgStr !== 'string' || pkgStr.length === 0) {
            return { valid: false, reason: 'corrupt_or_incomplete', version: null, isLocalized: false, hasUpdaterHook: false, hasLatestUpdaterHook: false, installedLang: null };
        }
        const pkg = JSON.parse(pkgStr);
        const version = pkg && typeof pkg.version === 'string' ? pkg.version : '';
        if (!version) {
            return { valid: false, reason: 'missing_version', version: null, isLocalized: false, hasUpdaterHook: false, hasLatestUpdaterHook: false, installedLang: null };
        }
        const isLocalized = preload.includes(SIGNATURE_START);
        const installedLang = isLocalized ? (preload.includes('const USE_TW = true;') ? 'tw' : 'cn') : null;
        const hasUpdaterHook = typeof updater === 'string' ? updater.includes(UPDATER_HOOK_START) : true;
        const hasLatestUpdaterHook = typeof updater === 'string'
            ? (updater.includes(UPDATER_HOOK_START) && updater.includes(UPDATER_HOOK_VERSION_MARKER))
            : true;
        return { valid: true, reason: 'ok', version, isLocalized, hasUpdaterHook, hasLatestUpdaterHook, installedLang };
    } catch (e) {
        return { valid: false, reason: e.message || 'read_error', version: null, isLocalized: false, hasUpdaterHook: false, hasLatestUpdaterHook: false, installedLang: null };
    }
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let wasAppRunning = false;

function normalizeWinPathLower(p) {
    if (!p || typeof p !== 'string') return '';
    return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

function queryWin32ProcessDetails(imageNames) {
    if (process.platform !== 'win32' || !Array.isArray(imageNames) || imageNames.length === 0) return null;
    try {
        const wqlFilter = imageNames.map(n => `Name='${String(n).replace(/'/g, '')}'`).join(' OR ');
        const psCmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p=@(Get-CimInstance Win32_Process -Filter "${wqlFilter}" -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); if($p.Count -gt 0){$p | ConvertTo-Json -Compress}else{'[]'}`;
        const sysRoot = process.env.SystemRoot || 'C:\\Windows';
        const psExe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const exe = fs.existsSync(psExe) ? psExe : 'powershell.exe';
        const out = child_process.execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 8000
        }).trim();
        if (!out) return [];
        const parsed = JSON.parse(out);
        return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    } catch (_) {
        return null;
    }
}

function isUpdaterProcessRecord(proc) {
    if (!proc) return false;
    const name = String(proc.Name || '').toLowerCase();
    const exePath = String(proc.ExecutablePath || '').toLowerCase();
    const cmdLine = String(proc.CommandLine || '').toLowerCase();
    if (name === 'antigravity-x64.exe' || name === 'antigravity-arm64.exe' || name === 'uninstall antigravity.exe') return true;
    if (name === 'old-uninstaller.exe' && (exePath.includes('antigravity') || cmdLine.includes('keep_app_data') || cmdLine.includes('antigravity'))) return true;
    if (name === 'installer.exe' && (exePath.includes('antigravity-updater') || cmdLine.includes('antigravity'))) return true;
    if (name === 'elevate.exe' && (exePath.includes('antigravity') || cmdLine.includes('antigravity'))) return true;
    if (/^au_.*\.exe$/i.test(name) && (cmdLine.includes('keep_app_data') || cmdLine.includes('antigravity'))) return true;
    return false;
}

function isAppProcessInDir(proc, targetDirLower, selfPid) {
    if (!proc) return false;
    const pid = Number(proc.ProcessId);
    if (!pid || pid === selfPid) return false;
    const cmdLine = String(proc.CommandLine || '').toLowerCase();
    if (cmdLine.includes('localization_engine.js')) return false;
    const exePath = normalizeWinPathLower(proc.ExecutablePath || '');
    if (!targetDirLower) return true;
    if (exePath) {
        return exePath === `${targetDirLower}\\antigravity.exe` || exePath.startsWith(`${targetDirLower}\\`);
    }
    return cmdLine.includes(targetDirLower) || cmdLine.includes('--updated');
}

function getRunningStatus(targetInstallDir) {
    if (process.env.AG_SKIP_PROC_CHECK === '1') {
        return { appRunning: false, updaterRunning: false, appPids: [] };
    }
    let appRunning = false;
    let updaterRunning = false;
    const appPids = [];
    try {
        const selfPid = process.pid;
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fo csv /nh', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true
            });
            const candidateAppPids = [];
            let hasDirectInstallerImg = false;
            const inspectableUpdaterImgs = new Set();
            for (const line of stdout.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const parts = line.split('","');
                if (parts.length < 2) continue;
                const rawImgName = parts[0].replace(/^"/, '').trim();
                const imgName = rawImgName.toLowerCase();
                const pid = parseInt(parts[1].replace(/"/g, '').trim(), 10);
                if (imgName === 'antigravity.exe' && !isNaN(pid) && pid !== selfPid) {
                    candidateAppPids.push(pid);
                } else if (imgName === 'antigravity-x64.exe' || imgName === 'antigravity-arm64.exe' || imgName === 'uninstall antigravity.exe') {
                    hasDirectInstallerImg = true;
                } else if (imgName === 'installer.exe' || imgName === 'elevate.exe' || imgName === 'old-uninstaller.exe' || /^au_.*\.exe$/i.test(imgName)) {
                    inspectableUpdaterImgs.add(rawImgName);
                }
            }
            if (hasDirectInstallerImg) updaterRunning = true;

            const queryNames = [];
            if (candidateAppPids.length > 0) queryNames.push('Antigravity.exe');
            if (inspectableUpdaterImgs.size > 0 && !updaterRunning) queryNames.push(...inspectableUpdaterImgs);

            const targetDirLower = targetInstallDir ? normalizeWinPathLower(targetInstallDir) : '';
            if (queryNames.length > 0) {
                const details = queryWin32ProcessDetails(queryNames);
                if (Array.isArray(details)) {
                    for (const proc of details) {
                        const name = String(proc.Name || '').toLowerCase();
                        if (name === 'antigravity.exe') {
                            if (isAppProcessInDir(proc, targetDirLower, selfPid)) {
                                appRunning = true;
                                appPids.push(Number(proc.ProcessId));
                            }
                        } else if (!updaterRunning && isUpdaterProcessRecord(proc)) {
                            updaterRunning = true;
                        }
                    }
                } else if (candidateAppPids.length > 0) {
                    appRunning = true;
                    appPids.push(...candidateAppPids);
                }
            }
        } else if (process.platform === 'darwin') {
            const stdout = child_process.execSync(`pgrep -x Antigravity | grep -v "^${selfPid}$" || true`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            appRunning = stdout.trim().length > 0;
        }
    } catch (e) {
        // ignore
    }
    return { appRunning, updaterRunning, appPids };
}

function checkIfAppIsRunning(targetInstallDir) {
    const st = getRunningStatus(targetInstallDir);
    return st.appRunning || st.updaterRunning;
}

function sleepMs(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }
}

function closeAntigravityProcesses(options = {}) {
    const selfPid = process.pid;
    const targetInstallDir = options && options.installDir ? String(options.installDir) : '';
    const waitMs = (options && options.waitForExitMs) || 8000;
    let closedAny = false;
    try {
        if (process.platform === 'win32') {
            const targetImage = process.env.AG_TEST_TARGET_IMAGE || '';
            const targetDirLower = targetInstallDir ? normalizeWinPathLower(targetInstallDir) : '';

            const listTargetPids = () => {
                if (targetImage) {
                    try {
                        const out = child_process.execSync(`tasklist /fi "imagename eq ${targetImage}" /fo csv /nh`, {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'ignore'],
                            windowsHide: true
                        });
                        return out.split(/\r?\n/)
                            .filter(l => l.toLowerCase().includes(targetImage.toLowerCase()))
                            .map(l => parseInt(l.split('","')[1]?.replace(/"/g, '')?.trim(), 10))
                            .filter(pid => !isNaN(pid) && pid > 0 && pid !== selfPid);
                    } catch (_) {
                        return [];
                    }
                }

                const details = queryWin32ProcessDetails(['Antigravity.exe', 'language_server.exe']);
                if (Array.isArray(details)) {
                    const matched = [];
                    for (const proc of details) {
                        const pid = Number(proc.ProcessId);
                        if (!pid || pid === selfPid) continue;
                        const cmdLine = String(proc.CommandLine || '').toLowerCase();
                        if (cmdLine.includes('localization_engine.js')) continue;
                        const name = String(proc.Name || '').toLowerCase();
                        const exePath = normalizeWinPathLower(proc.ExecutablePath || '');
                        if (name === 'antigravity.exe') {
                            if (isAppProcessInDir(proc, targetDirLower, selfPid)) {
                                matched.push(pid);
                            }
                        } else if (name === 'language_server.exe') {
                            if (!targetDirLower || (exePath && exePath.startsWith(`${targetDirLower}\\`))) {
                                matched.push(pid);
                            }
                        }
                    }
                    return matched;
                }

                try {
                    const out = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /fo csv /nh', {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore'],
                        windowsHide: true
                    });
                    return out.split(/\r?\n/)
                        .filter(l => l.toLowerCase().includes('antigravity.exe'))
                        .map(l => parseInt(l.split('","')[1]?.replace(/"/g, '')?.trim(), 10))
                        .filter(pid => !isNaN(pid) && pid > 0 && pid !== selfPid);
                } catch (_) {
                    return [];
                }
            };

            let pids = listTargetPids();
            if (pids.length === 0) return false;

            closedAny = true;
            console.log(msg(
                `[關閉] 偵測到 ${pids.length} 個正在運行的 Antigravity 進程，正在強制關閉以解除檔案鎖定...`,
                `[关闭] 检测到 ${pids.length} 个正在运行的 Antigravity 进程，正在强制关闭以解除文件锁定...`
            ));
            for (const pid of pids) {
                try {
                    child_process.execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true });
                } catch (_) {}
            }

            const maxLoops = Math.max(10, Math.ceil(waitMs / 200));
            for (let i = 0; i < maxLoops; i++) {
                sleepMs(200);
                pids = listTargetPids();
                if (pids.length === 0) break;
                if (i % 5 === 4) {
                    for (const pid of pids) {
                        try {
                            child_process.execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', windowsHide: true });
                        } catch (_) {}
                    }
                }
            }
            sleepMs(450);
            console.log(msg(
                `[關閉] Antigravity 已完全關閉，檔案鎖定已解除。`,
                `[关闭] Antigravity 已完全关闭，文件锁定已解除。`
            ));
        } else if (process.platform === 'darwin') {
            const getMacPids = () => {
                try {
                    const out = child_process.execSync(`pgrep -x Antigravity | grep -v "^${selfPid}$" || true`, {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    });
                    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                } catch (_) {
                    return [];
                }
            };
            const pids = getMacPids();
            if (pids.length === 0) return false;
            closedAny = true;
            console.log(msg(
                `[關閉] 偵測到 ${pids.length} 個正在運行的 Antigravity 進程，正在強制關閉以解除檔案鎖定...`,
                `[关闭] 检测到 ${pids.length} 个正在运行的 Antigravity 进程，正在强制关闭以解除文件锁定...`
            ));
            try {
                child_process.execSync(`pgrep -x Antigravity | grep -v "^${selfPid}$" | xargs -r kill -9 2>/dev/null || true`);
            } catch (_) {}
            for (let i = 0; i < 20; i++) {
                sleepMs(200);
                if (getMacPids().length === 0) break;
            }
            sleepMs(300);
        }
    } catch (e) {
        // ignore
    }
    return closedAny;
}

function detectInstallationDir(manualDir) {
    if (manualDir) {
        if (fs.existsSync(manualDir)) {
            let resolved = path.resolve(manualDir);
            if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
                resolved = path.dirname(resolved);
            }
            return resolved;
        } else {
            console.error(`[错误] 手动指定的路径不存在: ${manualDir}`);
            process.exit(1);
        }
    }

    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = normalized.toLowerCase();
        if (!seenCandidates.has(key)) {
            candidates.push(normalized);
            seenCandidates.add(key);
        }
    };
    const hasAntigravityResources = (candidate) => {
        return fs.existsSync(path.join(candidate, "resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "resources", "app", "product.json"));
    };

    if (process.platform === 'win32') {
        addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
        addCandidate(process.env.ANTIGRAVITY_HOME);
        const localAppdata = process.env.LOCALAPPDATA;
        if (localAppdata) {
            addCandidate(path.join(localAppdata, 'Programs', 'antigravity'));
        }
        addCandidate("C:\\Program Files\\Antigravity");
        const driveLetters = ['C', 'D', 'E', 'F'];
        for (const drive of driveLetters) {
            addCandidate(`${drive}:\\Programs\\Antigravity`);
            addCandidate(`${drive}:\\Antigravity`);
        }

        for (const p of candidates) {
            if (fs.existsSync(p) && hasAntigravityResources(p)) {
                console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${p}`);
                return path.resolve(p);
            }
        }

        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const root of registryRoots) {
            try {
                const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
                for (const line of output.split(/\r?\n/)) {
                    const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!match) continue;
                    let value = match[2].trim().replace(/^"|"$/g, '');
                    if (/Antigravity\.exe/i.test(value)) {
                        value = path.dirname(value);
                    }
                    addCandidate(value);
                }
            } catch (e) {
                // Registry probing is best-effort; fall back to common locations below.
            }
        }
    } else if (process.platform === 'darwin') {
        addCandidate("/Applications/Antigravity.app");
        addCandidate(path.join(process.env.HOME || '', 'Applications', 'Antigravity.app'));
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            addCandidate(path.join('/Users', process.env.SUDO_USER, 'Applications', 'Antigravity.app'));
        }
    }

    for (const p of candidates) {
        if (fs.existsSync(p) && hasAntigravityResources(p)) {
            console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${p}`);
            return path.resolve(p);
        }
    }

    console.error("[错误] 未找到默认安装目录，请使用 --install-dir 手动指定您的安装路径！");
    process.exit(1);
}

function runCommandSync(cmd) {
    try {
        const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
        return { success: true, stdout: out, stderr: '' };
    } catch (e) {
        return { success: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
}

function cleanElectronCache() {
    let appSupportDir = "";
    if (process.platform === 'darwin') {
        let userHome = os.homedir();
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            const sudoHome = path.join('/Users', process.env.SUDO_USER);
            if (fs.existsSync(sudoHome)) {
                userHome = sudoHome;
            }
        }
        appSupportDir = path.join(userHome, 'Library', 'Application Support', 'Antigravity');
    } else if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        appSupportDir = path.join(appData, 'Antigravity');
    } else {
        appSupportDir = path.join(os.homedir(), '.config', 'Antigravity');
    }

    if (!fs.existsSync(appSupportDir)) return;

    const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache'];
    let cleanedCount = 0;
    for (const c of cacheDirs) {
        const p = path.join(appSupportDir, c);
        if (fs.existsSync(p)) {
            try {
                fs.rmSync(p, { recursive: true, force: true });
                cleanedCount++;
            } catch (e) {}
        }
    }
    if (cleanedCount > 0) {
        console.log(`[缓存] 已自动清理 ${cleanedCount} 个应用缓存目录，避免新旧版本字节码冲突。`);
    }
}

function resignAppOnMac(anyPath) {
    if (process.platform !== 'darwin') return;
    
    let targetApp = "";
    let current = path.resolve(anyPath);
    for (let i = 0; i < 10; i++) {
        if (current.endsWith(".app")) {
            targetApp = current;
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    
    if (targetApp && fs.existsSync(targetApp)) {
        try {
            runCommandSync(`xattr -cr "${targetApp}"`);
        } catch (e) {}
        console.log(`[签名] 检测到 macOS 平台，正在对应用包进行本地 ad-hoc 深度重签名: ${targetApp} ...`);
        const signRes = runCommandSync(`codesign --force --deep --sign - "${targetApp}"`);
        if (signRes.success) {
            console.log(`[签名] 重新签名成功！`);
        } else {
            console.warn(`[警告] 重新签名失败。可能会导致应用无法打开。详情:\n${signRes.stderr}\n${signRes.stdout}`);
        }
    } else {
        console.warn(`[警告] 未能从路径 ${anyPath} 识别到有效的 .app 路径，跳过重新签名。`);
    }
}

function ensureWritePermission(targetDir) {
    if (process.platform !== 'darwin') return true;
    try {
        fs.accessSync(targetDir, fs.constants.W_OK);
        return true;
    } catch (err) {
        if (process.getuid && process.getuid() !== 0) {
            console.log("[权限] 检测到当前用户对 macOS 应用目录缺少写入权限，正在尝试请求管理员权限 (sudo) 重新运行...");
            const args = process.argv.slice(1);
            const res = child_process.spawnSync('sudo', [process.execPath, ...args], {
                stdio: 'inherit'
            });
            if (res.status === 0) {
                process.exit(0);
            } else {
                console.error("\n[错误] 管理员提权执行失败或用户取消了密码输入。");
                process.exit(res.status || 1);
            }
        }
        return false;
    }
}

// ==========================================
// Antigravity 2.0 汉化引擎 (ASAR打包注入模式)
// ==========================================
function install20(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    const targetLang = USE_TW ? 'tw' : 'cn';
    const langDisplay = msg('繁體中文', '简体中文');

    if (!fs.existsSync(asarPath)) {
        console.error(msg(`[錯誤] 未在資源目錄中找到 app.asar: ${resourcesDir}`, `[错误] 未在资源目录中找到 app.asar: ${resourcesDir}`));
        return false;
    }

    const preloadedDict = loadDictionary();
    const dictCount = Object.keys(preloadedDict).length;
    if (dictCount < 100) {
        console.error(msg(
            `[錯誤] 字典條目過少 (${dictCount} 條)，請確認 ${DICTS_FOLDER}/ 目錄完整，已拒絕注入以防覆寫！`,
            `[错误] 字典条目过少 (${dictCount} 条)，请确认 ${DICTS_FOLDER}/ 目录完整，已拒绝注入以防覆盖！`
        ));
        return false;
    }

    // 1. 備份與官方更新／語系切換檢測（不先覆寫 app.asar，直接從乾淨基底讀取）
    const asarStatus = inspectAsarStatus(asarPath);
    if (!asarStatus.valid) {
        console.error(msg(
            `[錯誤] app.asar 結構不完整或正在被更新程式寫入 (${asarStatus.reason})，已取消本次操作。`,
            `[错误] app.asar 结构不完整或正在被更新程序写入 (${asarStatus.reason})，已取消本次操作。`
        ));
        return false;
    }

    if (
        IS_IF_NEEDED &&
        asarStatus.isLocalized &&
        asarStatus.installedLang === targetLang &&
        (process.platform !== 'win32' || IS_NO_GUARD || asarStatus.hasLatestUpdaterHook)
    ) {
        console.log(msg(
            `[略過] 目前版本 (${asarStatus.version}) 已包含完整${langDisplay}漢化與更新自動偵測引擎。`,
            `[跳过] 当前版本 (${asarStatus.version}) 已包含完整${langDisplay}汉化与更新自动检测引擎。`
        ));
        return true;
    }

    if (asarStatus.isLocalized && asarStatus.installedLang && asarStatus.installedLang !== targetLang) {
        console.log(msg(
            `[語系] 偵測到目標語系變更 (${asarStatus.installedLang} -> ${targetLang})，將切換並重新封裝${langDisplay}...`,
            `[语系] 检测到目标语系变更 (${asarStatus.installedLang} -> ${targetLang})，将切换并重新封装${langDisplay}...`
        ));
    }

    let sourceAsarPath = asarPath;
    if (!asarStatus.isLocalized) {
        console.log(msg(
            `[備份] 偵測到全新官方原版 (${asarStatus.version})，正在同步建立官方備份包: ${bakPath} ...`,
            `[备份] 检测到全新官方原版 (${asarStatus.version})，正在同步创建官方备份包: ${bakPath} ...`
        ));
        try {
            fs.copyFileSync(asarPath, bakPath);
            console.log(msg(`[備份] 備份成功！`, `[备份] 备份成功！`));
        } catch (e) {
            console.error(msg(`[錯誤] 建立備份失敗: ${e.message}`, `[错误] 创建备份失败: ${e.message}`));
            return false;
        }
        sourceAsarPath = asarPath;
    } else if (fs.existsSync(bakPath)) {
        const bakStatus = inspectAsarStatus(bakPath);
        if (bakStatus.valid && !bakStatus.isLocalized && bakStatus.version === asarStatus.version) {
            console.log(msg(
                `[還原] 偵測到同版本 (${asarStatus.version}) 官方備份包，將直接以此作為乾淨注入來源...`,
                `[还原] 检测到同版本 (${asarStatus.version}) 官方备份包，将直接以此作为干净注入来源...`
            ));
            sourceAsarPath = bakPath;
        } else {
            console.log(msg(
                `[清理] 偵測到版本不符或損毀的舊備份 (${bakStatus.version || 'invalid'} vs ${asarStatus.version})，已移除並以目前包為來源。`,
                `[清理] 检测到版本不符或损坏的旧备份 (${bakStatus.version || 'invalid'} vs ${asarStatus.version})，已移除并以当前包为来源。`
            ));
            try { fs.unlinkSync(bakPath); } catch (_) {}
            sourceAsarPath = asarPath;
        }
    }

    // 2. 記憶體手術式提取 6 個核心檔案
    console.log(msg(`[解包] 正在使用純 JS ASAR 手術式引擎讀取模組...`, `[解包] 正在使用纯 JS ASAR 手术式引擎读取模块...`));
    const targetFiles = [
        'dist/preload.js',
        'dist/menu.js',
        'dist/tray.js',
        'dist/loadingOverlay.js',
        'dist/updater.js',
        'dist/main.js'
    ];
    let extracted;
    try {
        extracted = readFilesFromAsar(sourceAsarPath, targetFiles);
    } catch (e) {
        console.error(msg(`[錯誤] 讀取 app.asar 失敗: ${e.message}`, `[错误] 读取 app.asar 失败: ${e.message}`));
        return false;
    }

    if (!extracted['dist/preload.js']) {
        console.error(msg(`[錯誤] 未在 app.asar 中找到 dist/preload.js`, `[错误] 未在 app.asar 中找到 dist/preload.js`));
        return false;
    }

    const replacements = {};

    // 3. 注入 preload.js
    console.log(msg(`[修改] 正在向 preload.js 注入${langDisplay}中文化程式碼...`, `[修改] 正在向 preload.js 注入${langDisplay}汉化代码...`));
    const cleanedPreload = cleanJsContent(extracted['dist/preload.js']);
    const translationJs = generateJs(preloadedDict);
    replacements['dist/preload.js'] = cleanedPreload + "\n" + translationJs;
    console.log(msg(`[修改] preload.js 注入完成！`, `[修改] preload.js 注入完成！`));

    // 3.1 注入 menu.js
    if (extracted['dist/menu.js']) {
        console.log(`[修改] 正在向 menu.js 注入選單中文化...`);
        const menuCleaned = cleanMenuJsContent(extracted['dist/menu.js']);
        const menuTranslationJs = `
    /* --- MENU TRANSLATION START --- */
    // ==========================================
    // Antigravity Native Menu Chinese Translation
    // ==========================================
    const translations = ${USE_TW ? `{
        'File': '檔案',
        'Edit': '編輯',
        'View': '檢視',
        'Window': '視窗',
        'Help': '說明',
        'New Window': '開新視窗',
        'Create Project': '建立專案',
        'Command Palette': '命令選擇區',
        'Docs': '說明文件',
        'Check for Updates': '檢查更新',
        'Toggle Developer Tools': '切換開發人員工具',
        'Undo': '復原',
        'Redo': '重做',
        'Cut': '剪下',
        'Copy': '複製',
        'Paste': '貼上',
        'Select All': '全選',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '關閉',
        'Zoom': '縮放',
        'Reset Zoom': '重設縮放',
        'Zoom In': '放大',
        'Zoom Out': '縮小',
        'Toggle Full Screen': '切換全螢幕',
        'Toggle Between Light/Dark Themes': '切換淺色/深色佈景主題',
        'Split Terminal': '分割終端機',
        'Split Conversation Horizontally': '水平分割對話',
        'Split Conversation Vertically': '垂直分割對話',
        'Split': '分割',
        'Split Right': '向右分割',
        'Split Down': '向下分割',
        'Replace With New': '替換為新對話',
        'Show in File Explorer': '在檔案總管中顯示',
        'Reveal in Finder': '在 Finder 中顯示',
        'Find in conversation': '在對話中尋找',
        'Preferences': '偏好設定',
        'Settings': '設定',
        'Keyboard Shortcuts': '鍵盤快速鍵',
        'About Antigravity': '關於 Antigravity',
        'Services': '服務',
        'Hide Antigravity': '隱藏 Antigravity',
        'Hide Others': '隱藏其他',
        'Show All': '顯示全部',
        'Quit Antigravity': '結束 Antigravity',
        'Quit': '結束',
        'Exit': '結束',
        'Reload': '重新載入',
        'Force Reload': '強制重新載入',
        'Actual Size': '實際大小',
        'Close Window': '關閉視窗',
        'Close Tab': '關閉分頁',
        'Reopen Closed Tab': '重新開啟已關閉的分頁',
        'Connect to WSL': '連線至 WSL',
        'Connect to WSL in New Window': '在新視窗中連線至 WSL',
        'Connect to Host': '連線至主機',
        'Connect to Host in New Window': '在新視窗中連線至主機',
        'Version': '版本'
    }` : `{
        'File': '文件',
        'Edit': '编辑',
        'View': '视图',
        'Window': '窗口',
        'Help': '帮助',
        'New Window': '新建窗口',
        'Create Project': '创建项目',
        'Command Palette': '命令面板',
        'Docs': '文档',
        'Check for Updates': '检查更新',
        'Toggle Developer Tools': '切换开发者工具',
        'Undo': '撤销',
        'Redo': '重做',
        'Cut': '剪切',
        'Copy': '复制',
        'Paste': '粘贴',
        'Select All': '全选',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '关闭',
        'Zoom': '缩放',
        'Reset Zoom': '重置缩放',
        'Zoom In': '放大',
        'Zoom Out': '缩小',
        'Toggle Full Screen': '切换全屏',
        'Toggle Between Light/Dark Themes': '切换浅色/深色主题',
        'Split Terminal': '拆分终端',
        'Split Conversation Horizontally': '水平拆分会话',
        'Split Conversation Vertically': '垂直拆分会话',
        'Split': '拆分',
        'Split Right': '向右拆分',
        'Split Down': '向下拆分',
        'Replace With New': '替换为新会话',
        'Show in File Explorer': '在文件资源管理器中显示',
        'Reveal in Finder': '在访达中显示',
        'Find in conversation': '在会话中查找',
        'Preferences': '首选项',
        'Settings': '设置',
        'Keyboard Shortcuts': '键盘快捷键',
        'About Antigravity': '关于 Antigravity',
        'Services': '服务',
        'Hide Antigravity': '隐藏 Antigravity',
        'Hide Others': '隐藏其他',
        'Show All': '显示全部',
        'Quit Antigravity': '退出 Antigravity',
        'Quit': '退出',
        'Exit': '退出',
        'Reload': '重新加载',
        'Force Reload': '强制重新加载',
        'Actual Size': '实际大小',
        'Close Window': '关闭窗口',
        'Close Tab': '关闭标签页',
        'Reopen Closed Tab': '重新打开关闭的标签页',
        'Connect to WSL': '连接到 WSL',
        'Connect to WSL in New Window': '在新窗口中连接到 WSL',
        'Connect to Host': '连接到主机',
        'Connect to Host in New Window': '在新窗口中连接到主机',
        'Version': '版本'
    }`};
    function translateMenu(items) {
        for (const item of items) {
            let label = item.label || '';
            let mnemonic = '';
            let cleanLabel = label;
            const m = label.match(/&([a-zA-Z])/);
            if (m) {
                mnemonic = "(&" + m[1] + ")";
                cleanLabel = label.replace('&', '');
            }
            if (translations[cleanLabel]) {
                item.label = translations[cleanLabel] + mnemonic;
            } else if (translations[label]) {
                item.label = translations[label];
            } else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? "版本 " + v : "版本");
            }
            if (item.submenu && item.submenu.items) {
                translateMenu(item.submenu.items);
            }
        }
    }
    Object.assign(translations, ${USE_TW ? `{
        'New Window': '新增視窗',
        'Docs': '官方文件',
        'Connect to WSL': '連線至 WSL',
        'Connect to WSL Distro': '連線至 WSL 發行版',
        'Reopen Locally': '在本機重新開啟',
        'Check for Updates': '檢查更新',
        'Checking for Updates...': '正在檢查更新...',
        'Downloading Update...': '正在下載更新...',
        'Restart to Update': '重新啟動以更新',
        'Inspect Element': '檢查元素',
        'Services': '服務'
    }` : `{
        'New Window': '新建窗口',
        'Docs': '官方文档',
        'Connect to WSL': '连接到 WSL',
        'Connect to WSL Distro': '连接到 WSL 发行版',
        'Reopen Locally': '在本地重新打开',
        'Check for Updates': '检查更新',
        'Checking for Updates...': '正在检查更新...',
        'Downloading Update...': '正在下载更新...',
        'Restart to Update': '重启以更新',
        'Inspect Element': '检查元素',
        'Services': '服务'
    }`});
    if (menu && Array.isArray(menu.items)) {
        const origItemsFind = menu.items.find.bind(menu.items);
        menu.items.find = function(pred, thisArg) {
            const res = origItemsFind(pred, thisArg);
            if (res) return res;
            if (typeof pred === 'function') {
                return origItemsFind((it) => it && (it.label === '檔案' || it.label === '檔案(&F)' || it.label === '文件' || it.label === '文件(&F)') && (() => { try { return pred({ ...it, label: 'File' }) || pred({ ...it, label: '&File' }); } catch (e) { return false; } })(), thisArg);
            }
            return res;
        };
        const fileItem = origItemsFind((it) => it && (it.label === 'File' || it.label === '&File'));
        if (fileItem && fileItem.submenu && typeof fileItem.submenu.insert === 'function') {
            const origInsert = fileItem.submenu.insert.bind(fileItem.submenu);
            fileItem.submenu.insert = function(pos, mi) {
                try { if (mi) translateMenu([mi]); } catch (e) {}
                return origInsert(pos, mi);
            };
        }
    }
    translateMenu(menu.items);
    /* --- MENU TRANSLATION END --- */
    `;
        const targetStr = "electron_1.Menu.setApplicationMenu(menu);";
        const idx = menuCleaned.indexOf(targetStr);
        if (idx !== -1) {
            replacements['dist/menu.js'] = menuCleaned.substring(0, idx) + menuTranslationJs + "\n    " + menuCleaned.substring(idx);
            console.log(`[修改] 選單中文化注入完成！`);
        }
    }

    // 3.2 注入 tray.js
    if (extracted['dist/tray.js']) {
        console.log(`[修改] 正在向 tray.js 注入系統匣中文化...`);
        let trayCleaned = cleanTrayJsContent(extracted['dist/tray.js']);
        const targetCreate = /function\s+createTray\s*\(([^)]*)\)\s*\{/;
        const replacementCreate = (match, args) => `function createTray(${args}) {
    /* --- TRAY TRANSLATION START --- */
    const translations = ${USE_TW ? `{
        'No agents running': '無執行中的代理',
        'Open Antigravity': '開啟 Antigravity',
        'Quit': '結束'
    }` : `{
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开 Antigravity',
        'Quit': '退出'
    }`};
    for (const item of actions) {
        if (!item || !item.label) continue;
        if (translations[item.label]) {
            item.label = translations[item.label];
        } else if (item.label.startsWith('Open ')) {
            item.label = (USE_TW ? '開啟 ' : '打开 ') + item.label.slice(5);
        } else if (item.label === 'Quit') {
            item.label = USE_TW ? '結束' : '退出';
        }
    }
    /* --- TRAY TRANSLATION END --- */`;
        let trayPatched = trayCleaned.replace(targetCreate, replacementCreate);
        const countRegex = /countItem\.label\s*=\s*\([\s\S]*?' running';/g;
        const replacementCount = USE_TW 
            ? "countItem.label = count > 0 ? `${count} 個代理執行中` : '無執行中的代理';"
            : "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';";
        trayPatched = trayPatched.replace(countRegex, replacementCount);
        replacements['dist/tray.js'] = trayPatched;
        console.log(`[修改] 系統匣中文化注入完成！`);
    }

    // 3.3 注入 loadingOverlay.js
    if (extracted['dist/loadingOverlay.js']) {
        let loadingContent = extracted['dist/loadingOverlay.js'];
        const replacementText = USE_TW
            ? '<div class="text">正在載入 Antigravity…</div>'
            : '<div class="text">正在加载 Antigravity…</div>';
        loadingContent = loadingContent
            .replace('<div class="text">Loading Antigravity</div>', replacementText)
            .replace('<div class="text">反重力引擎已啟動，正在努力擺脫地心引力...</div>', replacementText)
            .replace('<div class="text">反重力引擎已启动，正在努力摆脱地心引力...</div>', replacementText);
        replacements['dist/loadingOverlay.js'] = loadingContent;
    }

    // 3.4 注入 updater.js 與 main.js 原生對話框
    if (extracted['dist/updater.js']) {
        let updaterContent = cleanUpdaterJsContent(extracted['dist/updater.js']);
        const targetOptions = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;
        const replacementOptions = USE_TW
            ? `                title: '檢查更新',
                message: '目前沒有可用的更新',
                buttons: ['確定'],`
            : `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`;
        updaterContent = updaterContent.replace(targetOptions, replacementOptions);
        const targetMenuStep = `    MenuUpdateStep["CheckForUpdates"] = "Check for Updates";
    MenuUpdateStep["CheckingForUpdates"] = "Checking for Updates...";
    MenuUpdateStep["DownloadingUpdate"] = "Downloading Update...";
    MenuUpdateStep["RestartToUpdate"] = "Restart to Update";`;
        const replacementMenuStep = USE_TW
            ? `    MenuUpdateStep["CheckForUpdates"] = "檢查更新";
    MenuUpdateStep["CheckingForUpdates"] = "正在檢查更新...";
    MenuUpdateStep["DownloadingUpdate"] = "正在下載更新...";
    MenuUpdateStep["RestartToUpdate"] = "重新啟動以更新";`
            : `    MenuUpdateStep["CheckForUpdates"] = "检查更新";
    MenuUpdateStep["CheckingForUpdates"] = "正在检查更新...";
    MenuUpdateStep["DownloadingUpdate"] = "正在下载更新...";
    MenuUpdateStep["RestartToUpdate"] = "重启以更新";`;
        updaterContent = updaterContent.replace(targetMenuStep, replacementMenuStep);

        const updaterHookBody = String.raw`
/* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK START --- */
/* TW-GUARD-V2 */
;(function () {
    try {
        const _fs = require('fs');
        const _path = require('path');
        const _os = require('os');
        const _cp = require('child_process');
        let _watchdogSpawned = false;
        function _appendHookLog(guardDir, text) {
            try {
                if (!_fs.existsSync(guardDir)) return;
                const ts = new Date().toISOString();
                _fs.appendFileSync(_path.join(guardDir, 'guard.log'), '[' + ts + '] [HOOK] ' + text + '\n', 'utf8');
            } catch (_e) {}
        }
        function _spawnLocalizationUpdateWatchdog(isSilentMode, shouldAutoRelaunch) {
            if (_watchdogSpawned || process.platform !== 'win32') return false;
            const updaterObj = electron_updater_1 && electron_updater_1.autoUpdater;
            if (!updaterObj || !updaterObj.installerPath) return false;
            const localAppData = process.env.LOCALAPPDATA || _path.join(_os.homedir(), 'AppData', 'Local');
            if (!localAppData) return false;
            const guardDir = _path.join(localAppData, 'antigravity-localization');
            const enginePath = _path.join(guardDir, 'localization_engine.js');
            const watchdogVbs = _path.join(guardDir, 'update_watchdog.vbs');
            if (!_fs.existsSync(enginePath) || !_fs.existsSync(watchdogVbs)) return false;
            const sysRoot = process.env.SystemRoot || 'C:\\Windows';
            let wscriptExe = _path.join(sysRoot, 'System32', 'wscript.exe');
            if (!_fs.existsSync(wscriptExe)) wscriptExe = 'wscript.exe';
            const installDir = _path.dirname(process.execPath);
            if (!isSilentMode) {
                updaterObj.autoRunAppAfterInstall = false;
            }
            const vbsArgs = ['//B', '//Nologo', watchdogVbs, installDir, String(process.pid), shouldAutoRelaunch ? '1' : '0'];
            const envCopy = Object.assign({}, process.env);
            delete envCopy.ELECTRON_RUN_AS_NODE;
            delete envCopy.ATOM_SHELL_INTERNAL_RUN_AS_NODE;
            const child = _cp.spawn(wscriptExe, vbsArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                cwd: localAppData,
                env: envCopy
            });
            if (child && typeof child.unref === 'function') child.unref();
            _watchdogSpawned = true;
            _appendHookLog(guardDir, 'Watchdog armed (pid=' + process.pid + ', silent=' + isSilentMode + ', relaunch=' + shouldAutoRelaunch + ')');
            console.log('[AutoUpdater][TW-Guard] Post-update localization watchdog armed (relaunch=' + shouldAutoRelaunch + ', silent=' + isSilentMode + ')');
            return true;
        }
        if (electron_updater_1 && electron_updater_1.autoUpdater && typeof electron_updater_1.autoUpdater.quitAndInstall === 'function') {
            const _origQuitAndInstall = electron_updater_1.autoUpdater.quitAndInstall.bind(electron_updater_1.autoUpdater);
            electron_updater_1.autoUpdater.quitAndInstall = function (isSilent, isForceRunAfter) {
                const silentFlag = Boolean(isSilent);
                const shouldAutoRelaunch = !silentFlag || Boolean(isForceRunAfter);
                const effectiveForceRun = (silentFlag && isForceRunAfter) ? false : isForceRunAfter;
                let spawned = false;
                try {
                    spawned = _spawnLocalizationUpdateWatchdog(silentFlag, shouldAutoRelaunch);
                } catch (_e) {}
                const res = _origQuitAndInstall(isSilent, effectiveForceRun);
                try {
                    if (spawned && electron_updater_1.autoUpdater && !electron_updater_1.autoUpdater.quitAndInstallCalled) {
                        setTimeout(function () { _watchdogSpawned = false; }, 1000);
                    }
                } catch (_e) {}
                return res;
            };
        }
    } catch (_err) {}
})();
/* --- ANTIGRAVITY UPDATE AUTO-DETECT HOOK END --- */`;
        replacements['dist/updater.js'] = updaterContent.trimEnd() + "\n" + updaterHookBody + "\n";
        console.log(msg(`[修改] updater.js 更新自動偵測 Hook 與對話框中文化完成！`, `[修改] updater.js 更新自动检测 Hook 与对话框汉化完成！`));
    }

    if (extracted['dist/main.js']) {
        let mainContent = extracted['dist/main.js'];
        const targetQuit = `        buttons: ['Cancel', 'Quit'],
        defaultId: 1,
        cancelId: 0,
        title: 'Confirm Quit',
        message: 'Are you sure you want to quit?',
        detail: 'There may be agents or background tasks running.',`;
        const replaceQuit = USE_TW
            ? `        buttons: ['取消', '結束'],
        defaultId: 1,
        cancelId: 0,
        title: '確認結束',
        message: '確定要結束 Antigravity 嗎？',
        detail: '目前可能仍有代理程式或背景任務正在執行中。',`
            : `        buttons: ['取消', '退出'],
        defaultId: 1,
        cancelId: 0,
        title: '确认退出',
        message: '确定要退出 Antigravity 吗？',
        detail: '当前可能仍有智能体或后台任务正在运行。',`;
        mainContent = mainContent.replace(targetQuit, replaceQuit);
        const targetWsl = `title: 'WSL distro not found',`;
        const replaceWsl = USE_TW ? `title: '找不到 WSL 發行版',` : `title: '未找到 WSL 发行版',`;
        mainContent = mainContent.replace(targetWsl, replaceWsl);
        const targetWslMsg = 'message: `The WSL distro "${WSL_DISTRO}" is no longer installed.`,';
        const replaceWslMsg = USE_TW
            ? 'message: `WSL 發行版「${WSL_DISTRO}」已不再安裝。`,'
            : 'message: `WSL 发行版“${WSL_DISTRO}”已不再安装。`,';
        mainContent = mainContent.replace(targetWslMsg, replaceWslMsg);
        const targetWslDetail = `detail: 'Antigravity opened on Windows instead.',`;
        const replaceWslDetail = USE_TW ? `detail: '已改為在 Windows 環境開啟 Antigravity。',` : `detail: '已改为在 Windows 中打开 Antigravity。',`;
        mainContent = mainContent.replace(targetWslDetail, replaceWslDetail);
        mainContent = mainContent.replace(
            `showErrorBox('WSL setup failed', msg)`,
            USE_TW ? `showErrorBox('WSL 設定失敗', msg)` : `showErrorBox('WSL 设置失败', msg)`
        );
        mainContent = mainContent.replace(
            `showErrorBox('Binary not found', msg)`,
            USE_TW ? `showErrorBox('找不到執行檔', msg)` : `showErrorBox('未找到可执行文件', msg)`
        );
        mainContent = mainContent.replace(
            `showErrorBox('Startup failed', msg)`,
            USE_TW ? `showErrorBox('啟動失敗', msg)` : `showErrorBox('启动失败', msg)`
        );
        replacements['dist/main.js'] = mainContent;
    }

    // 4. 手術式重新封裝 ASAR（優先原子替換，自動／接管模式嚴禁熱覆寫）
    console.log(msg(`[封裝] 正在應用手術式增量封裝寫入 app.asar...`, `[封装] 正在应用手术式增量封装写入 app.asar...`));
    const tempAsarPath = asarPath + '.tmp.' + process.pid;
    let hotOverwritten = false;
    try {
        surgicalPatchAsar(sourceAsarPath, tempAsarPath, replacements);
        const installDirFromRes = path.dirname(resourcesDir);
        const maxRenameTries = IS_AUTO_MODE ? 1 : (IS_TAKEOVER_POST_UPDATE ? 10 : 5);
        let renamed = false;
        let lastRenameErr = null;
        for (let attempt = 1; attempt <= maxRenameTries; attempt++) {
            try {
                fs.renameSync(tempAsarPath, asarPath);
                renamed = true;
                break;
            } catch (renameErr) {
                lastRenameErr = renameErr;
                const isLockErr = renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY' || renameErr.code === 'EACCES');
                if (!isLockErr || attempt === maxRenameTries) {
                    break;
                }
                if (IS_TAKEOVER_POST_UPDATE) {
                    closeAntigravityProcesses({ installDir: installDirFromRes, waitForExitMs: 5000 });
                }
                sleepMs(400);
            }
        }
        if (!renamed) {
            const isLockErr = lastRenameErr && (lastRenameErr.code === 'EPERM' || lastRenameErr.code === 'EBUSY' || lastRenameErr.code === 'EACCES');
            if (!isLockErr) {
                throw lastRenameErr;
            }
            if (IS_AUTO_MODE || IS_TAKEOVER_POST_UPDATE) {
                throw new Error(msg(
                    `目標 app.asar 正被鎖定 (${lastRenameErr.code})，自動或更新接管模式禁止熱覆寫，已安全取消。`,
                    `目标 app.asar 正被锁定 (${lastRenameErr.code})，自动或更新接管模式禁止热覆盖，已安全取消。`
                ));
            }
            fs.copyFileSync(tempAsarPath, asarPath);
            try { fs.unlinkSync(tempAsarPath); } catch (_) {}
            hotOverwritten = true;
        }
    } catch (e) {
        if (fs.existsSync(tempAsarPath)) {
            try { fs.unlinkSync(tempAsarPath); } catch (_) {}
        }
        console.error(msg(`[錯誤] 寫入 app.asar 失敗: ${e.message}`, `[错误] 写入 app.asar 失败: ${e.message}`));
        return false;
    }

    cleanElectronCache();
    resignAppOnMac(resourcesDir);
    if (hotOverwritten) {
        console.log(msg(
            `\n[警告] 偵測到 Antigravity 正在運行，已於相容模式下寫入${langDisplay}漢化。`,
            `\n[警告] 检测到 Antigravity 正在运行，已在兼容模式下写入${langDisplay}汉化。`
        ));
        console.log(msg(
            `[警告] 由於檔案偏移已變更，請立即將所有 Antigravity 視窗完全關閉後再重新開啟（重啟前請勿開新視窗）。`,
            `[警告] 由于文件偏移已变更，请立即将所有 Antigravity 窗口完全关闭后再重新打开（重启前请勿开新窗口）。`
        ));
    }
    console.log(msg(`[√] Antigravity 2.0 ${langDisplay}漢化套用完成！`, `[√] Antigravity 2.0 ${langDisplay}汉化部署完成！`));
    return true;
}

function restore20(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (IS_AUTO_MODE && checkIfAppIsRunning(path.dirname(resourcesDir))) {
        console.log(msg("[跳過] 自動模式下偵測到 Antigravity 正在運行，取消還原操作。", "[跳过] 自动模式下检测到 Antigravity 正在运行，取消还原操作。"));
        return false;
    }

    const asarStatus = inspectAsarStatus(asarPath);
    if (asarStatus.valid && !asarStatus.isLocalized && !asarStatus.hasUpdaterHook) {
        if (fs.existsSync(bakPath)) {
            try { fs.unlinkSync(bakPath); } catch (_) {}
        }
        console.log(msg(`[還原] 目前 app.asar (${asarStatus.version}) 已是官方原版，無需還原。`, `[还原] 当前 app.asar (${asarStatus.version}) 已是官方原版，无需还原。`));
        return true;
    }

    if (!fs.existsSync(bakPath)) {
        console.log(msg("[!] 未找到備份檔案 app.asar.bak，可能尚未安裝過漢化或備份被刪除。", "[!] 未找到备份文件 app.asar.bak，可能尚未安装过汉化或备份被删除。"));
        return false;
    }

    const bakStatus = inspectAsarStatus(bakPath);
    if (!bakStatus.valid) {
        console.error(msg("[錯誤] app.asar.bak 已損毀，已拒絕還原以避免覆蓋正常程式！", "[错误] app.asar.bak 已损坏，已拒绝还原以避免覆盖正常程序！"));
        return false;
    }
    if (asarStatus.valid && bakStatus.version !== asarStatus.version) {
        console.error(msg(
            `[錯誤] 備份版本 (${bakStatus.version}) 與目前版本 (${asarStatus.version}) 不符，已拒絕降級覆寫並清除過期備份！`,
            `[错误] 备份版本 (${bakStatus.version}) 与当前版本 (${asarStatus.version}) 不符，已拒绝降级覆盖并清除过期备份！`
        ));
        try { fs.unlinkSync(bakPath); } catch (_) {}
        return false;
    }

    console.log(msg("[還原] 正在用官方備份檔案恢復...", "[还原] 正在用官方备份文件恢复..."));
    try {
        try {
            fs.renameSync(bakPath, asarPath);
        } catch (renameErr) {
            const isLockErr = renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY' || renameErr.code === 'EACCES');
            if (!isLockErr || IS_AUTO_MODE) {
                throw renameErr;
            }
            fs.copyFileSync(bakPath, asarPath);
            try { fs.unlinkSync(bakPath); } catch (_) {}
        }
    } catch (e) {
        console.error(msg(`[錯誤] 恢復備份失敗: ${e.message}`, `[错误] 恢复备份失败: ${e.message}`));
        if (process.platform === 'darwin' && e.code === 'EPERM') {
            console.error(msg(`[提示] macOS 寫入受限，請使用管理員權限執行腳本。`, `[提示] macOS 写入受限，请使用管理员权限运行脚本。`));
        }
        return false;
    }
    cleanElectronCache();
    resignAppOnMac(resourcesDir);
    console.log(msg("[√] 官方 app.asar 已成功還原！", "[√] 官方 app.asar 已成功恢复！"));
    return true;
}

// ==========================================
// Antigravity 1.0 汉化引擎 (旧版 HTML 注入模式)
// ==========================================
const OLD_TARGET_FILES = [
    path.join("resources", "app", "out", "vs", "code", "electron-browser", "workbench", "workbench-jetski-agent.html"),
    path.join("resources", "app", "out", "vs", "code", "electron-browser", "workbench", "workbench.html")
];

function backupFiles10(installDir) {
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        const bakPath = absPath + ".bak";
        if (fs.existsSync(absPath) && !fs.existsSync(bakPath)) {
            fs.copyFileSync(absPath, bakPath);
            console.log(`[备份] 已创建旧版 HTML 备份: ${path.basename(absPath)}.bak`);
        }
    }
}

function injectHtml10(installDir, htmlRelPath) {
    const absPath = path.join(installDir, htmlRelPath);
    if (!fs.existsSync(absPath)) return false;
    
    let content = fs.readFileSync(absPath, 'utf-8');
    
    const injectStr = '<script src="../../../../ag_agent_hanhua.js"></script>';
    content = content.replace(/<script.*ag_agent_hanhua\.js.*><\/script>/g, '');
    
    if (content.includes('</body>')) {
        content = content.replace('</body>', `${injectStr}</body>`);
    } else {
        content += injectStr;
    }
        
    fs.writeFileSync(absPath, content, 'utf-8');
    return true;
}

function updateChecksums10(installDir) {
    const productJsonPath = path.join(installDir, "resources", "app", "product.json");
    if (!fs.existsSync(productJsonPath)) return;
    
    const data = JSON.parse(fs.readFileSync(productJsonPath, 'utf-8'));
    
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        if (fs.existsSync(absPath)) {
            const key = relPath.replace(/\\/g, "/").replace("resources/app/out/", "");
            
            const fileBuffer = fs.readFileSync(absPath);
            const hash = crypto.createHash('sha256').update(fileBuffer).digest();
            data.checksums[key] = hash.toString('base64').replace(/=/g, '');
        }
    }
    
    fs.writeFileSync(productJsonPath, JSON.stringify(data, null, '\t'), 'utf-8');
}

function install10(installDir) {
    console.log("====== 检测到 Antigravity 1.0 架构，正在使用 HTML 注入引擎 ======");
    backupFiles10(installDir);
    
    // 生成单独的 js 汉化文件
    const hanhuaJsPath = path.join(installDir, "resources", "app", "out", "ag_agent_hanhua.js");
    fs.mkdirSync(path.dirname(hanhuaJsPath), { recursive: true });
    
    const jsContent = generateJs();
    fs.writeFileSync(hanhuaJsPath, jsContent, 'utf-8');
        
    for (const html of OLD_TARGET_FILES) {
        if (injectHtml10(installDir, html)) {
            console.log(`[√] 注入成功: ${path.basename(html)}`);
        }
    }
            
    updateChecksums10(installDir);
    resignAppOnMac(installDir);
    console.log("[√] Antigravity 1.0 汉化部署完成！");
    return true;
}

function restore10(installDir) {
    console.log("====== 正在恢复 Antigravity 1.0 官方原版 ======");
    let changed = false;
    for (const relPath of OLD_TARGET_FILES) {
        const absPath = path.join(installDir, relPath);
        const bakPath = absPath + ".bak";
        if (fs.existsSync(bakPath)) {
            fs.copyFileSync(bakPath, absPath);
            fs.unlinkSync(bakPath);
            console.log(`[还原] 已恢复 HTML: ${path.basename(absPath)}`);
            changed = true;
        }
    }
    
    const hanhuaJsPath = path.join(installDir, "resources", "app", "out", "ag_agent_hanhua.js");
    if (fs.existsSync(hanhuaJsPath)) {
        fs.unlinkSync(hanhuaJsPath);
        console.log(`[还原] 已删除汉化脚本`);
        changed = true;
    }
        
    if (changed) {
        updateChecksums10(installDir);
        resignAppOnMac(installDir);
        console.log("[√] 校验值已同步，1.0 软件恢复至原始状态。");
    } else {
        console.log("[!] 未找到 1.0 备份文件。");
    }
    return true;
}

// ==========================================
// 代理模块管理 (Windows 平台可选注入)
// ==========================================
function injectProxyIfNeeded(installDir) {
    if (process.platform !== 'win32') return;
    const proxyConfigDir = path.join(__dirname, 'proxy_config');
    if (!fs.existsSync(proxyConfigDir)) return;

    let files = [];
    try {
        files = fs.readdirSync(proxyConfigDir).filter(f => {
            const fullPath = path.join(proxyConfigDir, f);
            return fs.statSync(fullPath).isFile();
        });
    } catch (e) {
        return;
    }

    if (files.length === 0) return;

    console.log(`\n[代理] 检测到 proxy_config 配置目录，正在注入代理模块...`);
    const injectedFiles = [];
    for (const file of files) {
        const src = path.join(proxyConfigDir, file);
        const dest = path.join(installDir, file);
        try {
            fs.copyFileSync(src, dest);
            injectedFiles.push(file);
        } catch (e) {
            console.warn(`[代理警告] 注入文件 ${file} 失败: ${e.message}`);
        }
    }

    if (injectedFiles.length > 0) {
        console.log(`[代理] 代理模块注入成功: ${injectedFiles.join(', ')}`);
    }
}

function restoreProxyIfNeeded(installDir) {
    if (process.platform !== 'win32') return;
    const proxyFiles = ['version.dll', 'dbghelp.dll', 'config.json'];
    const proxyConfigDir = path.join(__dirname, 'proxy_config');
    if (fs.existsSync(proxyConfigDir)) {
        try {
            const files = fs.readdirSync(proxyConfigDir);
            for (const f of files) {
                if (!proxyFiles.includes(f)) proxyFiles.push(f);
            }
        } catch (e) {
            // ignore
        }
    }

    const removedFiles = [];
    for (const file of proxyFiles) {
        const dest = path.join(installDir, file);
        if (fs.existsSync(dest)) {
            try {
                fs.unlinkSync(dest);
                removedFiles.push(file);
            } catch (e) {
                console.warn(`[代理警告] 移除代理文件 ${file} 失败: ${e.message}`);
            }
        }
    }

    if (removedFiles.length > 0) {
        console.log(`[代理] 已清理代理注入文件: ${removedFiles.join(', ')}`);
    }
}

// ==========================================
// Windows 更新後自動偵測與自動恢復守衛模組
// ==========================================
function buildLaunchGuiVbs() {
    const lines = [
        'Option Explicit',
        'On Error Resume Next',
        'Dim exePath, workDir, cmdLine, launched',
        'launched = False',
        'If WScript.Arguments.Count < 1 Then WScript.Quit 1',
        'exePath = WScript.Arguments(0)',
        'If WScript.Arguments.Count >= 2 Then',
        '    workDir = WScript.Arguments(1)',
        'Else',
        '    workDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(exePath)',
        'End If',
        'cmdLine = """" & exePath & """"',
        'Dim procClass, newPid, ret',
        'Set procClass = GetObject("winmgmts:\\\\.\\root\\cimv2:Win32_Process")',
        'If Err.Number = 0 And Not (procClass Is Nothing) Then',
        '    ret = procClass.Create(cmdLine, workDir, Null, newPid)',
        '    If Err.Number = 0 And ret = 0 Then launched = True',
        'End If',
        'Err.Clear',
        'If Not launched Then',
        '    Dim shApp',
        '    Set shApp = CreateObject("Shell.Application")',
        '    shApp.ShellExecute exePath, "", workDir, "open", 1',
        '    If Err.Number = 0 Then launched = True',
        'End If',
        'If launched Then',
        '    WScript.Quit 0',
        'Else',
        '    WScript.Quit 1',
        'End If'
    ];
    return lines.join('\r\n') + '\r\n';
}

function buildUpdateWatchdogVbs() {
    const lines = [
        'Option Explicit',
        'On Error Resume Next',
        'Dim fso, sh, guardDir, lockPath, lockStream, logPath',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        'guardDir = fso.GetParentFolderName(WScript.ScriptFullName)',
        'logPath = guardDir & "\\guard.log"',
        'lockPath = guardDir & "\\watchdog.lock"',
        'Set lockStream = fso.OpenTextFile(lockPath, 2, True)',
        'If Err.Number <> 0 Then',
        '    WScript.Quit 0',
        'End If',
        'Err.Clear',
        '',
        'Sub WriteWatchdogLog(text)',
        '    On Error Resume Next',
        '    Dim ts, ls, fInfo',
        '    If fso.FileExists(logPath) Then',
        '        Set fInfo = fso.GetFile(logPath)',
        '        If Err.Number = 0 And fInfo.Size > 262144 Then',
        '            fso.CopyFile logPath, logPath & ".old", True',
        '            Set ls = fso.OpenTextFile(logPath, 2, True)',
        '            If Err.Number = 0 Then ls.Close',
        '        End If',
        '        Err.Clear',
        '    End If',
        '    ts = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & " " & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)',
        '    Set ls = fso.OpenTextFile(logPath, 8, True)',
        '    If Err.Number = 0 Then',
        '        ls.WriteLine "[" & ts & "] [WATCHDOG] " & text',
        '        ls.Close',
        '    End If',
        '    Err.Clear',
        'End Sub',
        '',
        'Function GetAsarStamp(targetAsar)',
        '    On Error Resume Next',
        '    GetAsarStamp = ""',
        '    If Not fso.FileExists(targetAsar) Then Exit Function',
        '    Dim f',
        '    Set f = fso.GetFile(targetAsar)',
        '    If Err.Number = 0 And Not (f Is Nothing) Then',
        '        GetAsarStamp = CStr(f.Size) & "_" & CStr(f.DateLastModified)',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Function ReadFirstLineAuto(filePath)',
        '    On Error Resume Next',
        '    ReadFirstLineAuto = ""',
        '    If Not fso.FileExists(filePath) Then Exit Function',
        '    Dim bin, bytes, b1, b2, s, txt',
        '    Set bin = CreateObject("ADODB.Stream")',
        '    bin.Type = 1',
        '    bin.Open',
        '    bin.LoadFromFile filePath',
        '    If Err.Number = 0 And Not bin.EOS Then',
        '        bytes = bin.Read(2)',
        '        b1 = AscB(MidB(bytes, 1, 1))',
        '        If LenB(bytes) >= 2 Then b2 = AscB(MidB(bytes, 2, 1)) Else b2 = 0',
        '        bin.Close',
        '        If b1 = &HFF And b2 = &HFE Then',
        '            Set s = fso.OpenTextFile(filePath, 1, False, -1)',
        '            If Err.Number = 0 And Not s.AtEndOfStream Then ReadFirstLineAuto = Trim(s.ReadLine)',
        '            If Err.Number = 0 Then s.Close',
        '        Else',
        '            Set txt = CreateObject("ADODB.Stream")',
        '            txt.Type = 2',
        '            txt.Charset = "utf-8"',
        '            txt.Open',
        '            txt.LoadFromFile filePath',
        '            If Err.Number = 0 And Not txt.EOS Then',
        '                ReadFirstLineAuto = Trim(Split(Replace(txt.ReadText(-2), vbCr, ""), vbLf)(0))',
        '            End If',
        '            If Err.Number = 0 Then txt.Close',
        '        End If',
        '    Else',
        '        Err.Clear',
        '        Set s = fso.OpenTextFile(filePath, 1, False)',
        '        If Err.Number = 0 And Not s.AtEndOfStream Then ReadFirstLineAuto = Trim(s.ReadLine)',
        '        If Err.Number = 0 Then s.Close',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Dim installDir, oldPid, relaunchFlag',
        'installDir = ""',
        'oldPid = 0',
        'relaunchFlag = "0"',
        'If WScript.Arguments.Count >= 1 Then installDir = WScript.Arguments(0)',
        'If WScript.Arguments.Count >= 2 Then',
        '    If IsNumeric(WScript.Arguments(1)) Then oldPid = CLng(WScript.Arguments(1))',
        'End If',
        'If WScript.Arguments.Count >= 3 Then relaunchFlag = WScript.Arguments(2)',
        'If installDir = "" Then',
        '    installDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Programs\\antigravity"',
        'End If',
        'Do While Right(installDir, 1) = "\\" Or Right(installDir, 1) = "/"',
        '    installDir = Left(installDir, Len(installDir) - 1)',
        'Loop',
        '',
        'Dim asarPath, preAsarStamp',
        'asarPath = installDir & "\\resources\\app.asar"',
        'preAsarStamp = GetAsarStamp(asarPath)',
        '',
        'Dim wmi',
        'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
        'If Err.Number <> 0 Then',
        '    WriteWatchdogLog "Abort: failed to connect WMI."',
        '    lockStream.Close',
        '    WScript.Quit 0',
        'End If',
        'Err.Clear',
        '',
        'Function IsPidAlive(pid)',
        '    IsPidAlive = False',
        '    If pid <= 0 Then Exit Function',
        '    Dim col, item',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            IsPidAlive = True',
        '            Exit For',
        '        Next',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Function IsProcessRunning(exeName)',
        '    IsProcessRunning = False',
        '    Dim col, item',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name=\'" & exeName & "\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            IsProcessRunning = True',
        '            Exit For',
        '        Next',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Function IsLocalizationScriptCmd(cmdVal)',
        '    IsLocalizationScriptCmd = False',
        '    If IsNull(cmdVal) Then Exit Function',
        '    If InStr(1, LCase(CStr(cmdVal)), "localization_engine.js", 1) > 0 Then',
        '        IsLocalizationScriptCmd = True',
        '    End If',
        'End Function',
        '',
        'Function HasAppRunningInDir(targetDir)',
        '    HasAppRunningInDir = False',
        '    Dim col, item, normDir, normExe, normCmd',
        '    normDir = LCase(Trim(targetDir))',
        '    Do While Right(normDir, 1) = "\\" Or Right(normDir, 1) = "/"',
        '        normDir = Left(normDir, Len(normDir) - 1)',
        '    Loop',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'Antigravity.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If Not IsLocalizationScriptCmd(item.CommandLine) Then',
        '                If IsNull(item.ExecutablePath) Then normExe = "" Else normExe = LCase(CStr(item.ExecutablePath))',
        '                If IsNull(item.CommandLine) Then normCmd = "" Else normCmd = LCase(CStr(item.CommandLine))',
        '                If normDir = "" Then',
        '                    HasAppRunningInDir = True',
        '                    Exit For',
        '                ElseIf normExe = normDir & "\\antigravity.exe" Or Left(normExe, Len(normDir) + 1) = normDir & "\\" Then',
        '                    HasAppRunningInDir = True',
        '                    Exit For',
        '                ElseIf normExe = "" And (InStr(1, normCmd, normDir, 1) > 0 Or InStr(1, normCmd, "--updated", 1) > 0) Then',
        '                    HasAppRunningInDir = True',
        '                    Exit For',
        '                End If',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Function HasUpdatedAppInDir(targetDir, prevPid)',
        '    HasUpdatedAppInDir = False',
        '    Dim col, item, normDir, normExe, normCmd',
        '    normDir = LCase(Trim(targetDir))',
        '    Do While Right(normDir, 1) = "\\" Or Right(normDir, 1) = "/"',
        '        normDir = Left(normDir, Len(normDir) - 1)',
        '    Loop',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'Antigravity.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If CLng(item.ProcessId) <> prevPid And Not IsLocalizationScriptCmd(item.CommandLine) Then',
        '                If IsNull(item.ExecutablePath) Then normExe = "" Else normExe = LCase(CStr(item.ExecutablePath))',
        '                If IsNull(item.CommandLine) Then normCmd = "" Else normCmd = LCase(CStr(item.CommandLine))',
        '                If (normExe = "" Or normExe = normDir & "\\antigravity.exe" Or Left(normExe, Len(normDir) + 1) = normDir & "\\") And InStr(1, normCmd, "--updated", 1) > 0 Then',
        '                    HasUpdatedAppInDir = True',
        '                    Exit For',
        '                End If',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Function IsInstallerRunning()',
        '    IsInstallerRunning = IsProcessRunning("Antigravity-x64.exe") Or IsProcessRunning("Antigravity-arm64.exe") Or IsProcessRunning("Uninstall Antigravity.exe")',
        '    If IsInstallerRunning Then Exit Function',
        '    Dim col, item, ep, cl',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name=\'installer.exe\' AND ExecutablePath LIKE \'%antigravity-updater%\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            IsInstallerRunning = True',
        '            Exit Function',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'elevate.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If IsNull(item.ExecutablePath) Then ep = "" Else ep = LCase(CStr(item.ExecutablePath))',
        '            If IsNull(item.CommandLine) Then cl = "" Else cl = LCase(CStr(item.CommandLine))',
        '            If InStr(1, ep, "antigravity", 1) > 0 Or InStr(1, cl, "antigravity", 1) > 0 Then',
        '                IsInstallerRunning = True',
        '                Exit Function',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'old-uninstaller.exe\' OR Name LIKE \'Au_%.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If IsNull(item.ExecutablePath) Then ep = "" Else ep = LCase(CStr(item.ExecutablePath))',
        '            If IsNull(item.CommandLine) Then cl = "" Else cl = LCase(CStr(item.CommandLine))',
        '            If InStr(1, ep, "antigravity", 1) > 0 Or InStr(1, cl, "keep_app_data", 1) > 0 Or InStr(1, cl, "antigravity", 1) > 0 Then',
        '                IsInstallerRunning = True',
        '                Exit Function',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'WriteWatchdogLog "Started: oldPid=" & oldPid & " relaunch=" & relaunchFlag & " dir=" & installDir',
        '',
        'Dim i, sawInstaller, stillAlive',
        'sawInstaller = False',
        'stillAlive = False',
        'If oldPid > 0 Then',
        '    For i = 1 To 240',
        '        If IsInstallerRunning() Then sawInstaller = True',
        '        If Not IsPidAlive(oldPid) Then Exit For',
        '        WScript.Sleep 500',
        '    Next',
        '    If IsPidAlive(oldPid) Then stillAlive = True',
        'End If',
        'If stillAlive Then',
        '    WriteWatchdogLog "Abort: oldPid=" & oldPid & " still alive after 120s."',
        '    lockStream.Close',
        '    WScript.Quit 0',
        'End If',
        '',
        'If Not sawInstaller Then',
        '    For i = 1 To 90',
        '        If IsInstallerRunning() Then',
        '            sawInstaller = True',
        '            Exit For',
        '        End If',
        '        If HasUpdatedAppInDir(installDir, oldPid) Then',
        '            sawInstaller = True',
        '            Exit For',
        '        End If',
        '        If preAsarStamp <> "" And GetAsarStamp(asarPath) <> preAsarStamp Then',
        '            sawInstaller = True',
        '            Exit For',
        '        End If',
        '        WScript.Sleep 500',
        '    Next',
        'End If',
        '',
        'For i = 1 To 600',
        '    If Not IsInstallerRunning() Then',
        '        WScript.Sleep 350',
        '        If Not IsInstallerRunning() Then Exit For',
        '    End If',
        '    WScript.Sleep 500',
        'Next',
        '',
        'If Not HasAppRunningInDir(installDir) Then',
        '    For i = 1 To 6',
        '        WScript.Sleep 250',
        '        If HasAppRunningInDir(installDir) Or IsInstallerRunning() Then Exit For',
        '    Next',
        'End If',
        '',
        'Dim exePath, enginePath, launchVbsPath, sysRoot, wscriptExe',
        'exePath = installDir & "\\Antigravity.exe"',
        'enginePath = guardDir & "\\localization_engine.js"',
        'launchVbsPath = guardDir & "\\launch_gui.vbs"',
        'sysRoot = sh.ExpandEnvironmentStrings("%SystemRoot%")',
        'If sysRoot = "" Or sysRoot = "%SystemRoot%" Then sysRoot = "C:\\Windows"',
        'wscriptExe = sysRoot & "\\System32\\wscript.exe"',
        'If Not fso.FileExists(wscriptExe) Then wscriptExe = "wscript.exe"',
        '',
        'If Not fso.FileExists(enginePath) Then',
        '    WriteWatchdogLog "Abort: missing enginePath=" & enginePath',
        '    lockStream.Close',
        '    WScript.Quit 0',
        'End If',
        '',
        'Dim langArg, langModePath, langModeVal',
        'langArg = ""',
        'langModePath = guardDir & "\\lang_mode.txt"',
        'langModeVal = LCase(ReadFirstLineAuto(langModePath))',
        'If langModeVal = "tw" Then',
        '    langArg = " --tw"',
        'ElseIf langModeVal = "cn" Then',
        '    langArg = " --cn"',
        'End If',
        '',
        'Dim cmdCheck, cmdPatch, rcCheck, rcPatch, attempt, didTakeover, needRelaunch, completed, didPatch, unchangedWaits',
        'didTakeover = False',
        'needRelaunch = (relaunchFlag = "1")',
        'completed = False',
        'didPatch = False',
        'unchangedWaits = 0',
        '',
        'For attempt = 1 To 12',
        '    If IsInstallerRunning() Then',
        '        sawInstaller = True',
        '        WriteWatchdogLog "Attempt " & attempt & ": installer still active; waiting."',
        '        WScript.Sleep 1500',
        '    ElseIf Not fso.FileExists(exePath) Then',
        '        WriteWatchdogLog "Attempt " & attempt & ": waiting for Antigravity.exe to appear."',
        '        WScript.Sleep 1500',
        '    Else',
        '        cmdCheck = """" & exePath & """ """ & enginePath & """" & langArg & " --check-patch-needed --install-dir """ & installDir & """"',
        '        cmdPatch = """" & exePath & """ """ & enginePath & """" & langArg & " --brand-title english --takeover-post-update --no-guard --quiet --install-dir """ & installDir & """"',
        '        sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
        '        rcCheck = sh.Run(cmdCheck, 0, True)',
        '        Call sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")',
        '',
        '        If rcCheck = 0 Then',
        '            If Not didPatch And Not sawInstaller And preAsarStamp <> "" And GetAsarStamp(asarPath) = preAsarStamp And unchangedWaits < 5 Then',
        '                WriteWatchdogLog "Attempt " & attempt & ": ASAR unchanged since pre-update; waiting for installer."',
        '                unchangedWaits = unchangedWaits + 1',
        '                WScript.Sleep 2000',
        '            Else',
        '                If (needRelaunch Or didTakeover) And Not HasAppRunningInDir(installDir) Then',
        '                    If fso.FileExists(launchVbsPath) Then',
        '                        sh.Run """" & wscriptExe & """ //B //Nologo """ & launchVbsPath & """ """ & exePath & """ """ & installDir & """", 0, True',
        '                    Else',
        '                        sh.Run """" & exePath & """", 1, False',
        '                    End If',
        '                    WriteWatchdogLog "Verified localized on attempt " & attempt & "; launched Antigravity GUI."',
        '                Else',
        '                    WriteWatchdogLog "Verified localized on attempt " & attempt & "; already running or no launch needed."',
        '                End If',
        '                WScript.Sleep 1500',
        '                sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
        '                rcCheck = sh.Run(cmdCheck, 0, True)',
        '                Call sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")',
        '                If rcCheck = 0 Then',
        '                    completed = True',
        '                    Exit For',
        '                End If',
        '                WriteWatchdogLog "Post-launch verification detected reversion; retrying localization."',
        '            End If',
        '        ElseIf rcCheck = 10 Then',
        '            If HasAppRunningInDir(installDir) Then',
        '                didTakeover = True',
        '                needRelaunch = True',
        '                WriteWatchdogLog "Attempt " & attempt & ": unlocalized app running after update; taking over (--takeover-post-update)."',
        '            Else',
        '                WriteWatchdogLog "Attempt " & attempt & ": unlocalized ASAR detected; applying localization."',
        '            End If',
        '            sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
        '            rcPatch = sh.Run(cmdPatch, 0, True)',
        '            Call sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")',
        '            If rcPatch <> 0 Then',
        '                WriteWatchdogLog "Attempt " & attempt & ": patch returned rc=" & rcPatch & "; retrying."',
        '                WScript.Sleep 1500',
        '            Else',
        '                didPatch = True',
        '                WScript.Sleep 400',
        '            End If',
        '        Else',
        '            WriteWatchdogLog "Attempt " & attempt & ": ASAR not ready (rc=" & rcCheck & "); retrying."',
        '            WScript.Sleep 1500',
        '        End If',
        '    End If',
        'Next',
        '',
        'If Not completed Then',
        '    WriteWatchdogLog "Finished 12 attempts without complete verification."',
        'End If',
        '',
        'Call sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")',
        'lockStream.Close'
    ];
    return lines.join('\r\n') + '\r\n';
}

function buildGuardVbs() {
    const lines = [
        'Option Explicit',
        'On Error Resume Next',
        'Dim fso, sh, guardDir, watchLockPath, watchTest, lockPath, lockStream',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        'guardDir = fso.GetParentFolderName(WScript.ScriptFullName)',
        '',
        'watchLockPath = guardDir & "\\watchdog.lock"',
        'If fso.FileExists(watchLockPath) Then',
        '    Set watchTest = fso.OpenTextFile(watchLockPath, 2, True)',
        '    If Err.Number <> 0 Then',
        '        WScript.Quit 0',
        '    End If',
        '    watchTest.Close',
        '    Err.Clear',
        'End If',
        '',
        'Dim wmi, col, item, cmdVal, epVal',
        'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
        'If Err.Number = 0 Then',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name=\'Antigravity.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If IsNull(item.CommandLine) Then cmdVal = "" Else cmdVal = LCase(CStr(item.CommandLine))',
        '            If InStr(1, cmdVal, "localization_engine.js", 1) = 0 Then',
        '                WScript.Quit 0',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name=\'Antigravity-x64.exe\' OR Name=\'Antigravity-arm64.exe\' OR Name=\'Uninstall Antigravity.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            WScript.Quit 0',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name=\'installer.exe\' AND ExecutablePath LIKE \'%antigravity-updater%\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            WScript.Quit 0',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'elevate.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If IsNull(item.ExecutablePath) Then epVal = "" Else epVal = LCase(CStr(item.ExecutablePath))',
        '            If IsNull(item.CommandLine) Then cmdVal = "" Else cmdVal = LCase(CStr(item.CommandLine))',
        '            If InStr(1, epVal, "antigravity", 1) > 0 Or InStr(1, cmdVal, "antigravity", 1) > 0 Then',
        '                WScript.Quit 0',
        '            End If',
        '        Next',
        '    End If',
        '    Err.Clear',
        '    Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE Name=\'old-uninstaller.exe\' OR Name LIKE \'Au_%.exe\'")',
        '    If Err.Number = 0 Then',
        '        For Each item In col',
        '            If IsNull(item.ExecutablePath) Then epVal = "" Else epVal = LCase(CStr(item.ExecutablePath))',
        '            If IsNull(item.CommandLine) Then cmdVal = "" Else cmdVal = LCase(CStr(item.CommandLine))',
        '            If InStr(1, epVal, "antigravity", 1) > 0 Or InStr(1, cmdVal, "keep_app_data", 1) > 0 Or InStr(1, cmdVal, "antigravity", 1) > 0 Then',
        '                WScript.Quit 0',
        '            End If',
        '        Next',
        '    End If',
        'End If',
        'Err.Clear',
        '',
        'lockPath = guardDir & "\\guard.lock"',
        'Set lockStream = fso.OpenTextFile(lockPath, 2, True)',
        'If Err.Number <> 0 Then',
        '    WScript.Quit 0',
        'End If',
        'Err.Clear',
        '',
        'Function ReadFirstLineAuto(filePath)',
        '    On Error Resume Next',
        '    ReadFirstLineAuto = ""',
        '    If Not fso.FileExists(filePath) Then Exit Function',
        '    Dim bin, bytes, b1, b2, s, txt',
        '    Set bin = CreateObject("ADODB.Stream")',
        '    bin.Type = 1',
        '    bin.Open',
        '    bin.LoadFromFile filePath',
        '    If Err.Number = 0 And Not bin.EOS Then',
        '        bytes = bin.Read(2)',
        '        b1 = AscB(MidB(bytes, 1, 1))',
        '        If LenB(bytes) >= 2 Then b2 = AscB(MidB(bytes, 2, 1)) Else b2 = 0',
        '        bin.Close',
        '        If b1 = &HFF And b2 = &HFE Then',
        '            Set s = fso.OpenTextFile(filePath, 1, False, -1)',
        '            If Err.Number = 0 And Not s.AtEndOfStream Then ReadFirstLineAuto = Trim(s.ReadLine)',
        '            If Err.Number = 0 Then s.Close',
        '        Else',
        '            Set txt = CreateObject("ADODB.Stream")',
        '            txt.Type = 2',
        '            txt.Charset = "utf-8"',
        '            txt.Open',
        '            txt.LoadFromFile filePath',
        '            If Err.Number = 0 And Not txt.EOS Then',
        '                ReadFirstLineAuto = Trim(Split(Replace(txt.ReadText(-2), vbCr, ""), vbLf)(0))',
        '            End If',
        '            If Err.Number = 0 Then txt.Close',
        '        End If',
        '    Else',
        '        Err.Clear',
        '        Set s = fso.OpenTextFile(filePath, 1, False)',
        '        If Err.Number = 0 And Not s.AtEndOfStream Then ReadFirstLineAuto = Trim(s.ReadLine)',
        '        If Err.Number = 0 Then s.Close',
        '    End If',
        '    Err.Clear',
        'End Function',
        '',
        'Dim installDir, cfgPath, exePath, enginePath',
        'cfgPath = guardDir & "\\install_dir.txt"',
        'installDir = ReadFirstLineAuto(cfgPath)',
        'If installDir = "" Then',
        '    installDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Programs\\antigravity"',
        'End If',
        '',
        'Dim langArg, langModePath, langModeVal',
        'langArg = ""',
        'langModePath = guardDir & "\\lang_mode.txt"',
        'langModeVal = LCase(ReadFirstLineAuto(langModePath))',
        'If langModeVal = "tw" Then',
        '    langArg = " --tw"',
        'ElseIf langModeVal = "cn" Then',
        '    langArg = " --cn"',
        'End If',
        '',
        'exePath = installDir & "\\Antigravity.exe"',
        'enginePath = guardDir & "\\localization_engine.js"',
        'If fso.FileExists(exePath) And fso.FileExists(enginePath) Then',
        '    sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
        '    Dim cmd',
        '    cmd = """" & exePath & """ """ & enginePath & """" & langArg & " --brand-title english --auto --if-needed --quiet --install-dir """ & installDir & """"',
        '    sh.Run cmd, 0, True',
        '    Call sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")',
        'End If',
        '',
        'lockStream.Close'
    ];
    return lines.join('\r\n') + '\r\n';
}

function buildGuardTaskXml(guardVbsPath, workingDir) {
    const escapeXml = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const userId = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : (process.env.USERNAME || '');
    const userIdTag = userId ? `\r\n      <UserId>${escapeXml(userId)}</UserId>` : '';
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const wscriptExe = path.join(sysRoot, 'System32', 'wscript.exe');
    const d = new Date(Date.now() + 60 * 1000);
    const pad2 = (n) => String(n).padStart(2, '0');
    const startBoundary = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

    return `<?xml version="1.0" encoding="UTF-16"?>\r\n` +
`<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n` +
`  <RegistrationInfo>\r\n` +
`    <Description>Auto-detect system language and restore Chinese localization after Antigravity updates.</Description>\r\n` +
`  </RegistrationInfo>\r\n` +
`  <Triggers>\r\n` +
`    <LogonTrigger>\r\n` +
`      <Enabled>true</Enabled>\r\n` +
`      <Delay>PT10S</Delay>\r\n` +
`    </LogonTrigger>\r\n` +
`    <TimeTrigger>\r\n` +
`      <StartBoundary>${startBoundary}</StartBoundary>\r\n` +
`      <Enabled>true</Enabled>\r\n` +
`      <Repetition>\r\n` +
`        <Interval>PT15M</Interval>\r\n` +
`        <StopAtDurationEnd>false</StopAtDurationEnd>\r\n` +
`      </Repetition>\r\n` +
`    </TimeTrigger>\r\n` +
`  </Triggers>\r\n` +
`  <Principals>\r\n` +
`    <Principal id="Author">${userIdTag}\r\n` +
`      <LogonType>InteractiveToken</LogonType>\r\n` +
`      <RunLevel>LeastPrivilege</RunLevel>\r\n` +
`    </Principal>\r\n` +
`  </Principals>\r\n` +
`  <Settings>\r\n` +
`    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n` +
`    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n` +
`    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n` +
`    <AllowHardTerminate>true</AllowHardTerminate>\r\n` +
`    <StartWhenAvailable>true</StartWhenAvailable>\r\n` +
`    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r\n` +
`    <IdleSettings>\r\n` +
`      <StopOnIdleEnd>false</StopOnIdleEnd>\r\n` +
`      <RestartOnIdle>false</RestartOnIdle>\r\n` +
`    </IdleSettings>\r\n` +
`    <AllowStartOnDemand>true</AllowStartOnDemand>\r\n` +
`    <Enabled>true</Enabled>\r\n` +
`    <Hidden>false</Hidden>\r\n` +
`    <RunOnlyIfIdle>false</RunOnlyIfIdle>\r\n` +
`    <WakeToRun>false</WakeToRun>\r\n` +
`    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>\r\n` +
`    <Priority>7</Priority>\r\n` +
`  </Settings>\r\n` +
`  <Actions Context="Author">\r\n` +
`    <Exec>\r\n` +
`      <Command>${escapeXml(wscriptExe)}</Command>\r\n` +
`      <Arguments>//B //Nologo &quot;${escapeXml(guardVbsPath)}&quot;</Arguments>\r\n` +
`      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>\r\n` +
`    </Exec>\r\n` +
`  </Actions>\r\n` +
`</Task>\r\n`;
}

function isGuardTaskRegistered() {
    if (process.platform !== 'win32') return false;
    try {
        child_process.execSync(`schtasks /Query /TN "${GUARD_TASK_NAME}"`, {
            stdio: 'ignore',
            windowsHide: true
        });
        return true;
    } catch (_) {
        return false;
    }
}

function installAutoGuard(installDir) {
    if (process.platform !== 'win32') return true;
    const guardDir = getGuardDir();
    try {
        fs.mkdirSync(guardDir, { recursive: true });

        // 1. 鏡像同步核心檔案與繁簡雙字典，避免搬移或刪除解壓資料夾後失效
        if (path.resolve(__dirname).toLowerCase() !== path.resolve(guardDir).toLowerCase()) {
            fs.copyFileSync(__filename, path.join(guardDir, 'localization_engine.js'));

            const srcBats = new Set(fs.readdirSync(__dirname).filter(f => f.toLowerCase().endsWith('.bat')));
            for (const existing of fs.readdirSync(guardDir)) {
                if (existing.toLowerCase().endsWith('.bat') && !srcBats.has(existing)) {
                    try { fs.unlinkSync(path.join(guardDir, existing)); } catch (_) {}
                }
            }
            for (const batFile of srcBats) {
                fs.copyFileSync(path.join(__dirname, batFile), path.join(guardDir, batFile));
            }

            for (const dictName of ['dicts', 'dicts_tw']) {
                const srcDictDir = path.join(__dirname, dictName);
                const dstDictDir = path.join(guardDir, dictName);
                if (!fs.existsSync(srcDictDir)) continue;
                fs.mkdirSync(dstDictDir, { recursive: true });
                const srcJsonFiles = new Set(fs.readdirSync(srcDictDir).filter(f => f.endsWith('.json')));
                for (const existing of fs.readdirSync(dstDictDir)) {
                    if (!srcJsonFiles.has(existing)) {
                        try { fs.unlinkSync(path.join(dstDictDir, existing)); } catch (_) {}
                    }
                }
                for (const file of srcJsonFiles) {
                    fs.copyFileSync(path.join(srcDictDir, file), path.join(dstDictDir, file));
                }
            }
        }

        // 2. 寫入安裝目錄（UTF-16LE BOM 支援任意繁簡中路徑）、語系模式設定與純 ASCII VBS 守衛/看門狗/啟動輔助腳本
        const installDirBuf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(installDir + '\r\n', 'utf16le')]);
        fs.writeFileSync(path.join(guardDir, 'install_dir.txt'), installDirBuf);
        fs.writeFileSync(path.join(guardDir, 'lang_mode.txt'), LANG_SELECTION_MODE + '\r\n', 'utf8');
        fs.writeFileSync(path.join(guardDir, 'launch_gui.vbs'), buildLaunchGuiVbs(), 'utf8');
        fs.writeFileSync(path.join(guardDir, 'update_watchdog.vbs'), buildUpdateWatchdogVbs(), 'utf8');
        const guardVbsPath = path.join(guardDir, 'guard.vbs');
        fs.writeFileSync(guardVbsPath, buildGuardVbs(), 'utf8');

        // 清理舊版排程名稱（若存在）
        try {
            child_process.execSync(`schtasks /Delete /TN "${LEGACY_GUARD_TASK_NAME}" /F`, {
                stdio: 'ignore',
                windowsHide: true
            });
        } catch (_) {}

        // 3. 註冊低頻背景工作排程（XML UTF-16LE BOM 免管理員權限、支援電池模式）
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const xmlPath = path.join(guardDir, 'guard_task.xml');
        const xmlText = buildGuardTaskXml(guardVbsPath, localAppData);
        const xmlBuf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xmlText, 'utf16le')]);
        fs.writeFileSync(xmlPath, xmlBuf);

        let taskOk = false;
        try {
            child_process.execSync(`schtasks /Create /TN "${GUARD_TASK_NAME}" /XML "${xmlPath}" /F`, {
                stdio: 'pipe',
                windowsHide: true
            });
            taskOk = true;
        } catch (xmlErr) {
            try {
                const sysRoot = process.env.SystemRoot || 'C:\\Windows';
                const wscriptExe = path.join(sysRoot, 'System32', 'wscript.exe');
                child_process.execSync(
                    `schtasks /Create /TN "${GUARD_TASK_NAME}" /TR "\\"${wscriptExe}\\" //B //Nologo \\"${guardVbsPath}\\"" /SC MINUTE /MO 15 /F`,
                    { stdio: 'pipe', windowsHide: true }
                );
                taskOk = true;
            } catch (fallbackErr) {
                console.warn(msg(`[守衛警告] 註冊背景排程失敗: ${fallbackErr.message}`, `[守卫警告] 注册后台计划任务失败: ${fallbackErr.message}`));
            }
        } finally {
            try { if (fs.existsSync(xmlPath)) fs.unlinkSync(xmlPath); } catch (_) {}
        }

        console.log(msg(`[守衛] 已建立獨立安全鏡像與更新看門狗: ${guardDir}`, `[守卫] 已建立独立安全镜像与更新看门狗: ${guardDir}`));
        if (taskOk) {
            console.log(msg(
                `[守衛] 已啟用雙保險自動偵測引擎 (點擊更新即時看門狗 ＋ 背景排程 ${GUARD_TASK_NAME})！`,
                `[守卫] 已启用双保险自动检测引擎 (点击更新即时看门狗 ＋ 后台计划任务 ${GUARD_TASK_NAME})！`
            ));
        }
        return true;
    } catch (e) {
        console.warn(msg(`[守衛警告] 啟用自動偵測守衛時發生錯誤: ${e.message}`, `[守卫警告] 启用自动检测守卫时发生错误: ${e.message}`));
        return false;
    }
}

function uninstallAutoGuard() {
    if (process.platform !== 'win32') return true;
    for (const taskName of [GUARD_TASK_NAME, LEGACY_GUARD_TASK_NAME]) {
        try {
            child_process.execSync(`schtasks /Delete /TN "${taskName}" /F`, {
                stdio: 'ignore',
                windowsHide: true
            });
            console.log(msg(`[守衛] 已移除背景自動偵測排程: ${taskName}`, `[守卫] 已移除后台自动检测计划任务: ${taskName}`));
        } catch (_) {}
    }

    const guardDir = getGuardDir();
    if (fs.existsSync(guardDir)) {
        try {
            fs.rmSync(guardDir, { recursive: true, force: true });
            console.log(msg(`[守衛] 已清理自動偵測鏡像目錄: ${guardDir}`, `[守卫] 已清理自动检测镜像目录: ${guardDir}`));
        } catch (e) {
            console.warn(msg(`[守衛警告] 清理鏡像目錄失敗: ${e.message}`, `[守卫警告] 清理镜像目录失败: ${e.message}`));
        }
    }
    return true;
}

function launchAntigravityGui(installDir, isRestored = false) {
    const envCopy = Object.assign({}, process.env);
    delete envCopy.ELECTRON_RUN_AS_NODE;
    delete envCopy.ATOM_SHELL_INTERNAL_RUN_AS_NODE;

    if (process.env.AG_TEST_LAUNCH_RECORD_FILE) {
        try {
            fs.writeFileSync(process.env.AG_TEST_LAUNCH_RECORD_FILE, JSON.stringify({
                installDir,
                isRestored: Boolean(isRestored),
                hasRunAsNode: Boolean(envCopy.ELECTRON_RUN_AS_NODE)
            }), 'utf8');
        } catch (_) {}
        console.log(msg(
            isRestored ? `[啟動] 已模擬重新開啟 Antigravity！` : `[啟動] 已模擬自動開啟${msg('繁體中文', '简体中文')}版 Antigravity！`,
            isRestored ? `[启动] 已模拟重新打开 Antigravity！` : `[启动] 已模拟自动打开简体中文版 Antigravity！`
        ));
        return true;
    }

    if (process.platform === 'win32') {
        const exePath = path.join(installDir, 'Antigravity.exe');
        if (!fs.existsSync(exePath)) {
            console.warn(msg(`[啟動警告] 找不到主程式: ${exePath}`, `[启动警告] 找不到主程序: ${exePath}`));
            return false;
        }
        let tempVbsPath = '';
        try {
            const sysRoot = process.env.SystemRoot || 'C:\\Windows';
            let wscriptExe = path.join(sysRoot, 'System32', 'wscript.exe');
            if (!fs.existsSync(wscriptExe)) wscriptExe = 'wscript.exe';

            const vbsContent = buildLaunchGuiVbs();
            const guardDir = getGuardDir();
            const guardVbsPath = path.join(guardDir, 'launch_gui.vbs');
            let vbsPath = '';

            if (fs.existsSync(guardDir)) {
                try {
                    if (!fs.existsSync(guardVbsPath) || fs.readFileSync(guardVbsPath, 'utf8') !== vbsContent) {
                        fs.writeFileSync(guardVbsPath, vbsContent, 'utf8');
                    }
                    vbsPath = guardVbsPath;
                } catch (_) {}
            }
            if (!vbsPath) {
                tempVbsPath = path.join(os.tmpdir(), `ag_launch_${process.pid}_${Date.now()}.vbs`);
                fs.writeFileSync(tempVbsPath, vbsContent, 'utf8');
                vbsPath = tempVbsPath;
            }

            let launchedCleanly = false;
            try {
                const res = child_process.spawnSync(
                    wscriptExe,
                    ['//B', '//Nologo', vbsPath, exePath, installDir],
                    {
                        cwd: installDir,
                        stdio: 'ignore',
                        windowsHide: true,
                        env: envCopy
                    }
                );
                if (res && res.status === 0 && !res.error) {
                    launchedCleanly = true;
                }
            } catch (_) {}

            if (!launchedCleanly) {
                const child = child_process.spawn(exePath, [], {
                    detached: true,
                    stdio: 'ignore',
                    cwd: installDir,
                    windowsHide: false,
                    env: envCopy
                });
                child.unref();
            }
            console.log(msg(
                isRestored ? `[啟動] 已自動重新開啟官方原版 Antigravity！` : `[啟動] 已自動開啟${msg('繁體中文', '简体中文')}版 Antigravity！`,
                isRestored ? `[启动] 已自动重新打开官方原版 Antigravity！` : `[启动] 已自动打开简体中文版 Antigravity！`
            ));
            return true;
        } catch (e) {
            console.warn(msg(`[啟動警告] 開啟 Antigravity 失敗: ${e.message}`, `[启动警告] 打开 Antigravity 失败: ${e.message}`));
            return false;
        } finally {
            if (tempVbsPath && fs.existsSync(tempVbsPath)) {
                try { fs.unlinkSync(tempVbsPath); } catch (_) {}
            }
        }
    } else if (process.platform === 'darwin') {
        try {
            if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
                child_process.exec(`sudo -u "${process.env.SUDO_USER}" open "${installDir}"`);
            } else {
                child_process.exec(`open "${installDir}"`);
            }
            console.log(msg(
                isRestored ? `[啟動] 已自動重新開啟官方原版 Antigravity！` : `[啟動] 已自動開啟${msg('繁體中文', '简体中文')}版 Antigravity！`,
                isRestored ? `[启动] 已自动重新打开官方原版 Antigravity！` : `[启动] 已自动打开简体中文版 Antigravity！`
            ));
            return true;
        } catch (e) {
            console.warn(msg(`[啟動警告] 開啟 Antigravity 失敗: ${e.message}`, `[启动警告] 打开 Antigravity 失败: ${e.message}`));
            return false;
        }
    }
    return false;
}

// ==========================================
// 入口
// ==========================================
function main() {
    let huifu = false;
    let manualDir = "";
    let noKill = false;

    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--huifu' || args[i] === '--restore') {
            huifu = true;
        } else if (args[i] === '--install-dir') {
            manualDir = args[i + 1] || "";
            i++;
        } else if (args[i] === '--no-kill') {
            noKill = true;
        } else if (args[i] === '--brand-title') {
            i++;
        } else if (args[i] === '--lang') {
            i++;
        }
    }

    if (IS_UNINSTALL_GUARD) {
        uninstallAutoGuard();
        process.exit(0);
    }

    // 1. 探测路径
    const installDir = detectInstallationDir(manualDir);

    // 3. 找到 resources 资源目录
    let resourcesDir = "";
    if (fs.existsSync(path.join(installDir, "resources"))) {
        resourcesDir = path.join(installDir, "resources");
    } else if (fs.existsSync(path.join(installDir, "Contents", "Resources"))) {
        resourcesDir = path.join(installDir, "Contents", "Resources");
    } else if (installDir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase().endsWith("/resources")) {
        resourcesDir = installDir;
    } else {
        if (fs.existsSync(path.join(installDir, "app.asar"))) {
            resourcesDir = installDir;
        } else {
            resourcesDir = path.join(installDir, "resources");
        }
    }

    if (!fs.existsSync(resourcesDir)) {
        console.error(msg(`[錯誤] 無法定位有效的資源(resources)目錄: ${resourcesDir}`, `[错误] 无法定位有效的资源(resources)目录: ${resourcesDir}`));
        process.exit(1);
    }

    const asarPath = path.join(resourcesDir, "app.asar");
    const targetLang = USE_TW ? 'tw' : 'cn';
    const langDisplay = msg('繁體中文', '简体中文');

    if (IS_CHECK_PATCH_NEEDED) {
        const st = inspectAsarStatus(asarPath);
        if (!st.valid) {
            process.exit(1);
        }
        const needsPatch = !st.isLocalized || st.installedLang !== targetLang || (process.platform === 'win32' && !st.hasUpdaterHook);
        process.exit(needsPatch ? 10 : 0);
    }

    if (IS_CHECK_ONLY) {
        const st = inspectAsarStatus(asarPath);
        const guardDir = getGuardDir();
        const watchdogReady = fs.existsSync(path.join(guardDir, 'update_watchdog.vbs')) &&
            fs.existsSync(path.join(guardDir, 'localization_engine.js'));
        const taskReady = isGuardTaskRegistered();
        const procSt = getRunningStatus(installDir);

        console.log(msg("====== Antigravity 中文化與自動偵測狀態檢查 ======", "====== Antigravity 汉化与自动检测状态检查 ======"));
        console.log(msg(`- 系統偵測語系: ${langDisplay} (來源=${DETECTED_LANG_INFO.source}, 原始值=${DETECTED_LANG_INFO.rawLocale}, 模式=${LANG_SELECTION_MODE})`,
                        `- 系统检测语系: ${langDisplay} (来源=${DETECTED_LANG_INFO.source}, 原始值=${DETECTED_LANG_INFO.rawLocale}, 模式=${LANG_SELECTION_MODE})`));
        console.log(msg(`- 安裝目錄: ${installDir}`, `- 安装目录: ${installDir}`));
        console.log(msg(`- ASAR 狀態: ${st.valid ? `正常 (v${st.version})` : `異常 (${st.reason})`}`,
                        `- ASAR 状态: ${st.valid ? `正常 (v${st.version})` : `异常 (${st.reason})`}`));
        const injectedLabel = !st.isLocalized
            ? msg('未注入（官方英文原版）', '未注入（官方英文原版）')
            : (st.installedLang === 'tw' ? msg('已注入（繁體中文）', '已注入（繁体中文）') : msg('已注入（简体中文）', '已注入（简体中文）'));
        console.log(msg(`- 漢化注入: ${injectedLabel}`, `- 汉化注入: ${injectedLabel}`));
        const hookLabel = !st.hasUpdaterHook
            ? msg('未注入', '未注入')
            : (st.hasLatestUpdaterHook ? msg('已注入 (V2 搶跑接管就緒)', '已注入 (V2 抢跑接管就绪)') : msg('已注入 (舊版 V1，閒置時將自動升級)', '已注入 (旧版 V1，空闲时将自动升级)'));
        console.log(msg(`- 更新即時偵測 Hook: ${hookLabel}`, `- 更新即时检测 Hook: ${hookLabel}`));
        if (process.platform === 'win32') {
            console.log(msg(`- 獨立看門狗鏡像: ${watchdogReady ? `就緒 (${guardDir})` : '未就緒'}`, `- 独立看门狗镜像: ${watchdogReady ? `就绪 (${guardDir})` : '未就绪'}`));
            console.log(msg(`- 背景排程守衛 (${GUARD_TASK_NAME}): ${taskReady ? '已啟用' : '未啟用'}`, `- 后台计划任务守卫 (${GUARD_TASK_NAME}): ${taskReady ? '已启用' : '未启用'}`));
        }
        console.log(msg(`- 當前進程狀態: Antigravity=${procSt.appRunning ? '運行中' : '未運行'}, 更新安裝器=${procSt.updaterRunning ? '運行中' : '未運行'}`,
                        `- 当前进程状态: Antigravity=${procSt.appRunning ? '运行中' : '未运行'}, 更新安装器=${procSt.updaterRunning ? '运行中' : '未运行'}`));
        const fullyReady = st.valid && st.isLocalized && st.installedLang === targetLang && (process.platform !== 'win32' || (st.hasUpdaterHook && watchdogReady && taskReady));
        process.exit(fullyReady ? 0 : 2);
    }

    if (IS_INSTALL_GUARD) {
        const guardOk = installAutoGuard(installDir);
        process.exit(guardOk ? 0 : 1);
    }

    // 2. 檢測用戶端或更新安裝器是否正在運行
    const runningStatus = getRunningStatus(installDir);
    wasAppRunning = runningStatus.appRunning || runningStatus.updaterRunning;
    if (!IS_TAKEOVER_POST_UPDATE && IS_AUTO_MODE && wasAppRunning) {
        console.log(msg(
            `[跳過] 自動模式偵測到進程運行中 (app=${runningStatus.appRunning}, updater=${runningStatus.updaterRunning})，安全待命不寫入。`,
            `[跳过] 自动模式检测到进程运行中 (app=${runningStatus.appRunning}, updater=${runningStatus.updaterRunning})，安全待命不写入。`
        ));
        process.exit(0);
    }

    if (runningStatus.updaterRunning) {
        console.error(msg(
            `[錯誤] 偵測到 Antigravity 官方更新安裝程式正在執行，請稍候十數秒待更新完成後再試。`,
            `[错误] 检测到 Antigravity 官方更新安装程序正在运行，请稍候十数秒待更新完成后再试。`
        ));
        process.exit(IS_TAKEOVER_POST_UPDATE ? 2 : 1);
    }

    if (!IS_QUIET) {
        console.log(msg(
            `[語系] 自動偵測結果: ${langDisplay} (${DICTS_FOLDER}/, 來源=${DETECTED_LANG_INFO.source}, 區域=${DETECTED_LANG_INFO.rawLocale})`,
            `[语系] 自动检测结果: ${langDisplay} (${DICTS_FOLDER}/, 来源=${DETECTED_LANG_INFO.source}, 区域=${DETECTED_LANG_INFO.rawLocale})`
        ));
    }

    let closedRunningApp = false;
    if ((IS_TAKEOVER_POST_UPDATE || (!IS_AUTO_MODE && !noKill)) && (runningStatus.appRunning || process.env.AG_TEST_TARGET_IMAGE)) {
        closedRunningApp = closeAntigravityProcesses({ installDir, waitForExitMs: 10000 });
    } else if (!IS_QUIET && noKill) {
        console.log(msg("[跳過] 偵測到 --no-kill 參數，跳過關閉 Antigravity 執行進程。", "[跳过] 检测到 --no-kill 参数，跳过关闭 Antigravity 运行进程。"));
    }

    ensureWritePermission(resourcesDir);

    // 4. 根據架構執行
    const isV2 = fs.existsSync(asarPath);
    let success = false;

    if (huifu) {
        console.log(msg("====== 正在卸載中文漢化，恢復官方原版 ======", "====== 正在卸载中文汉化，恢复官方原版 ======"));
        if (isV2) {
            success = restore20(resourcesDir);
        } else {
            success = restore10(installDir);
        }
        if (success) {
            restoreProxyIfNeeded(installDir);
            if (!IS_AUTO_MODE && process.platform === 'win32') {
                uninstallAutoGuard();
            }
        }
    } else {
        console.log(msg(`====== 正在安裝 Antigravity ${langDisplay}漢化 ======`, `====== 正在安装 Antigravity ${langDisplay}汉化 ======`));
        if (isV2) {
            success = install20(resourcesDir);
        } else {
            success = install10(installDir);
        }
        if (success) {
            injectProxyIfNeeded(installDir);
            if (!IS_AUTO_MODE && !IS_NO_GUARD && process.platform === 'win32') {
                installAutoGuard(installDir);
            }
        }
    }

    const shouldLaunch = IS_LAUNCH || (!IS_AUTO_MODE && !IS_TAKEOVER_POST_UPDATE && closedRunningApp);
    let launchedGui = false;
    if (success && shouldLaunch && (process.platform === 'win32' || process.platform === 'darwin')) {
        const afterStatus = getRunningStatus(installDir);
        if ((!afterStatus.appRunning && !afterStatus.updaterRunning) || process.env.AG_TEST_LAUNCH_RECORD_FILE) {
            launchedGui = launchAntigravityGui(installDir, huifu);
        }
    }

    if (success && !IS_QUIET && !IS_AUTO_MODE) {
        console.log("");
        console.log("======================================================================");
        if (huifu) {
            console.log(msg(" [成功] 已還原為 Antigravity 官方英文原版，並移除自動偵測守衛！", " [成功] 已还原为 Antigravity 官方英文原版，并移除自动检测守卫！"));
            if (launchedGui) {
                console.log(msg("  已自動關閉舊視窗、清理快取並重新啟動官方原版 Antigravity。", "  已自动关闭旧窗口、清理缓存并重新启动官方原版 Antigravity。"));
            }
        } else {
            console.log(msg(` [成功] Antigravity ${langDisplay}漢化與自動偵測引擎已部署完成！`, ` [成功] Antigravity ${langDisplay}汉化与自动检测引擎已部署完成！`));
            console.log("======================================================================");
            console.log(msg(
                `  本次採用字庫：${langDisplay}（偵測來源: ${DETECTED_LANG_INFO.source} / ${DETECTED_LANG_INFO.rawLocale}）`,
                `  本次采用字库：${langDisplay}（检测来源: ${DETECTED_LANG_INFO.source} / ${DETECTED_LANG_INFO.rawLocale}）`
            ));
            if (launchedGui) {
                console.log(msg("  1. 已自動關閉舊版視窗、清理快取並重新啟動 Antigravity，漢化已立即生效！", "  1. 已自动关闭旧版窗口、清理缓存并重新启动 Antigravity，汉化已立即生效！"));
            } else if (wasAppRunning && noKill) {
                console.log(msg("  1. 若目前 Antigravity 正在運行，請先【完全關閉所有視窗後重新開啟】一次，", "  1. 若当前 Antigravity 正在运行，请先【完全关闭所有窗口后重新打开】一次，"));
                console.log(msg("     更新自動偵測引擎與完整漢化即可立即載入生效。", "     更新自动检测引擎与完整汉化即可立即加载生效。"));
            } else {
                console.log(msg("  1. 部署已完成！現在打開 Antigravity 即可直接使用完整漢化與自動更新偵測。", "  1. 部署已完成！现在打开 Antigravity 即可直接使用完整汉化与自动更新检测。"));
            }
            console.log(msg("  2. 日後點擊「重新啟動以更新」時，看門狗會依當時系統語言自動恢復對應簡/繁中文並重開。", "  2. 日后点击「重启以更新」时，看门狗会按当时系统语言自动恢复对应简/繁中文并重开。"));
            console.log(msg("  3. 手動切換參數：強制繁體 --tw ｜ 強制簡體 --cn ｜ 狀態檢查 --check ｜ 還原英文 --restore", "  3. 手动切换参数：强制繁体 --tw ｜ 强制简体 --cn ｜ 状态检查 --check ｜ 还原英文 --restore"));
        }
        console.log("======================================================================");
    }

    if (!success) {
        process.exit(IS_AUTO_MODE ? 0 : 1);
    }
    process.exit(0);
}

if (require.main === module) {
    main();
}
module.exports = {
    loadDictionary,
    generateJs,
    normalizeText,
    readFilesFromAsar,
    surgicalPatchAsar,
    inspectAsarStatus,
    cleanUpdaterJsContent,
    detectSystemLanguage,
    classifyLocaleTag,
    closeAntigravityProcesses,
    getRunningStatus,
    launchAntigravityGui,
    buildLaunchGuiVbs,
    buildUpdateWatchdogVbs,
    buildGuardVbs,
    buildGuardTaskXml,
    SIGNATURE_START,
    UPDATER_HOOK_START,
    UPDATER_HOOK_VERSION_MARKER,
    UPDATER_HOOK_END
};
