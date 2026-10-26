import type {
  CriarRegistro,
  FiltroRegistros,
  RegistroDTO,
  RegistroResumoDTO,
  RespostaPerguntaDTO,
  ResumoInicioDTO,
  StatusIntegracaoDTO,
  UsuarioDTO,
} from "@cerebro/core/publico";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./cliente";

export interface Pagina<T> {
  itens: T[];
  total: number;
  pagina: number;
  porPagina: number;
}
export interface Lacuna {
  id: string;
  pergunta: string;
  criadoEm: string;
  canal: string;
}
export interface TokenConector {
  id: string;
  nome: string;
  prefixo: string;
  ultimoUsoEm: string | null;
  criadoEm: string;
}
export interface UsuarioEquipe extends UsuarioDTO {
  ativo: boolean;
}
export interface MapaNotion {
  databaseId: string;
  propTitulo: string;
  propPrazo?: string | null;
  propResponsavel?: string | null;
  tipoResponsavel?: "rich_text" | "select";
  propStatus?: string | null;
  tipoStatus?: "status" | "select";
  valorStatusInicial?: string | null;
  propOrigem?: string | null;
}

const consulta = (filtro: Partial<FiltroRegistros>) =>
  new URLSearchParams(Object.entries(filtro).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();

export const chaves = {
  inicio: ["inicio"] as const,
  registros: (f: Partial<FiltroRegistros>) => ["registros", f] as const,
  registro: (id: string) => ["registro", id] as const,
  lacunas: ["lacunas"] as const,
  integracoes: ["integracoes"] as const,
  tokens: ["tokens"] as const,
  usuarios: ["usuarios"] as const,
};

export const useInicio = () => useQuery({ queryKey: chaves.inicio, queryFn: () => api<ResumoInicioDTO>("/inicio") });

export const useRegistros = (filtro: Partial<FiltroRegistros>) =>
  useQuery({
    queryKey: chaves.registros(filtro),
    queryFn: () => api<Pagina<RegistroResumoDTO>>(`/registros?${consulta(filtro)}`),
    placeholderData: (anterior) => anterior,
  });

export const useRegistro = (id: string | undefined) =>
  useQuery({
    queryKey: chaves.registro(id ?? ""),
    queryFn: () => api<RegistroDTO>(`/registros/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
  });

export const useLacunas = () => useQuery({ queryKey: chaves.lacunas, queryFn: () => api<Lacuna[]>("/lacunas") });
export const useIntegracoes = () =>
  useQuery({ queryKey: chaves.integracoes, queryFn: () => api<StatusIntegracaoDTO[]>("/integracoes") });
export const useTokens = () => useQuery({ queryKey: chaves.tokens, queryFn: () => api<TokenConector[]>("/conector/tokens") });
export const useUsuarios = () => useQuery({ queryKey: chaves.usuarios, queryFn: () => api<UsuarioEquipe[]>("/usuarios") });

export const usePerguntar = () =>
  useMutation({
    mutationFn: (pergunta: string) => api<RespostaPerguntaDTO>("/perguntar", { metodo: "POST", corpo: { pergunta } }),
  });

/** Depois de qualquer mudança num registro, atualiza o que depende dele. */
function useInvalidarRegistros() {
  const qc = useQueryClient();
  return (r?: RegistroDTO) => {
    if (r) {
      qc.setQueryData(chaves.registro(r.id), r);
      qc.setQueryData(chaves.registro(r.codigo), r);
    }
    void qc.invalidateQueries({ queryKey: ["registros"] });
    void qc.invalidateQueries({ queryKey: chaves.inicio });
    void qc.invalidateQueries({ queryKey: ["registro"] });
  };
}

export function useCriarRegistro() {
  const invalidar = useInvalidarRegistros();
  return useMutation({
    mutationFn: (entrada: Partial<CriarRegistro>) => api<RegistroDTO>("/registros", { metodo: "POST", corpo: entrada }),
    onSuccess: invalidar,
  });
}

export function useAtualizarRegistro(id: string) {
  const invalidar = useInvalidarRegistros();
  return useMutation({
    mutationFn: (entrada: Record<string, unknown>) =>
      api<RegistroDTO>(`/registros/${id}`, { metodo: "PATCH", corpo: entrada }),
    onSuccess: invalidar,
  });
}

type Acao = "aprovar" | "descartar" | "revisado" | "obsoleto";
export function useAcaoRegistro() {
  const invalidar = useInvalidarRegistros();
  return useMutation({
    mutationFn: ({ id, acao, corpo }: { id: string; acao: Acao; corpo?: unknown }) =>
      api<RegistroDTO>(`/registros/${id}/${acao}`, { metodo: "POST", corpo: corpo ?? {} }),
    onSuccess: invalidar,
  });
}

export function useResolverLacuna() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/lacunas/${id}/resolver`, { metodo: "POST", corpo: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: chaves.lacunas }),
  });
}
