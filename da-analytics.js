// ==UserScript==
// @name         DataAnnotation - Analytics Dashboard
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Dashboard de analytics financeiro para DataAnnotation
// @match        https://app.dataannotation.tech/workers/payments*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.frankfurter.app
// @connect      frankfurter.app
// @connect      daanalysisdump.free.nf
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const BLUE = '#005dcc';
    const API_URL = 'https://daanalysisdump.free.nf/data.php';
    const AUTH_TOKEN = '2CH3aj';

    let eurRate = null;
    let selectedMonth = null;
    let cachedDays = [];
    let remoteData = {};

    // ── Dados históricos hardcoded (não aparecem no DOM) ───────────────────────
    const FALLBACK_DAYS = [
        {
            dateStr: 'Mar 26',
            date: '2026-03-26',
            total: 5.00,
            projects: {
                'DataAnnotation Survey': { total: 5.00, tasks: 1, minutes: 0, paid: true }
            }
        }
    ];

    const KNOWN_PAYMENTS = [
        { date: '2026-04-01', usd: 15.00,   eur: 12.58,  rate: 0.8387, manual: true },
        { date: '2026-04-06', usd: 36.00,   eur: 30.23,  rate: 0.8398, manual: true },
        { date: '2026-04-09', usd: 142.44,  eur: 117.86, rate: 0.8274, manual: true },
        { date: '2026-04-12', usd: 124.03,  eur: 102.48, rate: 0.8262, manual: true },
        { date: '2026-04-15', usd: 395.69,  eur: 324.94, rate: 0.8212, manual: true },
        { date: '2026-04-18', usd: 361.79,  eur: 297.63, rate: 0.8227, manual: true },
    ];

    // ── Remote storage ─────────────────────────────────────────────────────────
    function remoteGet() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: API_URL,
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    try { resolve(JSON.parse(res.responseText)); }
                    catch(e) { resolve({}); }
                },
                onerror: () => resolve({}),
                ontimeout: () => resolve({})
            });
        });
    }

    function remoteSet(data) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Auth-Token': AUTH_TOKEN
                },
                data: JSON.stringify(data),
                onload: () => resolve(true),
                onerror: () => resolve(false),
                ontimeout: () => resolve(false)
            });
        });
    }

    // ── Local payments storage ─────────────────────────────────────────────────
    function getPayments() {
        if (remoteData.payments && remoteData.payments.length > 0) return remoteData.payments;
        try { return JSON.parse(GM_getValue('payments', '[]')); } catch(e) { return []; }
    }

    function savePayments(payments) {
        remoteData.payments = payments;
        GM_setValue('payments', JSON.stringify(payments));
        remoteSet(remoteData);
    }

    function initPayments() {
        const existing = getPayments();
        let changed = false;
        for (const kp of KNOWN_PAYMENTS) {
            if (!existing.find(p => p.date === kp.date && p.usd === kp.usd)) {
                existing.push(kp);
                changed = true;
            }
        }
        if (changed || existing.length === 0) {
            existing.sort((a,b) => a.date.localeCompare(b.date));
            savePayments(existing);
        }
    }

    // ── Taxa EUR ───────────────────────────────────────────────────────────────
    function fetchEurRate() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://api.frankfurter.app/latest?from=USD&to=EUR',
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    try { eurRate = JSON.parse(res.responseText).rates.EUR; }
                    catch(e) { eurRate = 0.8545; }
                    resolve();
                },
                onerror: () => { eurRate = 0.8545; resolve(); },
                ontimeout: () => { eurRate = 0.8545; resolve(); }
            });
        });
    }

    function fetchRateForDate(dateStr) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.frankfurter.app/${dateStr}?from=USD&to=EUR`,
                headers: { 'Accept': 'application/json' },
                onload: (res) => {
                    try { resolve(JSON.parse(res.responseText).rates.EUR || null); }
                    catch(e) { resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function waitForRows(callback, tries = 0) {
        const rows = document.querySelectorAll('[data-testid="cell-title"]');
        if (rows.length > 0) callback();
        else if (tries < 30) setTimeout(() => waitForRows(callback, tries + 1), 500);
    }

    function clickIncludePaid() {
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Include paid');
        if (btn) btn.click();
    }

    async function setPerPage500(tries = 0) {
        const current = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '20');
        if (!current) return;
        current.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        await sleep(500);
        const btn500 = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '500');
        if (btn500) {
            btn500.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            await sleep(1000);
            const stillOn20 = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '20');
            if (stillOn20 && tries < 3) await setPerPage500(tries + 1);
        } else if (tries < 3) {
            await setPerPage500(tries + 1);
        }
    }

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
                const dateObj = new Date(year, monthMap[parts[0]], parseInt(parts[1]));
                const dateISO = `${year}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}`;
                currentDay = { date: dateObj, dateStr: titleText, dateISO, total: amount, projects: {} };
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

    // ── Merge DOM + remote + fallback ──────────────────────────────────────────
    function mergeDays(domDays) {
        const remoteDays = remoteData.days || [];
        const merged = [...domDays];
        const domDates = new Set(domDays.map(d => d.dateISO));

        for (const rd of remoteDays) {
            if (!domDates.has(rd.dateISO)) {
                merged.push({
                    date: new Date(rd.dateISO),
                    dateStr: rd.dateStr,
                    dateISO: rd.dateISO,
                    total: rd.total,
                    projects: rd.projects || {}
                });
            }
        }

        for (const fb of FALLBACK_DAYS) {
            if (!domDates.has(fb.date) && !remoteDays.find(r => r.dateISO === fb.date)) {
                merged.push({
                    date: new Date(fb.date),
                    dateStr: fb.dateStr,
                    dateISO: fb.date,
                    total: fb.total,
                    projects: fb.projects
                });
            }
        }

        merged.sort((a, b) => b.date - a.date);
        return merged;
    }

    // ── Guarda no remote ───────────────────────────────────────────────────────
    function persistDays(days) {
        remoteData.days = days.map(d => ({
            dateISO: d.dateISO,
            dateStr: d.dateStr,
            total: d.total,
            projects: d.projects
        }));
        remoteSet(remoteData);
    }

    // ── Stats ──────────────────────────────────────────────────────────────────
    function calcGlobal(days) {
        let grandTotal = 0;
        const totalEl = Array.from(document.querySelectorAll('div.tw-text-4xl'))
            .find(el => el.textContent.includes('$'));
        if (totalEl) {
            grandTotal = parseFloat(totalEl.textContent.replace(/[^0-9.]/g, '')) || 0;
        } else {
            for (const day of days) grandTotal += day.total;
        }

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
        return { total, minutes, days: totalDays, workedDays, bestDay, bestAmount, projects };
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
    function fmt(v) { return '$' + v.toFixed(2); }
    function fmtH(m) {
        if (!m) return '—';
        const h = Math.floor(m/60), min = m%60;
        return h > 0 ? `${h}h ${min}m` : `${min}m`;
    }
    function fmtRate(total, minutes) {
        if (!minutes) return '—';
        return '$' + (total / (minutes/60)).toFixed(2) + '/h';
    }

    const MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    function openModal() { const m = document.getElementById('da-modal'); if (m) m.style.display = 'flex'; }
    function closeModal() { const m = document.getElementById('da-modal'); if (m) m.style.display = 'none'; }

    function injectNavButton() {
        if (document.getElementById('da-nav-btn')) return;

        const nav = document.querySelector('ul.nav.navbar-nav.mr-auto');
        if (!nav) return;

        const li = document.createElement('li');

        li.innerHTML = `
        <a id="da-nav-btn" class="nav-link" style="
            color:#fff;
            font-weight:600;
            font-size:14px;
            padding:8px 16px;
            display:block;
            cursor:pointer;
        ">
            📊 Analytics
        </a>
    `;

        nav.appendChild(li);

        document.getElementById('da-nav-btn').onclick = init;
    }

    // OBSERVER → isto é o que faltava
    const observer = new MutationObserver(() => {
        injectNavButton();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // primeira tentativa
    injectNavButton();
    // ── Render ─────────────────────────────────────────────────────────────────
    function render(days, loading = false) {
        cachedDays = days;
        const old = document.getElementById('da-modal');
        if (old) old.remove();

        const global = calcGlobal(days);
        const months = getMonths(days);
        if (!selectedMonth && months.length > 0) selectedMonth = months[0].key;
        const payments = getPayments().sort((a,b) => b.date.localeCompare(a.date));
        const totalEurWise = payments.filter(p => p.eur > 0).reduce((s, p) => s + p.eur, 0);

        function row(label, value, vstyle='color:#111827') {
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f3f4f6;">
                <span style="color:#6b7280;font-size:14px;">${label}</span>
                <span style="font-weight:600;font-size:14px;${vstyle}">${value}</span>
            </div>`;
        }
        function section(title, extra='') {
            return `<div style="display:flex;justify-content:space-between;align-items:center;color:${BLUE};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
                margin:20px 0 4px;padding-bottom:6px;border-bottom:2px solid ${BLUE};">
                <span>${title}</span>${extra}
            </div>`;
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

            // ── Heatmap ──────────────────────────────────────────────────────
            const daysInMonth = new Date(y, mo + 1, 0).getDate();
            const firstDow = new Date(y, mo, 1).getDay();
            const filteredDays = days.filter(d => d.date.getFullYear() === y && d.date.getMonth() === mo);
            const dayMap = {};
            for (const d of filteredDays) dayMap[d.date.getDate()] = d;
            const maxVal = Math.max(...filteredDays.map(d => d.total), 1);

            function heatColor(val) {
                if (!val || val === 0) return '#d1d5db';
                const pct = val / maxVal;
                if (pct < 0.25) return '#93c5fd';
                if (pct < 0.5)  return '#3b82f6';
                if (pct < 0.75) return '#1d4ed8';
                return '#1e3a8a';
            }

            function textColor(val) {
                if (!val || val === 0) return '#6b7280';
                const pct = val / maxVal;
                return pct < 0.25 ? '#1e40af' : '#fff';
            }

            const dowLabels = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
            const dowHeader = dowLabels.map(l => `<div style="font-size:9px;color:#9ca3af;text-align:center;font-weight:600;padding-bottom:2px;">${l}</div>`).join('');

            const today = new Date();
            const todayDay = (today.getFullYear() === y && today.getMonth() === mo) ? today.getDate() : -1;

            let cells = '';
            for (let i = 0; i < firstDow; i++) {
                cells += `<div style="aspect-ratio:1;"></div>`;
            }
            for (let d = 1; d <= daysInMonth; d++) {
                const isFuture = (y > today.getFullYear()) ||
                    (y === today.getFullYear() && mo > today.getMonth()) ||
                    (y === today.getFullYear() && mo === today.getMonth() && d > today.getDate());
                const isToday = d === todayDay;
                const dayData = dayMap[d];
                const val = isFuture ? null : (dayData?.total || 0);
                const mins = Object.values(dayData?.projects || {}).reduce((s,p) => s + (p.minutes||0), 0);
                const tooltipText = isFuture ? 'Dia futuro' : (val > 0
                    ? `$${val.toFixed(2)}${mins > 0 ? ' · ' + Math.floor(mins/60) + 'h ' + (mins%60) + 'm' : ''}`
                    : 'Sem atividade');
                const bg = isFuture ? '#f3f4f6' : heatColor(val);
                const tc = isFuture ? '#d1d5db' : textColor(val);
                const border = isToday ? `box-shadow:0 0 0 2px #f59e0b;` : '';
                cells += `<div class="da-heat-cell" data-tip="${tooltipText}" style="
                    background:${bg};border-radius:4px;
                    display:flex;align-items:center;justify-content:center;
                    aspect-ratio:1;cursor:default;position:relative;
                    font-size:10px;font-weight:${isToday ? '800' : '600'};color:${tc};
                    transition:transform 0.08s;${border}
                ">${d}</div>`;
            }

            const heatmap = `
                <style>
                    .da-heat-cell:hover { transform: scale(1.25); z-index: 2; }
                    .da-heat-cell:hover::after {
                        content: attr(data-tip);
                        position: absolute;
                        bottom: calc(100% + 4px);
                        left: 50%;
                        transform: translateX(-50%);
                        background: #111827;
                        color: #fff;
                        font-size: 11px;
                        padding: 3px 7px;
                        border-radius: 4px;
                        white-space: nowrap;
                        pointer-events: none;
                        z-index: 999;
                    }
                </style>
                <div style="margin:12px 0 8px;">
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px;">${dowHeader}</div>
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">${cells}</div>
                    <div style="display:flex;gap:4px;align-items:center;margin-top:8px;justify-content:flex-end;">
                        <span style="font-size:10px;color:#9ca3af;">Futuro</span>
                        <div style="width:12px;height:12px;background:#f3f4f6;border-radius:2px;"></div>
                        <span style="font-size:10px;color:#9ca3af;margin-left:4px;">Sem ativ.</span>
                        ${['#d1d5db','#93c5fd','#3b82f6','#1d4ed8','#1e3a8a'].map(c => `<div style="width:12px;height:12px;background:${c};border-radius:2px;"></div>`).join('')}
                        <span style="font-size:10px;color:#9ca3af;">Mais</span>
                        <div style="width:12px;height:12px;background:#fff;border-radius:2px;box-shadow:0 0 0 2px #f59e0b;margin-left:4px;"></div>
                        <span style="font-size:10px;color:#9ca3af;">Hoje</span>
                    </div>
                </div>`;

            // ── Projetos: top 3 + expandir ────────────────────────────────────
            const topProj = Object.entries(ms.projects)
                .filter(([,d]) => d.total > 0)
                .sort((a,b) => b[1].total - a[1].total);

            function projRow(name, d) {
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
            }

            const top3 = topProj.slice(0, 3).map(([n,d]) => projRow(n,d)).join('');
            const rest = topProj.slice(3).map(([n,d]) => projRow(n,d)).join('');
            const moreBtn = topProj.length > 3 ? `
                <div id="da-proj-more" style="display:none;">${rest}</div>
                <button id="da-proj-toggle" data-count="${topProj.length - 3}" style="width:100%;margin-top:8px;background:#f3f4f6;color:#374151;border:none;
                    border-radius:6px;padding:6px;font-size:13px;cursor:pointer;">
                    + ${topProj.length - 3} mais projetos
                </button>` : '';

            const projContent = topProj.length > 0 ? `${section('Por projeto')}${top3}${moreBtn}` : '';

            monthContent = `
                ${section(MONTH_NAMES[mo])}
                ${heatmap}
                ${row('Total', '$' + ms.total.toFixed(2), `color:${BLUE};font-size:20px;font-weight:800;`)}
                ${row('Dias trabalhados', `${ms.workedDays} / ${ms.days}`)}
                ${row('Horas registadas', fmtH(ms.minutes))}
                ${row('$/hora', fmtRate(ms.total, ms.minutes))}
                ${ms.bestDay ? row('Melhor dia', `${ms.bestDay} ($${ms.bestAmount.toFixed(2)})`, 'color:#d97706') : ''}
                ${projContent}
            `;
        } else if (loading) {
            monthContent = `<div id="da-status" style="color:${BLUE};text-align:center;padding:30px 0;font-size:14px;">⏳ A carregar dados...</div>`;
        }

        const paymentsRows = payments.map((p, i) => `
            <div style="display:grid;grid-template-columns:90px 70px 70px 70px 1fr 24px;gap:4px;padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;align-items:center;">
                <span style="color:#6b7280;">${p.date}</span>
                <span style="color:#111827;font-weight:600;">$${p.usd.toFixed(2)}</span>
                <span style="color:${p.eur > 0 ? '#16a34a' : '#9ca3af'};font-weight:600;">${p.eur > 0 ? '€' + p.eur.toFixed(2) : '—'}</span>
                <span style="color:#9ca3af;">${p.rate > 0 ? p.rate.toFixed(4) : '—'}</span>
                <span style="color:${p.manual ? '#d97706' : '#2563eb'};font-size:11px;">${p.manual ? '✏️' : '🤖'}</span>
                <button data-del-idx="${i}" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0;line-height:1;">✕</button>
            </div>`).join('');

        const addPaymentForm = `
            <div id="da-add-payment" style="background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:12px;margin-top:12px;display:none;">
                <div style="font-size:13px;font-weight:600;color:${BLUE};margin-bottom:8px;">Registar pagamento</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
                    <div><label style="font-size:11px;color:#6b7280;">Data</label><br>
                        <input id="da-p-date" type="date" style="width:100%;border:1px solid #d1d5db;border-radius:4px;padding:4px;font-size:13px;box-sizing:border-box;"></div>
                    <div><label style="font-size:11px;color:#6b7280;">USD (DA)</label><br>
                        <input id="da-p-usd" type="number" placeholder="0.00" step="0.01" style="width:100%;border:1px solid #d1d5db;border-radius:4px;padding:4px;font-size:13px;box-sizing:border-box;"></div>
                    <div><label style="font-size:11px;color:#6b7280;">EUR (Wise)</label><br>
                        <input id="da-p-eur" type="number" placeholder="0.00" step="0.01" style="width:100%;border:1px solid #d1d5db;border-radius:4px;padding:4px;font-size:13px;box-sizing:border-box;"></div>
                </div>
                <div style="display:flex;gap:8px;">
                    <button id="da-p-auto" style="flex:1;background:${BLUE};color:#fff;border:none;border-radius:6px;padding:6px;font-size:13px;cursor:pointer;">🤖 Buscar taxa auto</button>
                    <button id="da-p-save" style="flex:1;background:#16a34a;color:#fff;border:none;border-radius:6px;padding:6px;font-size:13px;cursor:pointer;">💾 Guardar</button>
                    <button id="da-p-cancel" style="background:#f3f4f6;color:#374151;border:none;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;">✕</button>
                </div>
                <div id="da-p-status" style="font-size:12px;color:#6b7280;margin-top:6px;"></div>
            </div>`;

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
                        <button id="da-collapse" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
                            border-radius:6px;padding:4px 12px;font-size:13px;cursor:pointer;">⬆ Colapsar</button>
                        <button id="da-close" style="background:rgba(255,255,255,0.15);color:#fff;border:none;
                            border-radius:6px;padding:4px 10px;font-size:18px;cursor:pointer;line-height:1;">✕</button>
                    </div>
                </div>
                <div style="overflow-y:auto;padding:0 24px 24px;flex:1;">
                    ${section('Totais globais')}
                    ${row('Total histórico', '$' + global.grandTotal.toFixed(2), `color:${BLUE};font-size:18px;font-weight:800;`)}
                    ${row('Pago pelo DA', '$' + global.paid.toFixed(2), 'color:#16a34a')}
                    ${row('Recebido na Wise', '€' + totalEurWise.toFixed(2), 'color:#16a34a')}
                    ${eurRate ? row('Estimativa próx. levantamento', '~€' + (global.transferrable * eurRate * 0.9717).toFixed(2) + '<span style="color:#9ca3af;font-size:11px;font-weight:400;margin-left:6px;">±€8</span>', 'color:#2563eb') : ''}
                    ${row('Disponível p/ levantar', '$' + global.transferrable.toFixed(2), 'color:#2563eb')}
                    ${row('Pendente aprovação', '$' + global.pending.toFixed(2), 'color:#d97706')}

                    ${section('Mês')}
                    <div id="da-months" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;">
                        ${monthBtns}
                    </div>
                    <div id="da-month-content">${monthContent}</div>

                    ${section('Pagamentos PayPal → Wise', '<button id="da-pay-toggle" style="background:' + BLUE + ';color:#fff;border:none;border-radius:4px;padding:2px 10px;font-size:11px;cursor:pointer;">Verificar pagamentos</button>')}
                    <div id="da-pay-section" style="display:none;">
                    <div style="display:grid;grid-template-columns:90px 70px 70px 70px 1fr 24px;gap:4px;padding:5px 0;font-size:11px;color:#9ca3af;font-weight:600;">
                        <span>Data</span><span>USD</span><span>EUR Wise</span><span>Taxa</span><span></span><span></span>
                    </div>
                    ${paymentsRows}
                    <button id="da-add-btn" style="margin-top:8px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer;">+ Registar pagamento</button>
                    ${addPaymentForm}
                    </div>

                    <div style="color:#d1d5db;font-size:11px;text-align:right;margin-top:16px;">
                        ${eurRate ? `taxa live: 1 USD = €${eurRate.toFixed(4)} · ` : ''}Atualizado: ${new Date().toLocaleTimeString('pt-PT')}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
        document.getElementById('da-close').addEventListener('click', closeModal);

        document.getElementById('da-pay-toggle').addEventListener('click', () => {
            const sec = document.getElementById('da-pay-section');
            sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
        });

        const projToggle = document.getElementById('da-proj-toggle');
        if (projToggle) {
            projToggle.addEventListener('click', () => {
                const more = document.getElementById('da-proj-more');
                const visible = more.style.display !== 'none';
                more.style.display = visible ? 'none' : 'block';
                projToggle.textContent = visible
                    ? `+ ${projToggle.dataset.count} mais projetos`
                    : 'Ver menos';
            });
        }

        modal.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-del-idx]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.delIdx);
            const existing = getPayments().sort((a,b) => b.date.localeCompare(a.date));
            existing.splice(idx, 1);
            existing.sort((a,b) => a.date.localeCompare(b.date));
            savePayments(existing);
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

        document.getElementById('da-add-btn').addEventListener('click', () => {
            const form = document.getElementById('da-add-payment');
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
            document.getElementById('da-p-date').value = new Date().toISOString().split('T')[0];
        });

        document.getElementById('da-p-cancel').addEventListener('click', () => {
            document.getElementById('da-add-payment').style.display = 'none';
        });

        document.getElementById('da-p-auto').addEventListener('click', async () => {
            const dateVal = document.getElementById('da-p-date').value;
            const usdVal = parseFloat(document.getElementById('da-p-usd').value) || 0;
            const status = document.getElementById('da-p-status');
            if (!dateVal) { status.textContent = '⚠️ Introduz a data primeiro.'; return; }
            status.textContent = '⏳ A buscar taxa...';
            const rate = await fetchRateForDate(dateVal);
            if (rate) {
                if (usdVal > 0) {
                    const estimated = (usdVal * rate * 0.9717).toFixed(2);
                    document.getElementById('da-p-eur').value = estimated;
                    status.textContent = `✓ Taxa ${rate.toFixed(4)} · EUR estimado: €${estimated} (spread PayPal 2.83%)`;
                } else {
                    status.textContent = `✓ Taxa encontrada: ${rate.toFixed(4)}`;
                }
            } else {
                status.textContent = '⚠️ Não foi possível buscar a taxa. Introduz o EUR manualmente.';
            }
        });

        document.getElementById('da-p-save').addEventListener('click', () => {
            const dateVal = document.getElementById('da-p-date').value;
            const usdVal = parseFloat(document.getElementById('da-p-usd').value) || 0;
            const eurVal = parseFloat(document.getElementById('da-p-eur').value) || 0;
            const status = document.getElementById('da-p-status');
            if (!dateVal || usdVal <= 0 || eurVal <= 0) { status.textContent = '⚠️ Preenche todos os campos.'; return; }
            const rate = parseFloat((eurVal / usdVal).toFixed(4));
            const existing = getPayments();
            existing.push({ date: dateVal, usd: usdVal, eur: eurVal, rate, manual: true });
            existing.sort((a,b) => a.date.localeCompare(b.date));
            savePayments(existing);
            render(cachedDays);
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    async function init() {
        render([], true);
        openModal();

        const status = document.getElementById('da-status');
        if (status) status.textContent = '⏳ A carregar histórico...';
        remoteData = await remoteGet();

        initPayments();
        if (!eurRate) await fetchEurRate();

        const fundsTab = document.querySelector('a[href*="funds-history-tab"]');
        if (fundsTab) { fundsTab.click(); await sleep(800); }

        clickIncludePaid();
        await sleep(800);
        await setPerPage500();
        await sleep(1500);

        waitForRows(async () => {
            const statusEl = document.getElementById('da-status') || { textContent: '' };
            await expandAll(statusEl);
            const domDays = parseData();
            const mergedDays = mergeDays(domDays);
            persistDays(mergedDays);
            render(mergedDays);
        });
    }

    setTimeout(() => injectNavButton(), 2500);

})();
