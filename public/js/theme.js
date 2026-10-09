(function () {
    var KEY = 'trpg-theme';
    function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
    function initial() {
        var s = saved();
        if (s === 'dark' || s === 'light') return s;
        return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function apply(t) {
        document.documentElement.setAttribute('data-theme', t);
        document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
    }
    window.getTheme = function () { return document.documentElement.getAttribute('data-theme') || 'light'; };
    window.setTheme = function (t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); };
    window.toggleTheme = function () { window.setTheme(window.getTheme() === 'dark' ? 'light' : 'dark'); };
    apply(initial());

    // 🚨 프론트엔드 오류를 서버 터미널로 실시간 전송
    var lastErrorMsg = '';
    var lastErrorTime = 0;
    function reportErrorToTerminal(data) {
        var now = Date.now();
        if (data.message === lastErrorMsg && (now - lastErrorTime) < 3000) return;
        lastErrorMsg = data.message;
        lastErrorTime = now;
        try {
            fetch('/api/report-error', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(function () {});
        } catch (_) {}
    }

    window.addEventListener('error', function (event) {
        reportErrorToTerminal({
            message: event.message || '알 수 없는 스크립트 오류',
            source: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error ? event.error.stack : null,
            page: window.location.pathname
        });
    });

    window.addEventListener('unhandledrejection', function (event) {
        var r = event.reason;
        reportErrorToTerminal({
            message: r && r.message ? r.message : String(r),
            stack: r && r.stack ? r.stack : null,
            page: window.location.pathname
        });
    });
})();
