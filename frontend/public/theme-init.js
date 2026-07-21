(function () {
  try {
    var stored = localStorage.getItem('tripl-ui-theme')
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    var theme =
      stored === 'light' ? 'light' :
      stored === 'dark' ? 'dark' :
      stored === 'system' ? (prefersDark ? 'dark' : 'light') :
      'dark'
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.background = theme === 'dark'
      ? 'oklch(0.14 0.01 250)'
      : 'oklch(0.99 0.002 250)'
  } catch (e) { /* ignore — default styles take over */ }
})()
