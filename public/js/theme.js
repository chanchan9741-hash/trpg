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
})();
