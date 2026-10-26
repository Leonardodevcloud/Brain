import type { AgendaDTO, CaixaEmailDTO, EmailDTO } from "@cerebro/core/publico";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./cliente";
import { chavesTarefas } from "./tarefas";

export type FiltroEmail = "todos" | "pendentes" | "registro" | "ignorados";

export const chavesAgenda = {
  agenda: (de: string, dias: number) => ["agenda", de, dias] as const,
  todas: ["agenda"] as const,
  emails: (filtro: FiltroEmail) => ["emails", filtro] as const,
  todosEmails: ["emails"] as const,
  pendentes: ["emails", "pendentes-total"] as const,
};

export const useAgenda = (de: string, dias = 7) =>
  useQuery({
    queryKey: chavesAgenda.agenda(de, dias),
    queryFn: () => api<AgendaDTO>(`/agenda?de=${de}&dias=${dias}`),
    staleTime: 60_000,
    placeholderData: (anterior) => anterior,
  });

export function useCriarLembrete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dados: { titulo: string; quando: string; duracaoMin?: number }) =>
      api<{ id: string; titulo: string; inicio: string }>("/agenda/lembretes", { metodo: "POST", corpo: dados }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chavesAgenda.todas }),
  });
}

export const useEmails = (filtro: FiltroEmail) =>
  useQuery({
    queryKey: chavesAgenda.emails(filtro),
    queryFn: () => api<CaixaEmailDTO>(`/emails?filtro=${filtro}`),
    staleTime: 20_000,
    placeholderData: (anterior) => anterior,
  });

export const usePendentesEmail = () =>
  useQuery({
    queryKey: chavesAgenda.pendentes,
    queryFn: () => api<{ pendentes: number }>("/emails/pendentes"),
    staleTime: 30_000,
  });

export function useAcaoEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, acao, desfazer }: { id: string; acao: "ignorar" | "tarefa" | "registro"; desfazer?: boolean }) =>
      api<EmailDTO>(`/emails/${id}/${acao}`, { metodo: "POST", corpo: desfazer ? { desfazer: true } : {} }),
    onSuccess: (_e, v) => {
      void qc.invalidateQueries({ queryKey: chavesAgenda.todosEmails });
      if (v.acao === "tarefa") void qc.invalidateQueries({ queryKey: chavesTarefas.todas });
      if (v.acao === "registro") void qc.invalidateQueries({ queryKey: ["registros"] });
    },
  });
}
