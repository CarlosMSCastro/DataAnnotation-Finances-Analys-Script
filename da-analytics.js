// ==UserScript==
// @name         DataAnnotation - Analytics Dashboard
// @namespace    http://tampermonkey.net/
// @version      3.0
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
    const BLUE_DARK = '#004aaa';
    const BLUE_DIM = '#003d8f';

    let eurRate = null;
    let useEur = GM_getValue('useEur', false);
    let minimized = GM_getValue('minimized', false);
    let selectedMonth = null; // 'YYYY-M'

    // ── Taxa EUR via GM_xmlhttpRequest (evita CORS) ────────────────────────────
    function fetchEurRate() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.frankfurter.app/latest?from=USD&to=EUR',
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        eurRate = data.rates.EUR;
                    } catch(e) { eurRate = 0.92; }
                    resolve();
                },
                onerror: () => { eurRate = 0.92; resolve(); }
            });
        });
    }

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

        // Nível 1: clica só nos headers de dia
        statusEl.textContent = '⏳ A expandir dias...';
        document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
            if (dateRegex.test(el.textContent.trim())) el.click();
        });
        await sleep(1800);

        // Nível 2: clica só nos headers de projeto (não são datas)
        statusEl.textContent = '⏳ A expandir projetos...';
        document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
            if (!dateRegex.test(el.textContent.trim())) el.click();
        });
        await sleep(1800);

        statusEl.textContent = '⏳ A calcular...';
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ── Parser ─────────────────────────────────────────────────────────────────
    function parseData() {
        const dateRegex = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+$/;
        const monthMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
        const year = new Date().getFullYear();
        let days = [], currentDay = null, currentProj = null;

        const titleEls = document.querySelectorAll('[data-testid="cell-title"]');

        for (const titleEl of titleEls) {
            const titleText = titleEl.textContent.trim();
            const inner = titleEl.querySelector('[class*="tw-ml-"]');
            const cls = inner?.className || '';
            let level = 0;
            if (cls.includes('tw-ml-10')) level = 2;
            else if (cls.includes('tw-ml-5')) level = 1;

            const row = titleEl.closest('tr');
            const amountEl = row?.querySelector('[data-testid="cell-amount"]');
            const amountText = amountEl?.textContent?.trim() || '';
            const amount = parseFloat(amountText.replace(/^\$/, '').replace(/[^0-9.]/g, '')) || 0;

            if (level === 0 && dateRegex.test(titleText)) {
                const parts = titleText.split(' ');
                const dateObj = new Date(year, monthMap[parts[0]], parseInt(parts[1]));
                currentDay = { date: dateObj, dateStr: titleText, total: amount, projects: {} };
                currentProj = null;
                days.push(currentDay);
            } else if (level === 1 && currentDay && titleText !== 'Task Submission' && titleText !== 'Time Entry') {
                currentProj = titleText;
                if (!currentDay.projects[currentProj]) {
                    currentDay.projects[currentProj] = { total: amount, tasks: 0, minutes: 0, paid: false };
                } else {
                    currentDay.projects[currentProj].total = amount;
                }
            } else if (level === 2 && currentDay && currentProj) {
                const stripped = amountText.replace(/^\$\d+\.\d{2}/, '');
                let minutes = 0;
                const hMatch = stripped.match(/^(\d+)h\s*(\d+)?\s*min/);
                const mOnlyMatch = stripped.match(/^(\d+)\s*min/);
                if (hMatch) minutes = parseInt(hMatch[1]) * 60 + (hMatch[2] ? parseInt(hMatch[2]) : 0);
                else if (mOnlyMatch) minutes = parseInt(mOnlyMatch[1]);
                const paid = amountText.includes('Paid');
                if (amount > 0) {
                    currentDay.projects[currentProj].tasks++;
                    currentDay.projects[currentProj].minutes += minutes;
                    if (paid) currentDay.projects[currentProj].paid = true;
                }
            }
        }

        return days;
    }

    // ── Stats por mês ──────────────────────────────────────────────────────────
    function calcGlobal(days) {
        let grandTotal = 0, paid = 0, pending = 0;
        for (const day of days) {
            grandTotal += day.total;
            for (const proj of Object.values(day.projects)) {
                // paid detection: se alguma entry do proj foi paga
                if (proj.paid) paid += proj.total;
                else pending += proj.total;
            }
        }
        // fallback se projetos não foram expandidos
        if (paid === 0 && pending === 0) pending = grandTotal;
        return { grandTotal, paid, pending };
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
        const isCurrentMonth = yearN === now.getFullYear() && monthN === now.getMonth();
        const totalDaysInPeriod = isCurrentMonth ? now.getDate() : new Date(yearN, monthN + 1, 0).getDate();
        const workedDays = filtered.filter(d => d.total > 0).length;
        const zeroDays = totalDaysInPeriod - workedDays;
        return { total, minutes, days: totalDaysInPeriod, workedDays, zeroDays, bestDay, bestAmount, projects };
    }

    function getMonths(days) {
        const seen = new Set();
        const result = [];
        for (const day of days) {
            const key = `${day.date.getFullYear()}-${day.date.getMonth()}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ year: day.date.getFullYear(), month: day.date.getMonth(), key });
            }
        }
        return result;
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

    const KNOWN_PROJECTS = ['Kernel', 'Achilles', 'Styx', 'Thalia', 'Metis', 'Andesite', 'Pegasus', 'Argon'];
    const SURVEY_REGEX = /^\[Survey\]|^\[SURVEY\]|^\[QUALIFICATION\]|^\[Qualification\]|^\[TRAINING\]|^\[💰 PAID TRAINING\]|^Onboarding|^Additional Projects|^Write LONG/i;

    function projKey(title) {
        if (SURVEY_REGEX.test(title)) return 'DataAnnotation Survey';
        for (const p of KNOWN_PROJECTS) {
            if (title.includes(p)) return p;
        }
        let t = title
            .replace(/^\[PRIORITY\]\s*Rate and Review\s*\(\d+\):\s*/i, '')
            .replace(/^Rate And Review:\s*/i, '')
            .replace(/^Rate & Review:\s*/i, '')
            .replace(/^\[PRIORITY\]\s*/i, '')
            .replace(/^\[QUALIFICATION\]\s*/i, '')
            .replace(/^\[TRAINING\].*?-\s*/i, '')
            .replace(/^\[💰 PAID TRAINING\]\s*/i, '')
            .replace(/^\(Easy task!\)\s*/i, '')
            .replace(/^\[SURVEY\]\s*/i, '')
            .replace(/^\[Survey\]\s*/i, '')
            .replace(/\s*\[[^\]]*\][\s!]*$/g, '')
            .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{FE00}-\u{FEFF}]/gu, '')
            .trim();
        const dashIdx = t.indexOf(' - ');
        const colonIdx = t.indexOf(': ');
        if (dashIdx > 0 && (colonIdx < 0 || dashIdx <= colonIdx)) t = t.slice(0, dashIdx);
        else if (colonIdx > 0) t = t.slice(0, colonIdx);
        t = t.replace(/\s*[:]\s*$/, '').trim();
        return t || title;
    }

    const MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // ── Render ─────────────────────────────────────────────────────────────────
    function render(days, loading = false) {
        const old = document.getElementById('da-panel');
        if (old) old.remove();

        const global = calcGlobal(days);
        const months = getMonths(days);
        if (!selectedMonth && months.length > 0) selectedMonth = months[0].key;

        const panel = document.createElement('div');
        panel.id = 'da-panel';
        panel.style.cssText = `
            position:fixed;top:16px;right:16px;z-index:99999;
            width:620px;background:#0a0f1e;color:#e2e8f0;
            font-family:'JetBrains Mono','Fira Code','Courier New',monospace;
            font-size:15px;border-radius:16px;
            box-shadow:0 12px 48px rgba(0,0,0,0.75),0 0 0 1px rgba(0,93,204,0.4);
            overflow:hidden;
        `;

        function row(label, value, vstyle='color:#e2e8f0') {
            return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;">
                <span style="color:#94a3b8;font-size:15px;">${label}</span>
                <span style="font-weight:600;font-size:15px;${vstyle}">${value}</span>
            </div>`;
        }
        function section(icon, title) {
            return `<div style="color:${BLUE};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;
                margin-bottom:12px;border-bottom:1px solid #0d1a35;padding-bottom:6px;">${icon} ${title}</div>`;
        }

        // Botões de mês
        const monthBtns = months.map(m => {
            const active = m.key === selectedMonth;
            return `<button data-mkey="${m.key}" style="
                background:${active ? BLUE : '#0d1a35'};
                color:${active ? '#fff' : '#94a3b8'};
                border:1px solid ${active ? BLUE : '#1e3a5f'};
                border-radius:8px;padding:5px 14px;font-size:13px;
                cursor:pointer;font-family:inherit;font-weight:${active?'700':'400'};
                transition:all 0.15s;
            ">${MONTH_NAMES[m.month].slice(0,3)} ${m.year !== new Date().getFullYear() ? m.year : ''}</button>`;
        }).join('');

        // Dados do mês selecionado
        let monthContent = '';
        if (selectedMonth && !loading) {
            const [y, mo] = selectedMonth.split('-').map(Number);
            const ms = calcMonth(days, y, mo);

            const topProj = Object.entries(ms.projects)
                .filter(([,d]) => d.total > 0)
                .sort((a,b) => b[1].total - a[1].total)
                .slice(0, 10);

            const projRows = topProj.map(([name, d]) => {
                const safeName = name.replace(/"/g, '&quot;').replace(/</g, '&lt;');
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <div style="flex:1;min-width:0;">
                        <div style="color:#cbd5e1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px;" title="${safeName}">${safeName}</div>
                        <div style="color:#475569;font-size:12px;margin-top:1px;">
                            ${d.tasks > 0 ? `${d.tasks} tarefa${d.tasks>1?'s':''}` : '—'}
                            ${d.minutes > 0 ? ` · ${fmtH(d.minutes)}` : ''}
                            ${d.minutes > 0 ? ` · ${fmtRate(d.total, d.minutes)}` : ''}
                        </div>
                    </div>
                    <span style="color:#60a5fa;font-weight:700;font-size:15px;margin-left:12px;">${fmt(d.total)}</span>
                </div>`;
            }).join('');

            monthContent = `
                <div style="margin-bottom:20px;">
                    ${section('📅', MONTH_NAMES[mo])}
                    ${row('Total', fmt(ms.total), `color:#34d399;font-size:22px;font-weight:800;`)}
                    ${row('Dias trabalhados', `${ms.workedDays} / ${ms.days}`)}
                    ${row('Horas registadas', fmtH(ms.minutes))}
                    ${row(useEur ? '€/hora' : '$/hora', fmtRate(ms.total, ms.minutes))}
                    ${row('Dias com $0', ms.zeroDays, ms.zeroDays > 0 ? 'color:#f87171' : 'color:#34d399')}
                    ${ms.bestDay ? row('Melhor dia', `${ms.bestDay} (${fmt(ms.bestAmount)})`, 'color:#fbbf24') : ''}
                </div>
                ${topProj.length > 0 ? `
                <div>
                    ${section('🏆', 'Por projeto')}
                    ${projRows}
                </div>` : ''}
            `;
        } else if (loading) {
            monthContent = `<div id="da-status" style="color:#60a5fa;text-align:center;padding:20px 0;font-size:14px;">⏳ A carregar dados...</div>`;
        }

        panel.innerHTML = `
            <div id="da-hdr" style="background:linear-gradient(135deg,#001f5c,${BLUE_DARK});
                padding:18px 24px;display:flex;justify-content:space-between;align-items:center;
                cursor:pointer;border-bottom:1px solid rgba(0,93,204,0.4);">
                <span style="font-weight:800;font-size:18px;color:#93c5fd;letter-spacing:0.5px;">📊 DA Analytics</span>
                <div style="display:flex;gap:10px;align-items:center;">
                    <button id="da-curr" style="background:#001f5c;color:#93c5fd;border:1px solid #1e3a8a;
                        border-radius:8px;padding:5px 14px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:600;">
                        ${useEur ? '🇺🇸 USD' : '🇪🇺 EUR'}
                    </button>
                    <button id="da-collapse" style="background:#001f5c;color:#93c5fd;border:1px solid #1e3a8a;
                        border-radius:8px;padding:5px 14px;font-size:13px;cursor:pointer;font-family:inherit;">
                        ⬆ Colapsar
                    </button>
                    <span id="da-tog" style="color:#60a5fa;font-size:22px;line-height:1;user-select:none;margin-left:4px;">
                        ${minimized?'▼':'▲'}
                    </span>
                </div>
            </div>

            <div id="da-body" style="display:${minimized?'none':'block'};padding:22px 26px;max-height:84vh;overflow-y:auto;">

                <!-- Globais -->
                <div style="margin-bottom:20px;">
                    ${section('🌍', 'Totais globais')}
                    ${row('Total histórico', fmt(global.grandTotal), `color:#93c5fd;font-size:19px;font-weight:800;`)}
                    ${row('Pago', fmt(global.paid), 'color:#34d399')}
                    ${row('Pendente', fmt(global.pending), 'color:#fbbf24')}
                </div>

                <!-- Selector de mês -->
                <div style="margin-bottom:20px;">
                    ${section('📆', 'Mês')}
                    <div id="da-months" style="display:flex;flex-wrap:wrap;gap:8px;">
                        ${monthBtns}
                    </div>
                </div>

                <!-- Conteúdo do mês -->
                <div id="da-month-content">
                    ${monthContent}
                </div>

                <div style="color:#1e3a5f;font-size:11px;text-align:right;margin-top:10px;">
                    ${eurRate && useEur ? `1 USD = €${eurRate.toFixed(4)} · ` : ''}Atualizado: ${new Date().toLocaleTimeString('pt-PT')}
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // Toggle minimizar
        document.getElementById('da-hdr').addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const body = document.getElementById('da-body');
            const tog = document.getElementById('da-tog');
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            tog.textContent = hidden ? '▲' : '▼';
            minimized = !hidden;
            GM_setValue('minimized', minimized);
        });

        // Toggle moeda
        document.getElementById('da-curr').addEventListener('click', (e) => {
            e.stopPropagation();
            useEur = !useEur;
            GM_setValue('useEur', useEur);
            render(days);
        });

        // Reload
        document.getElementById('da-collapse').addEventListener('click', async (e) => {
            e.stopPropagation();
            const btn = document.getElementById('da-collapse');
            btn.textContent = '⏳';
            // colapsa tudo — clica nos expandidos (tw-ml-10 primeiro, depois tw-ml-5, depois tw-ml-0)
            // a forma mais simples: clicar em todos os cursor-pointer que estão expandidos
            // expandido = o svg tem rotate(-0.25turn) ou similar — mais fácil: clicar em tudo de dentro para fora
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const mlDiv = el.closest('[class*="tw-ml-"]');
                const cls = mlDiv?.className || '';
                if (cls.includes('tw-ml-10')) el.click();
            });
            await sleep(500);
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const mlDiv = el.closest('[class*="tw-ml-"]');
                const cls = mlDiv?.className || '';
                if (cls.includes('tw-ml-5')) el.click();
            });
            await sleep(500);
            document.querySelectorAll('[data-testid="cell-title"] .tw-cursor-pointer').forEach(el => {
                const mlDiv = el.closest('[class*="tw-ml-"]');
                const cls = mlDiv?.className || '';
                if (cls.includes('tw-ml-0')) el.click();
            });
            await sleep(300);
            btn.textContent = '⬆ Colapsar';
        });

        // Botões de mês
        document.getElementById('da-months').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mkey]');
            if (!btn) return;
            selectedMonth = btn.dataset.mkey;
            render(days);
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    async function init() {
        render([], true); // mostra loading
        if (!eurRate) await fetchEurRate();

        // Vai direto para Funds History
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

    setTimeout(init, 2000);

})();
