/**
 * Sessão 6 — o retema para "Tinta e Coral" (handoff Mail IQ 2.0) virou o
 * padrão, mas a paleta/casca anteriores (AVILI azul-céu) não foram
 * apagadas: ficam desligadas por padrão, religáveis em Configurações →
 * Geral, a critério de quem estiver usando — e disponíveis se o design
 * novo precisar ser revertido depois.
 *
 * Mesmo mecanismo do useDarkMode.js: aplica/remove a classe `.classic`
 * no <html>, que os tokens de tema em index.css já sabem interpretar
 * (`.classic` = paleta antiga clara, `.classic.dark` = paleta antiga
 * escura). AppShell.jsx lê o mesmo estado pra trocar a casca de
 * navegação (NAV antigo de 5 abas / duas linhas) junto com a cor.
 */
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'exim_classic_design'

function getInitial() {
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export function useClassicDesign() {
  const [classic, setClassic] = useState(getInitial)

  useEffect(() => {
    document.documentElement.classList.toggle('classic', classic)
    localStorage.setItem(STORAGE_KEY, classic ? '1' : '0')
  }, [classic])

  const toggleClassic = () => setClassic(v => !v)

  return { classic, setClassic, toggleClassic }
}
