const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 6822;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const TIMEZONE = 'Asia/Shanghai';

const BACKUP_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
    'https://corsproxy.io/?url='
];

let state = {
    proxyUrl: 'https://api.allorigins.win/raw?url=',
    targetUrl: '',
    keywords: '',
    intervalMinutes: 5,
    pushdeerKey: '',
    isRunning: false,
    isPaused: false,
    baselineHash: null,
    baselineLength: 0,
    totalChecks: 0,
    totalChanges: 0,
    lastCheckTime: null,
    nextCheckTime: null,
    logs: [],
    knownContexts: {}  // 存储已知的关键词上下文: { "关键词A": ["...上下文1...", "...上下文2..."] }
};

let checkTimer = null;
const MAX_LOGS = 80;

function getDate() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    return formatter.format(now);
}

function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const saved = JSON.parse(raw);
            Object.assign(state, saved);
            state.isRunning = false;
            state.isPaused = false;
            state.nextCheckTime = null;
            state.logs = Array.isArray(saved.logs) ? saved.logs.slice(-MAX_LOGS) : [];
            console.log(`[${getDate()}] 状态已加载`);
            return true;
        }
    } catch (e) {
        console.error('加载状态失败:', e.message);
    }
    return false;
}

function saveState() {
    try {
        const dataDir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        const toSave = { ...state, isRunning: false, isPaused: false, logs: state.logs.slice(-MAX_LOGS) };
        fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2));
    } catch (e) {
        console.error('保存状态失败:', e.message);
    }
}

function addLog(type, msg) {
    state.logs.push({ type, msg, time: Date.now() });
    if (state.logs.length > MAX_LOGS) state.logs = state.logs.slice(-MAX_LOGS);
    saveState();
    broadcastState();
}

function computeHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
    return hash.toString(36);
}

function extractText(html) {
    try {
        return html.replace(/<[^>]*>/g, ' ').replace(/[\s\n\r\t]+/g, ' ').trim();
    } catch (e) {
        return html.replace(/<[^>]*>/g, ' ').replace(/[\s\n\r\t]+/g, ' ').trim();
    }
}

function sanitizeForComparison(text, forHash = true) {
    let clean = text;
    clean = clean.replace(/\d{4}-\d{2}-\d{2}/g, '');
    clean = clean.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '');
    if (forHash) clean = clean.replace(/\d+/g, '');
    return clean.replace(/[\s\n\r\t]+/g, ' ').trim();
}

function checkKeywords(text, kwStr) {
    if (!kwStr.trim()) return { allFound: true, missing: [], kwList: [], newContexts: {} };
    const kwList = kwStr.trim().split(/\s+/).filter(k => k);
    const lower = text.toLowerCase();
    const missing = kwList.filter(k => !lower.includes(k.toLowerCase()));

    // 提取每个关键词的上下文
    const newContexts = {};
    const contextWindow = 30; // 关键词前后各取30个字符作为上下文

    for (const kw of kwList) {
        const kwLower = kw.toLowerCase();
        let index = lower.indexOf(kwLower);
        const contexts = [];

        while (index !== -1) {
            const start = Math.max(0, index - contextWindow);
            const end = Math.min(text.length, index + kw.length + contextWindow);
            const context = text.substring(start, end).replace(/\s+/g, ' ').trim();

            if (context.length >= kw.length + 4) { // 至少要有一些上下文
                contexts.push(context);
            }

            index = lower.indexOf(kwLower, index + 1);
        }

        newContexts[kw] = contexts;
    }

    return { allFound: missing.length === 0, missing, kwList, newContexts };
}

// 检查是否有新的上下文出现
function findNewContexts(newContexts, knownContexts) {
    const result = {};

    for (const [kw, contexts] of Object.entries(newContexts)) {
        const known = knownContexts[kw] || [];
        const knownSet = new Set(known.map(c => c.substring(0, 20) + '|' + c.length)); // 用前20字符+长度作为唯一标识
        const newOnes = contexts.filter(c => {
            const key = c.substring(0, 20) + '|' + c.length;
            return !knownSet.has(key);
        });

        if (newOnes.length > 0) {
            result[kw] = newOnes;
        }
    }

    return result;
}

// 合并新旧上下文
function mergeContexts(existing, newContexts) {
    const merged = { ...existing };

    for (const [kw, contexts] of Object.entries(newContexts)) {
        if (!merged[kw]) merged[kw] = [];

        const knownSet = new Set(merged[kw].map(c => c.substring(0, 20) + '|' + c.length));
        for (const c of contexts) {
            const key = c.substring(0, 20) + '|' + c.length;
            if (!knownSet.has(key)) {
                merged[kw].push(c);
                knownSet.add(key);
            }
        }
    }

    return merged;
}

async function fetchWithProxy(rawUrl, proxyTemplate) {
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const encodedUrl = encodeURIComponent(url);
    const finalUrl = proxyTemplate + encodedUrl;

    return new Promise((resolve, reject) => {
        const req = http.get(finalUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebMonitor/1.0)' },
            timeout: 25000
        }, (res) => {
            if (!res.ok && res.statusCode) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function fetchPage(url) {
    const customProxy = state.proxyUrl.trim();
    const proxies = customProxy
        ? [customProxy, ...BACKUP_PROXIES.filter(p => p !== customProxy)]
        : BACKUP_PROXIES;

    for (const proxy of proxies) {
        try {
            console.log(`[${getDate()}] 尝试代理: ${proxy.substring(0, 30)}...`);
            const html = await fetchWithProxy(url, proxy);
            return { success: true, html, proxyUsed: proxy };
        } catch (err) {
            console.warn(`代理失败: ${err.message}`);
            continue;
        }
    }

    try {
        let directUrl = url.trim();
        if (!/^https?:\/\//i.test(directUrl)) directUrl = 'https://' + directUrl;
        return new Promise((resolve, reject) => {
            const req = http.get(directUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebMonitor/1.0)' },
                timeout: 20000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ success: true, html: data, proxyUsed: '直连' }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function sendPushDeer(key, title, content) {
    if (!key.trim()) return { success: false };
    const params = new URLSearchParams({
        pushkey: key.trim(),
        text: title,
        desp: content,
        type: 'text'
    });
    const url = `https://api2.pushdeer.com/message/push?${params}`;

    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ success: true }));
        }).on('error', () => resolve({ success: true }));
    });
}

async function performCheck() {
    if (!state.targetUrl.trim()) return;

    const url = state.targetUrl.trim();
    console.log(`[${getDate()}] 开始检查: ${url}`);

    try {
        const result = await fetchPage(url);

        if (!result.success) {
            addLog('error', `获取失败: ${result.error}`);
            state.lastCheckTime = Date.now();
            state.totalChecks++;
        } else {
            const rawText = extractText(result.html);
            const hashText = sanitizeForComparison(rawText, true);
            const displayText = sanitizeForComparison(rawText, false);
            const hash = computeHash(hashText);
            state.lastCheckTime = Date.now();
            state.totalChecks++;

            const hasBaseline = state.baselineHash !== null;
            const changed = hasBaseline && (hash !== state.baselineHash);
            let shouldNotify = false;
            let newContextsFound = {};

            if (!hasBaseline) {
                // 首次建立基准
                state.baselineHash = hash;
                state.baselineLength = hashText.length;

                // 初始化已知上下文
                const kw = checkKeywords(displayText, state.keywords);
                state.knownContexts = kw.newContexts;

                addLog('system', `📌 基准已建立（长度: ${hashText.length}，代理: ${result.proxyUsed}）`);
                if (Object.keys(state.knownContexts).length > 0) {
                    addLog('system', `📌 关键词上下文已记录: ${Object.keys(state.knownContexts).join(', ')}`);
                }
            } else if (changed) {
                state.totalChanges++;

                // 检查关键词及其上下文
                const kw = checkKeywords(displayText, state.keywords);

                if (kw.allFound) {
                    // 查找新的上下文
                    newContextsFound = findNewContexts(kw.newContexts, state.knownContexts);
                    const hasNewContexts = Object.keys(newContextsFound).length > 0;

                    if (hasNewContexts) {
                        // 有新的上下文出现，推送通知
                        shouldNotify = true;

                        // 更新已知上下文
                        state.knownContexts = mergeContexts(state.knownContexts, kw.newContexts);

                        const newContextSamples = [];
                        for (const [kwWord, contexts] of Object.entries(newContextsFound)) {
                            newContextSamples.push(`${kwWord}: ${contexts[0].substring(0, 50)}...`);
                        }
                        addLog('change', `🔔 新上下文出现：${newContextSamples.join(' | ')}`);
                    } else {
                        addLog('change', `文本变化但无新上下文（关键词已在已知位置）`);
                    }
                } else {
                    addLog('change', `文本变化但关键词不匹配（缺失：${kw.missing.join(', ')}）`);
                }

                state.baselineHash = hash;
                state.baselineLength = hashText.length;
            } else {
                if (state.totalChecks % 15 === 0) {
                    addLog('info', `✅ 周期检查: 无变化`);
                }
            }

            if (shouldNotify) {
                let body = `发现新上下文:\n`;
                for (const [kw, contexts] of Object.entries(newContextsFound)) {
                    body += `【${kw}】${contexts[0]}\n`;
                }
                body += `\n时间: ${getDate()}`;

                if (state.pushdeerKey.trim()) {
                    const pushRes = await sendPushDeer(state.pushdeerKey, `🔔 网页新内容`, body);
                    if (pushRes.success) addLog('push', '📤 推送已发送');
                    else addLog('error', '推送失败');
                }
            }
        }
    } catch (e) {
        addLog('error', `异常: ${e.message}`);
        state.lastCheckTime = Date.now();
        state.totalChecks++;
    }

    saveState();
    broadcastState();

    if (state.isRunning && !state.isPaused) {
        scheduleNext();
    }
}

function scheduleNext() {
    if (checkTimer) clearTimeout(checkTimer);
    if (!state.isRunning || state.isPaused) return;

    const ms = state.intervalMinutes * 60000;
    state.nextCheckTime = Date.now() + ms;
    saveState();

    console.log(`[${getDate()}] 下次检查: ${new Date(state.nextCheckTime).toLocaleString('zh-CN', { timeZone: TIMEZONE })}`);

    checkTimer = setTimeout(() => {
        if (state.isRunning && !state.isPaused) {
            performCheck();
        }
    }, ms);
}

function start() {
    if (!state.targetUrl.trim().startsWith('http')) {
        return { success: false, message: '请输入有效网址' };
    }
    state.isRunning = true;
    state.isPaused = false;
    if ('Notification' in globalThis) Notification.requestPermission();
    saveState();
    addLog('system', `🚀 监控启动（间隔: ${state.intervalMinutes}分钟）`);
    performCheck();
    return { success: true };
}

function pause() {
    state.isPaused = true;
    if (checkTimer) clearTimeout(checkTimer);
    state.nextCheckTime = null;
    saveState();
    addLog('system', '⏸ 暂停');
    return { success: true };
}

function resume() {
    state.isPaused = false;
    saveState();
    addLog('system', '▶ 恢复');
    performCheck();
    return { success: true };
}

function resetBaseline() {
    state.baselineHash = null;
    state.baselineLength = 0;
    state.knownContexts = {};
    state.totalChecks = 0;
    state.totalChanges = 0;
    state.lastCheckTime = null;
    state.nextCheckTime = null;
    state.logs = [];
    saveState();
    addLog('system', '🔄 基准和上下文已重置');
    if (state.isRunning && !state.isPaused) performCheck();
    return { success: true };
}

async function testPush() {
    if (!state.pushdeerKey.trim()) {
        return { success: false, message: '请先填写Key' };
    }
    const res = await sendPushDeer(state.pushdeerKey, '🧪 测试', 'Web Monitor 服务器端测试消息');
    if (res.success) {
        addLog('push', '📤 测试推送已发送');
        return { success: true };
    }
    return { success: false };
}

async function handleRequest(req, res) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(200, headers);
        res.end();
        return;
    }

    if (req.url === '/api/state' && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
    }

    if (req.url === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                if (config.proxyUrl !== undefined) state.proxyUrl = config.proxyUrl;
                if (config.targetUrl !== undefined) state.targetUrl = config.targetUrl;
                if (config.keywords !== undefined) state.keywords = config.keywords;
                if (config.intervalMinutes !== undefined) state.intervalMinutes = Math.max(1, parseInt(config.intervalMinutes) || 5);
                if (config.pushdeerKey !== undefined) state.pushdeerKey = config.pushdeerKey;
                saveState();
                res.writeHead(200, headers);
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, headers);
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (req.url === '/api/start' && req.method === 'POST') {
        const result = start();
        res.writeHead(200, headers);
        res.end(JSON.stringify(result));
        return;
    }

    if (req.url === '/api/pause' && req.method === 'POST') {
        res.writeHead(200, headers);
        res.end(JSON.stringify(pause()));
        return;
    }

    if (req.url === '/api/resume' && req.method === 'POST') {
        res.writeHead(200, headers);
        res.end(JSON.stringify(resume()));
        return;
    }

    if (req.url === '/api/reset' && req.method === 'POST') {
        res.writeHead(200, headers);
        res.end(JSON.stringify(resetBaseline()));
        return;
    }

    if (req.url === '/api/test-push' && req.method === 'POST') {
        const result = await testPush();
        res.writeHead(200, headers);
        res.end(JSON.stringify(result));
        return;
    }

    if (req.url === '/api/check' && req.method === 'POST') {
        performCheck();
        res.writeHead(200, headers);
        res.end(JSON.stringify({ success: true }));
        return;
    }

    if (req.url === '/api/export' && req.method === 'GET') {
        const config = {
            proxyUrl: state.proxyUrl,
            targetUrl: state.targetUrl,
            keywords: state.keywords,
            intervalMinutes: state.intervalMinutes,
            pushdeerKey: state.pushdeerKey
        };
        res.writeHead(200, {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="web-monitor-config.json"'
        });
        res.end(JSON.stringify(config, null, 2));
        return;
    }

    if (req.url === '/api/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const config = JSON.parse(body);
                state.proxyUrl = config.proxyUrl || 'https://api.allorigins.win/raw?url=';
                state.targetUrl = config.targetUrl || '';
                state.keywords = config.keywords || '';
                state.intervalMinutes = config.intervalMinutes || 5;
                state.pushdeerKey = config.pushdeerKey || '';
                saveState();
                addLog('system', '📥 配置已导入');
                res.writeHead(200, headers);
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400, headers);
                res.end(JSON.stringify({ success: false, message: '文件格式错误' }));
            }
        });
        return;
    }

    if (req.url === '/api/clear-logs' && req.method === 'POST') {
        state.logs = [];
        saveState();
        res.writeHead(200, headers);
        res.end(JSON.stringify({ success: true }));
        return;
    }

    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml'
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
                if (err2) {
                    res.writeHead(404);
                    res.end('Not Found');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data2);
                }
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(data);
    });
}

const clients = [];

function broadcastState() {
    const stateJson = JSON.stringify(state);
    clients.forEach(client => {
        try {
            client.write(`data: ${stateJson}\n\n`);
        } catch (e) {}
    });
}

function setupSSE(req, res) {
    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    clients.push(res);
    res.write(`data: ${JSON.stringify(state)}\n\n`);

    req.on('close', () => {
        const index = clients.indexOf(res);
        if (index > -1) clients.splice(index, 1);
    });
}

const server = http.createServer((req, res) => {
    if (req.url === '/api/events') {
        setupSSE(req, res);
    } else {
        handleRequest(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 网页变动监控器已启动`);
    console.log(`📍 访问地址: http://localhost:${PORT}`);
    console.log(`🌐 时区: ${TIMEZONE}`);
    console.log(`========================================`);
    loadState();

    if (state.isRunning && !state.isPaused) {
        console.log('📡 检测到之前的监控任务，正在恢复...');
        scheduleNext();
    }
});

process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，正在保存状态...');
    saveState();
    if (checkTimer) clearTimeout(checkTimer);
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('收到 SIGINT 信号，正在保存状态...');
    saveState();
    process.exit(0);
});
