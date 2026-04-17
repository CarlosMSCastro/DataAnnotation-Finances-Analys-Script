// ==UserScript==
// @name         DataAnnotation - Analytics Dashboard
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Dashboard de analytics financeiro para DataAnnotation
// @match        https://app.dataannotation.tech/workers/payments*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.frankfurter.app
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const BLUE = '#005dcc';
    let eurRate = null;
    let useEur = GM_getValue('useEur', false);
    let selectedMonth = null;
    let cachedDays = [];

    // ── Taxa EUR ───────────────────────────────────────────────────────────────
    function fetchEurRate() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.frankfurter.app/latest?from=USD&to=EUR',
                onload: (res) => {
                    try { eurRate = JSON.parse(res.responseText).rates.EUR; }
                    catch(e) { eurRate = 0.92; }
                    resolve();
                },
                onerror: () => { eurRate = 0.92; resolve(); }
            });
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── Aguarda rows no DOM ────────────────────────────────────────────────────
    function waitForRows(callback, tries = 0) {
        const rows = document.querySelectorAll('[data-testid="cell-title"]');
        if (rows.length > 0) callback();
        else if (tries < 30) setTimeout(() => waitForRows(callback, tries + 1), 500);
    }

    // ── Auto-click "Include paid" ──────────────────────────────────────────────
    function clickIncludePaid() {
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Include paid');
        if (btn) btn.click();
    }

    // ── Expand todos os níveis ─────────────────────────────────────────────────
    async function expandAll(statusEl) {
        const dateRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+$/;
        statusEl.textContent = '⏳ A expandir dias...';
        document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
            if (dateRegex.test(el.textContent.trim())) el.click();
        });
        await sleep(1800);
        statusEl.textContent = '⏳ A expandir projetos...';
        document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
            if (!dateRegex.test(el.textContent.trim())) el.click();
        });
        await sleep(1800);
        statusEl.textContent = '⏳ A calcular...';
    }

    // ── Parser ─────────────────────────────────────────────────────────────────
    function parseData() {
        const dateRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+$/;
        const monthMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
        const year = new Date().getFullYear();
        let days = [], currentDay = null, currentProj = null;

        for (const titleEl of document.querySelectorAll('[data-testid="cell-title"]')) {
            const titleText = titleEl.textContent.trim();
            const inner = titleEl.querySelector('[class*="tw-ml-"]');
            const cls = inner?.className || '';
            let level = 0;
            if (cls.includes('tw-ml-10')) level = 2;
            else if (cls.includes('tw-ml-5')) level = 1;

            const row = titleEl.closest('tr');
            const amountText = row?.querySelector('[data-testid="cell-amount"]')?.textContent?.trim() || '';
            const amount = parseFloat(amountText.replace(/^\$/, '').replace(/[^0-9.]/g, '')) || 0;

            if (level === 0 && dateRegex.test(titleText)) {
                const parts = titleText.split(' ');
                currentDay = { date: new Date(year, monthMap[parts[0]], parseInt(parts[1])), dateStr: titleText, total: amount, projects: {} };
                currentProj = null;
                days.push(currentDay);
            } else if (level === 1 && currentDay && titleText !== 'Task Submission' && titleText !== 'Time Entry') {
                currentProj = titleText;
                if (!currentDay.projects[currentProj])
                    currentDay.projects[currentProj] = { total: amount, tasks: 0, minutes: 0, paid: false };
                else
                    currentDay.projects[currentProj].total = amount;
            } else if (level === 2 && currentDay && currentProj && amount > 0) {
                const stripped = amountText.replace(/^\$\d+\.\d{2}/, '');
                let minutes = 0;
                const hm = stripped.match(/^(\d+)h\s*(\d+)?\s*min/);
                const mm = stripped.match(/^(\d+)\s*min/);
                if (hm) minutes = parseInt(hm[1]) * 60 + (hm[2] ? parseInt(hm[2]) : 0);
                else if (mm) minutes = parseInt(mm[1]);
                currentDay.projects[currentProj].tasks++;
                currentDay.projects[currentProj].minutes += minutes;
                if (amountText.includes('Paid')) currentDay.projects[currentProj].paid = true;
            }
        }
        return days;
    }

    // ── Stats ──────────────────────────────────────────────────────────────────
    function calcGlobal(days) {
        let grandTotal = 0;
        for (const day of days) grandTotal += day.total;

        // lê paid/pending/transferrable diretamente do DOM (mais preciso)
        let paid = 0, pending = 0, transferrable = 0;
        document.querySelectorAll('[data-testid="cell-amount"]').forEach(el => {
            const t = el.textContent.trim();
            const amt = parseFloat(t.replace(/^\$/, '').replace(/[^0-9.]/g,'')) || 0;
            if (amt > 0 && t.includes('Paid')) paid += amt;
            if (amt > 0 && t.includes('Pending')) pending += amt;
            if (amt > 0 && t.includes('Transferrable')) transferrable += amt;
        });

        return { grandTotal, paid, pending, transferrable };
    }

    function calcMonth(days, yearN, monthN) {
        const filtered = days.filter(d => d.date.getFullYear() === yearN && d.date.getMonth() === monthN);
        let total = 0, minutes = 0, bestDay = null, bestAmount = 0;
        const projects = {};
        for (const day of filtered) {
            total += day.total;
            if (day.total > bestAmount) { bestAmount = day.total; bestDay = day.dateStr; }
            for (const [name, proj] of Object.entries(day.projects)) {
                const k = projKey(name);
                if (!projects[k]) projects[k] = { total: 0, tasks: 0, minutes: 0 };
                projects[k].total += proj.total;
                projects[k].tasks += proj.tasks;
                projects[k].minutes += proj.minutes;
                minutes += proj.minutes;
            }
        }
        const now = new Date();
        const isCurrent = yearN === now.getFullYear() && monthN === now.getMonth();
        const totalDays = isCurrent ? now.getDate() : new Date(yearN, monthN + 1, 0).getDate();
        const workedDays = filtered.filter(d => d.total > 0).length;
        return { total, minutes, days: totalDays, workedDays, zeroDays: totalDays - workedDays, bestDay, bestAmount, projects };
    }

    function getMonths(days) {
        const seen = new Set(), result = [];
        for (const day of days) {
            const key = `${day.date.getFullYear()}-${day.date.getMonth()}`;
            if (!seen.has(key)) { seen.add(key); result.push({ year: day.date.getFullYear(), month: day.date.getMonth(), key }); }
        }
        return result;
    }

    // ── projKey ────────────────────────────────────────────────────────────────
    const KNOWN_PROJECTS = ['Kernel', 'Achilles', 'Styx', 'Thalia', 'Metis', 'Andesite', 'Pegasus', 'Argon'];
    const SURVEY_REGEX = /^\[Survey\]|^\[SURVEY\]|^\[QUALIFICATION\]|^\[Qualification\]|^\[TRAINING\]|^\[💰 PAID TRAINING\]|^Onboarding|^Additional Projects|^Write LONG/i;

    function projKey(title) {
        if (SURVEY_REGEX.test(title)) return 'DataAnnotation Survey';
        for (const p of KNOWN_PROJECTS) { if (title.includes(p)) return p; }
        let t = title
            .replace(/^\[PRIORITY\]\s*Rate and Review\s*\(\d+\):\s*/i, '')
            .replace(/^Rate And Review:\s*/i, '')
            .replace(/^Rate & Review:\s*/i, '')
            .replace(/^\[PRIORITY\]\s*/i, '')
            .replace(/\s*\[[^\]]*\][\s!]*$/g, '')
            .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '')
            .trim();
        const di = t.indexOf(' - '), ci = t.indexOf(': ');
        if (di > 0 && (ci < 0 || di <= ci)) t = t.slice(0, di);
        else if (ci > 0) t = t.slice(0, ci);
        return t.replace(/\s*[:]\s*$/, '').trim() || title;
    }

    // ── Formatters ─────────────────────────────────────────────────────────────
    function fmt(v) {
        if (useEur && eurRate) return '€' + (v * eurRate).toFixed(2);
        return '$' + v.toFixed(2);
    }
    function fmtH(m) {
        if (!m) return '—';
        const h = Math.floor(m/60), min = m%60;
        return h > 0 ? `${h}h ${min}m` : `${min}m`;
    }
    function fmtRate(total, minutes) {
        if (!minutes) return '—';
        const sym = useEur && eurRate ? '€' : '$';
        const val = useEur && eurRate ? (total * eurRate) / (minutes/60) : total / (minutes/60);
        return sym + val.toFixed(2) + '/h';
    }

    const MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // ── Modal helpers ──────────────────────────────────────────────────────────
    function openModal() {
        const m = document.getElementById('da-modal');
        if (m) m.style.display = 'flex';
    }
    function closeModal() {
        const m = document.getElementById('da-modal');
        if (m) m.style.display = 'none';
    }

    // ── Injeta botão na navbar ─────────────────────────────────────────────────
    function injectNavButton(tries = 0) {
        if (document.getElementById('da-nav-btn')) return;
        const navList = document.querySelector('.navbar-collapse ul.navbar-nav');
        if (!navList || navList.children.length === 0) {
            if (tries < 30) setTimeout(() => injectNavButton(tries + 1), 300);
            return;
        }
        const onPayments = location.href.includes('/workers/payments');
        const li = document.createElement('li');
        li.innerHTML = `<a id="da-nav-btn" title="${onPayments ? '' : 'Vai para Transfer Funds para usar o Analytics'}"
            style="color:#fff;font-weight:600;font-size:14px;
            padding:8px 16px;display:block;text-decoration:none;
            opacity:${onPayments ? '0.9' : '0.5'};white-space:nowrap;
            cursor:${onPayments ? 'pointer' : 'not-allowed'};">
            📊 Analytics
        </a>`;
        navList.appendChild(li);
        const btn = document.getElementById('da-nav-btn');
        btn.addEventListener('click', (e) => {
            if (!location.href.includes('/workers/payments')) return;
            init();
        });
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    function render(days, loading = false) {
        cachedDays = days;
        const old = document.getElementById('da-modal');
        if (old) old.remove();

        const global = calcGlobal(days);
        const months = getMonths(days);
        if (!selectedMonth && months.length > 0) selectedMonth = months[0].key;

        function row(label, value, vstyle='color:#111827') {
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f3f4f6;">
                <span style="color:#6b7280;font-size:14px;">${label}</span>
                <span style="font-weight:600;font-size:14px;${vstyle}">${value}</span>
            </div>`;
        }
        function section(title) {
            return `<div style="color:${BLUE};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
                margin:20px 0 4px;padding-bottom:6px;border-bottom:2px solid ${BLUE};">${title}</div>`;
        }

        const monthBtns = months.map(m => {
            const active = m.key === selectedMonth;
            return `<button data-mkey="${m.key}" style="background:${active?BLUE:'#f3f4f6'};color:${active?'#fff':'#374151'};
                border:none;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer;font-weight:${active?'700':'400'};">
                ${MONTH_NAMES[m.month].slice(0,3)} ${m.year !== new Date().getFullYear() ? m.year : ''}
            </button>`;
        }).join('');

        let monthContent = '';
        if (selectedMonth && !loading) {
            const [y, mo] = selectedMonth.split('-').map(Number);
            const ms = calcMonth(days, y, mo);
            const topProj = Object.entries(ms.projects)
                .filter(([,d]) => d.total > 0)
                .sort((a,b) => b[1].total - a[1].total)
                .slice(0, 15);
            const projRows = topProj.map(([name, d]) => {
                const safe = name.replace(/"/g, '&quot;').replace(/</g, '&lt;');
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f3f4f6;">
                    <div style="flex:1;min-width:0;">
                        <div style="color:#111827;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${safe}">${safe}</div>
                        <div style="color:#9ca3af;font-size:12px;margin-top:2px;">
                            ${d.tasks > 0 ? `${d.tasks} tarefa${d.tasks>1?'s':''}` : '—'}${d.minutes > 0 ? ` · ${fmtH(d.minutes)} · ${fmtRate(d.total, d.minutes)}` : ''}
                        </div>
                    </div>
                    <span style="color:${BLUE};font-weight:700;font-size:14px;margin-left:16px;">${fmt(d.total)}</span>
                </div>`;
            }).join('');

            monthContent = `
                ${section(MONTH_NAMES[mo])}
                ${row('Total', fmt(ms.total), `color:${BLUE};font-size:20px;font-weight:800;`)}
                ${row('Dias trabalhados', `${ms.workedDays} / ${ms.days}`)}
                ${row('Horas registadas', fmtH(ms.minutes))}
                ${row(useEur ? '€/hora' : '$/hora', fmtRate(ms.total, ms.minutes))}
                ${row('Dias com $0', ms.zeroDays, ms.zeroDays > 0 ? 'color:#ef4444' : 'color:#16a34a')}
                ${ms.bestDay ? row('Melhor dia', `${ms.bestDay} (${fmt(ms.bestAmount)})`, 'color:#d97706') : ''}
                ${topProj.length > 0 ? `${section('Por projeto')}${projRows}` : ''}
            `;
        } else if (loading) {
            monthContent = `<div id="da-status" style="color:${BLUE};text-align:center;padding:30px 0;font-size:14px;">⏳ A carregar dados...</div>`;
        }

        const modal = document.createElement('div');
        modal.id = 'da-modal';
        modal.style.cssText = `
            position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;
            background:rgba(0,0,0,0.5);display:flex;align-items:flex-start;
            justify-content:center;padding:70px 16px 20px;box-sizing:border-box;
        `;
        modal.innerHTML = `
            <div style="background:#fff;border-radius:12px;width:100%;max-width:680px;
                max-height:calc(100vh - 90px);overflow:hidden;display:flex;flex-direction:column;
                box-shadow:0 20px 60px rgba(0,0,0,0.25);">
                <div style="background:${BLUE};padding:16px 20px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
                    <span style="font-weight:700;font-size:16px;color:#fff;">📊 DA Analytics</span>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button id="da-curr" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
                            border-radius:6px;padding:4px 12px;font-size:13px;cursor:pointer;font-weight:600;">
                            ${useEur ? '🇺🇸 USD' : '🇪🇺 EUR'}
                        </button>
                        <button id="da-collapse" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
                            border-radius:6px;padding:4px 12px;font-size:13px;cursor:pointer;">
                            ⬆ Colapsar
                        </button>
                        <button id="da-close" style="background:rgba(255,255,255,0.15);color:#fff;border:none;
                            border-radius:6px;padding:4px 10px;font-size:18px;cursor:pointer;line-height:1;">✕</button>
                    </div>
                </div>
                <div style="overflow-y:auto;padding:0 24px 24px;flex:1;">
                    ${section('Totais globais')}
                    ${row('Total histórico', fmt(global.grandTotal), `color:${BLUE};font-size:18px;font-weight:800;`)}
                    ${row('Pago (PayPal)', fmt(global.paid), 'color:#16a34a')}
                    ${row('Disponível p/ levantar', fmt(global.transferrable), 'color:#2563eb')}
                    ${row('Pendente aprovação', fmt(global.pending), 'color:#d97706')}
                    ${section('Mês')}
                    <div id="da-months" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;">
                        ${monthBtns}
                    </div>
                    <div id="da-month-content">${monthContent}</div>
                    <div style="color:#d1d5db;font-size:11px;text-align:right;margin-top:16px;">
                        ${eurRate && useEur ? `1 USD = €${eurRate.toFixed(4)} · ` : ''}Atualizado: ${new Date().toLocaleTimeString('pt-PT')}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        document.getElementById('da-close').addEventListener('click', closeModal);

        document.getElementById('da-curr').addEventListener('click', () => {
            useEur = !useEur;
            GM_setValue('useEur', useEur);
            render(cachedDays);
        });

        document.getElementById('da-collapse').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.textContent = '⏳';
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const cls = el.closest('[class*="tw-ml-"]')?.className || '';
                if (cls.includes('tw-ml-10')) el.click();
            });
            await sleep(500);
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const cls = el.closest('[class*="tw-ml-"]')?.className || '';
                if (cls.includes('tw-ml-5')) el.click();
            });
            await sleep(500);
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const cls = el.closest('[class*="tw-ml-"]')?.className || '';
                if (cls.includes('tw-ml-0')) el.click();
            });
            await sleep(300);
            btn.textContent = '⬆ Colapsar';
        });

        document.getElementById('da-months').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mkey]');
            if (!btn) return;
            selectedMonth = btn.dataset.mkey;
            render(cachedDays);
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    async function init() {
        render([], true);
        openModal();
        if (!eurRate) await fetchEurRate();

        // Navega para payments se necessário
        if (!location.href.includes('/workers/payments')) {
            window.location.href = 'https://app.dataannotation.tech/workers/payments';
            return;
        }

        const fundsTab = document.querySelector('a[href*="funds-history-tab"]');
        if (fundsTab) { fundsTab.click(); await sleep(800); }

        clickIncludePaid();
        await sleep(1500);

        waitForRows(async () => {
            const statusEl = document.getElementById('da-status') || { textContent: '' };
            await expandAll(statusEl);
            const days = parseData();
            render(days);
        });
    }

    // Injeta botão — nunca corre init automaticamente
    setTimeout(() => injectNavButton(), 2500);

})();
