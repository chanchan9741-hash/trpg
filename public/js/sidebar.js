(function () {
    var KEY = 'trpg-sidebar-collapsed';
    var mobile = function () { return window.matchMedia('(max-width: 768px)').matches; };

    try { if (localStorage.getItem(KEY) === '1') document.documentElement.classList.add('sidebar-collapsed'); } catch (e) {}

    window.toggleSidebar = function () {
        if (mobile()) { window.closeSidebar(); return; }
        var c = document.documentElement.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem(KEY, c ? '1' : '0'); } catch (e) {}
    };
    window.openSidebar = function () { document.documentElement.classList.add('sidebar-open'); };
    window.closeSidebar = function () { document.documentElement.classList.remove('sidebar-open'); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.closeSidebar(); });

    function syncThemeControls() {
        var dark = window.getTheme && window.getTheme() === 'dark';
        document.querySelectorAll('[data-theme-switch]').forEach(function (el) { el.checked = dark; });
        document.querySelectorAll('[data-theme-icon]').forEach(function (el) { el.className = 'bi ' + (dark ? 'bi-sun' : 'bi-moon-stars'); });
    }
    document.addEventListener('themechange', syncThemeControls);

    async function loadAccount() {
        var guest = document.getElementById('account-guest');
        var member = document.getElementById('account-member');
        if (!guest || !member) return;
        try {
            var res = await fetch('/api/user');
            var user = await res.json();
            if (user && user.username) {
                guest.hidden = true; member.hidden = false;
                document.getElementById('account-name').textContent = user.username;
                document.getElementById('account-avatar').textContent = user.username.trim().charAt(0).toUpperCase();
                document.querySelectorAll('[data-account-action]').forEach(function (b) {
                    b.title = '로그아웃'; b.onclick = function () { location.href = '/auth/logout'; };
                });
                return;
            }
        } catch (e) { }
        guest.hidden = false; member.hidden = true;
    }

    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('[data-theme-switch]').forEach(function (el) {
            el.addEventListener('change', function () { window.setTheme(el.checked ? 'dark' : 'light'); });
        });
        syncThemeControls();
        loadAccount();
        document.querySelectorAll('.sidebar a').forEach(function (a) { a.addEventListener('click', window.closeSidebar); });
    });
})();
