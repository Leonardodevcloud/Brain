import type { DetalheTarefaDTO, RegistroDTO, ResumoTarefasDTO, TarefaDTO } from "@cerebro/core/publico";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./cliente";

export type FiltroTarefa = "minhas" | "todas" | "atrasadas" | "feitas";
export type StatusTarefa = TarefaDTO["status"];

const parametros = (p: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

export const chavesTarefas = {
  todas: ["tarefas"] as const,
  lista: (filtro: FiltroTarefa, texto: string, registroId?: string) => ["tarefas", "lista", filtro, texto, registroId ?? ""] as const,
  detalhe: (id: string) => ["tarefas", "detalhe", id] as const,
  resumo: ["tarefas", "resumo"] as const,
  reunioes: ["tarefas", "reunioes"] as const,
};

export const useTarefas = (filtro: FiltroTarefa, texto = "", registroId?: string) =>
  useQuery({
    queryKey: chavesTarefas.lista(filtro, texto, registroId),
    queryFn: () => api<TarefaDTO[]>(`/tarefas?${parametros({ filtro, texto, registroId })}`),
    staleTime: 10_000,
  });

export const useTarefa = (id: string | null) =>
  useQuery({
    queryKey: chavesTarefas.detalhe(id ?? ""),
    queryFn: () => api<DetalheTarefaDTO>(`/tarefas/${id}`),
    enabled: !!id,
  });

export const useResumoTarefas = () =>
  useQuery({ queryKey: chavesTarefas.resumo, queryFn: () => api<ResumoTarefasDTO>("/tarefas/resumo"), staleTime: 20_000 });

export const useReunioesParaLigar = (ativo: boolean) =>
  useQuery({
    queryKey: chavesTarefas.reunioes,
    queryFn: () => api<{ id: string; titulo: string; inicio: string; link: string | null }[]>("/tarefas/reunioes"),
    enabled: ativo,
    retry: false,
  });

function useInvalidar() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: chavesTarefas.todas });
    void qc.invalidateQueries({ queryKey: ["mapa"] });
    void qc.invalidateQueries({ queryKey: ["inicio"] });
  };
}

export interface NovaTarefa {
  titulo: string;
  descricao?: string;
  status?: StatusTarefa;
  responsavelId?: string | null;
  responsavelTexto?: string | null;
  prazo?: string | null;
  clienteRef?: string | null;
  registros?: string[];
  recorrencia?: "diaria" | "semanal" | "quinzenal" | "mensal" | null;
}

export function useCriarTarefa() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: (t: NovaTarefa) => api<DetalheTarefaDTO>("/tarefas", { metodo: "POST", corpo: t }),
    onSuccess: invalidar,
  });
}

export function useAtualizarTarefa() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: ({ id, ...m }: { id: string } & Partial<Omit<NovaTarefa, "registros">>) =>
      api<DetalheTarefaDTO>(`/tarefas/${id}`, { metodo: "PATCH", corpo: m }),
    onSuccess: invalidar,
  });
}

/** Arrastar no quadro. Atualiza a lista na hora (otimista) e confirma com o servidor. */
export function useMoverTarefa() {
  const qc = useQueryClient();
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: ({ id, status, antesDe }: { id: string; status: StatusTarefa; antesDe: string | null }) =>
      api<DetalheTarefaDTO>(`/tarefas/${id}/mover`, { metodo: "POST", corpo: { status, antesDe } }),
    onMutate: async ({ id, status, antesDe }) => {
      await qc.cancelQueries({ queryKey: chavesTarefas.todas });
      const anteriores = qc.getQueriesData<TarefaDTO[]>({ queryKey: ["tarefas", "lista"] });
      for (const [chave, lista] of anteriores) {
        if (!lista) continue;
        const item = lista.find((t) => t.id === id);
        if (!item) continue;
        const sem = lista.filter((t) => t.id !== id);
        const movido = { ...item, status, atrasada: status === "feita" ? false : item.atrasada };
        const i = antesDe ? sem.findIndex((t) => t.id === antesDe) : -1;
        if (i >= 0) sem.splice(i, 0, movido);
        else sem.push(movido);
        qc.setQueryData(chave, sem);
      }
      return { anteriores };
    },
    onError: (_e, _v, contexto) => {
      for (const [chave, lista] of contexto?.anteriores ?? []) qc.setQueryData(chave, lista);
    },
    onSettled: invalidar,
  });
}

export function useExcluirTarefa() {
  const invalidar = useInvalidar();
  return useMutation({ mutationFn: (id: string) => api(`/tarefas/${id}`, { metodo: "DELETE" }), onSuccess: invalidar });
}

export function useLigarRegistro() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: ({ id, registroId, ligar }: { id: string; registroId: string; ligar: boolean }) =>
      api<DetalheTarefaDTO>(`/tarefas/${id}/registros`, { metodo: "POST", corpo: { registroId, ligar } }),
    onSuccess: invalidar,
  });
}

export function useReuniaoTarefa() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: ({ id, eventoId }: { id: string; eventoId: string | null }) =>
      api<DetalheTarefaDTO>(`/tarefas/${id}/reuniao`, { metodo: "POST", corpo: { eventoId } }),
    onSuccess: invalidar,
  });
}

export function useLembreteTarefa() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: ({ id, quando }: { id: string; quando?: string | null }) =>
      api<DetalheTarefaDTO>(`/tarefas/${id}/lembrete`, { metodo: "POST", corpo: { quando: quando ?? null } }),
    onSuccess: invalidar,
  });
}

// ── Documentos e exclusão de registros ──

export function useEnviarDocumento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ arquivo, area, confidencialidade, titulo }: { arquivo: File; area: string; confidencialidade: string; titulo?: string }) =>
      api<RegistroDTO>(`/documentos?${parametros({ nome: arquivo.name, area, confidencialidade, titulo })}`, {
        metodo: "POST",
        arquivo: new Blob([arquivo], { type: "application/octet-stream" }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["registros"] });
      void qc.invalidateQueries({ queryKey: ["mapa"] });
      void qc.invalidateQueries({ queryKey: ["inicio"] });
    },
  });
}

export function useExcluirRegistro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmacao }: { id: string; confirmacao: string }) => api(`/registros/${id}`, { metodo: "DELETE", corpo: { confirmacao } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["registros"] });
      void qc.invalidateQueries({ queryKey: ["registro"] });
      void qc.invalidateQueries({ queryKey: ["mapa"] });
      void qc.invalidateQueries({ queryKey: ["inicio"] });
      void qc.invalidateQueries({ queryKey: chavesTarefas.todas });
    },
  });
}

/** Baixa o arquivo original (a API exige o token, então não dá para usar um link direto). */
export async function baixarOriginal(registroId: string, nome: string) {
  const blob = await api<Blob>(`/registros/${registroId}/arquivo`, { bruto: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
