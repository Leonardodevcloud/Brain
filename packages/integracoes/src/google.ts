import { requisitarJson } from "./util.js";

/** Só leitura e criação de eventos; nada de Gmail ou Drive. */
export const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events.readonly";

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
}

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
    const dados = await requisitarJson<{
      items?: {
        id: string;
        summary?: string;
        status?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        hangoutLink?: string;
        htmlLink?: string;
        attendees?: { email?: string; displayName?: string }[];
      }[];
    }>("Google", `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda)}/events?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return (dados.items ?? [])
      .filter((e) => e.status !== "cancelled" && (e.start?.dateTime || e.start?.date))
      .map((e) => ({
        id: e.id,
        titulo: e.summary ?? "(sem título)",
        inicio: (e.start?.dateTime ?? e.start?.date)!,
        fim: e.end?.dateTime ?? e.end?.date ?? null,
        link: e.hangoutLink ?? e.htmlLink ?? null,
        participantes: (e.attendees ?? []).map((a) => a.displayName ?? a.email ?? "").filter(Boolean),
      }));
  }
}
