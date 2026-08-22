/**
 * Sessão 3, Tarefa 6 — "poda": log viewer, detector de PHP malicioso,
 * gráficos históricos elaborados, o badge de papel (admin/viewer) e os
 * atalhos de teclado fora da Triagem ficam atrás deste flag — nada foi
 * deletado, só deixou de ser o caminho principal. Desligado por
 * padrão: "uma demo com cinco painéis dilui; uma demo com um incidente
 * real detectado convence" (instrução explícita do usuário). Quem
 * precisa desses recursos no dia a dia liga em Configurações → Geral.
 *
 * Mesmo padrão de persistência do useDarkMode.js — localStorage, sem
 * depender de conta/servidor.
 */
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'exim_advanced_mode'

function getInitial() {
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export function useAdvancedMode() {
  const [advanced, setAdvanced] = useState(getInitial)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, advanced ? '1' : '0')
  }, [advanced])

  const toggleAdvanced = () => setAdvanced(v => !v)

  return { advanced, setAdvanced, toggleAdvanced }
}
