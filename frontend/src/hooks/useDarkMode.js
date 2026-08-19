/**
 * Dark mode — persiste a preferência no localStorage; sem preferência
 * salva, usa prefers-color-scheme do sistema como default inicial (mas
 * a preferência salva sempre tem prioridade quando existe). Aplica/remove
 * a classe .dark no <html> — os tokens de tema já existem em index.css
 * (:root = claro, .dark = escuro) e o tailwind.config.js já está com
 * darkMode: ['class'], só faltava este mecanismo de troca.
 *
 * Chamado uma vez em App.jsx, antes de qualquer early-return de auth/
 * convite, pra funcionar em toda tela (inclusive Login) — não só onde
 * o controle de toggle é exibido (menu de configurações do Dashboard).
 */
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'exim_theme'

function getInitialTheme() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useDarkMode() {
  const [theme, setTheme] = useState(getInitialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))

  return { theme, isDark: theme === 'dark', toggleTheme }
}
