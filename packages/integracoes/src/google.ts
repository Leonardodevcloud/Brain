import { requisitarJson } from "./util.js";

/**
 * Ler e criar/editar eventos da agenda (para as tarefas entrarem na pauta e virarem lembretes).
 * Nada de Gmail, Drive ou outras agendas além dos eventos.
 */
export const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";
/** Escopo antigo, só leitura: quem conectou com ele precisa reconectar para criar eventos. */
export const ESCOPO_AGENDA_LEITURA = "https://www.googleapis.com/auth/calendar.events.readonly";

export interface ConfigGoogle {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface EventoAgenda {
  id: string;
  titulo: string;
  inicio: string;
  fim: string | null;
  link: string | null;
  participantes: string[];
  descricao?: string;
  htmlLink?: string | null;
}

export interface NovoEvento {
  titulo: string;
  descricao: string;
  /** "AAAA-MM-DD" = dia inteiro; ISO com hora = horário marcado. */
  inicio: string;
  fim?: string;
  fuso?: string;
}

type EventoGoogle = {
  id: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  htmlLink?: string;
  attendees?: { email?: string; displayName?: string }[];
};

function paraEvento(e: EventoGoogle): EventoAgenda {
  return {
    id: e.id,
    titulo: e.summary ?? "(sem título)",
    inicio: (e.start?.dateTime ?? e.start?.date)!,
    fim: e.end?.dateTime ?? e.end?.date ?? null,
    link: e.hangoutLink ?? e.htmlLink ?? null,
    participantes: (e.attendees ?? []).map((a) => a.displayName ?? a.email ?? "").filter(Boolean),
    descricao: e.description ?? "",
    htmlLink: e.htmlLink ?? null,
  };
}

const diaSeguinte = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

export class ClienteGoogleAgenda {
  constructor(private readonly cfg: ConfigGoogle) {}

  /** Link para o usuário autorizar. `offline` + `consent` garantem o refresh token. */
  urlAutorizacao(estado: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: ESCOPO_AGENDA,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: estado,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async trocarCodigo(codigo: string): Promise<{ refreshToken: string; accessToken: string }> {
    const dados = await requisitarJson<{ access_token: string; refresh_token?: string }>(
      "Google",
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: codigo,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          redirect_uri: this.cfg.redirectUri,
          grant_type: "authorization_code",
        }),
      },
    );
    if (!dados.refresh_token) {
      throw new Error("O Google não devolveu o refresh token. Remova o acesso do app na conta Google e autorize de novo.");
    }
    return { refreshToken: dados.refresh_token, accessToken: dados.access_token };
  }

  async acessoPorRefresh(refreshToken: string): Promise<string> {
    const dados = await requisitarJson<{ access_token: string }>("Google", "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "refresh_token",
      }),
    });
    return dados.access_token;
  }

  async listarEventos(accessToken: string, de: Date, ate: Date, agenda = "primary"): Promise<EventoAgenda[]> {
    const params = new URLSearchParams({
      timeMin: de.toISOString(),
      timeMax: ate.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    const dados = await requisitarJson<{ items?: EventoGoogle[] }>(
      "Google",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda)}/events?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return (dados.items ?? []).filter((e) => e.status !== "cancelled" && (e.start?.dateTime || e.start?.date)).map(paraEvento);
  }

  async obterEvento(accessToken: string, id: string, agenda = "primary"): Promise<EventoAgenda> {
    const e = await requisitarJson<EventoGoogle>(
      "Google",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda)}/events/${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return paraEvento(e);
  }

  /** Cria um evento (lembrete da tarefa). Dia inteiro quando só há a data. */
  async criarEvento(accessToken: string, ev: NovoEvento, agenda = "primary"): Promise<EventoAgenda> {
    const diaInteiro = /^\d{4}-\d{2}-\d{2}$/.test(ev.inicio);
    const fuso = ev.fuso ?? "America/Bahia";
    const corpo = {
      summary: ev.titulo,
      description: ev.descricao,
      start: diaInteiro ? { date: ev.inicio } : { dateTime: ev.inicio, timeZone: fuso },
      end: diaInteiro
        ? { date: ev.fim ?? diaSeguinte(ev.inicio) }
        : { dateTime: ev.fim ?? new Date(new Date(ev.inicio).getTime() + 30 * 60_000).toISOString(), timeZone: fuso },
      reminders: { useDefault: true },
    };
    const e = await requisitarJson<EventoGoogle>(
      "Google",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda)}/events`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(corpo),
      },
    );
    return paraEvento(e);
  }

  /** Troca só a descrição (para escrever a pauta do Cérebro na reunião). */
  async atualizarDescricao(accessToken: string, id: string, descricao: string, agenda = "primary"): Promise<void> {
    await requisitarJson<EventoGoogle>(
      "Google",
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda)}/events/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ description: descricao }),
      },
    );
  }
}
