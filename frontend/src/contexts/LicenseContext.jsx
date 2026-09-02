/**
 * LicenseContext — estado da licença desta instalação.
 *
 * Buscado uma vez por sessão (o token vem do .env; só muda com restart do
 * backend) e recarregável sob demanda — `refresh()` depois de cadastrar ou
 * remover um servidor, para o contador "N de M" não ficar defasado.
 *
 * Só admin tem acesso a GET /api/license. Para viewer o contexto fica em
 * `null` e nada de licença aparece na tela — é assunto de quem administra
 * a instalação, não de quem só acompanha os incidentes.
 *
 * Quem decide se pode cadastrar servidor é o BACKEND
 * (app/license.py::block_reason). Aqui a UI apenas repete `can_add_server`
 * e `block_reason` — a interface nunca inventa uma regra própria, então o
 * que o botão desabilitado explica é literalmente o que a API responderia.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { fetchLicense } from '../api/client'
import { useAuth } from './AuthContext'

const LicenseContext = createContext(null)

export function LicenseProvider({ children }) {
  const { isAdmin } = useAuth()
  const [license, setLicense] = useState(null)

  const refresh = useCallback(async () => {
    if (!isAdmin) { setLicense(null); return }
    try {
      setLicense(await fetchLicense())
    } catch {
      // Falha aqui não pode atrapalhar o uso do painel: sem dado de
      // licença a UI simplesmente não mostra nada sobre licença.
      setLicense(null)
    }
  }, [isAdmin])

  useEffect(() => { refresh() }, [refresh])

  return (
    <LicenseContext.Provider value={{ license, refresh }}>
      {children}
    </LicenseContext.Provider>
  )
}

export function useLicense() {
  return useContext(LicenseContext) ?? { license: null, refresh: () => {} }
}
